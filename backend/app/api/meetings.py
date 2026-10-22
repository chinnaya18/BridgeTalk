"""Meeting endpoints: create, fetch, join, leave, end, history."""

import logging
import secrets
from uuid import uuid4
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.deps import CurrentUser, DbSession
from app.models.meeting import FocusEvent, FocusEventType, Meeting, MeetingParticipant
from app.models.transcript import Transcript, TranscriptSource
from app.models.user import User
from app.schemas.focus import (
    FocusEventCreate,
    FocusEventPublic,
    FocusSummary,
    InterviewModeUpdate,
    ParticipantViolations,
)
from app.ws.connection_manager import inference_manager, signaling_manager
from app.schemas.meeting import (
    MeetingCreate,
    MeetingDetail,
    MeetingJoinResponse,
    MeetingPublic,
    MeetingSummary,
)

logger = logging.getLogger("bridgetalk.api.meetings")

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# Ambiguous characters are excluded on purpose. Meeting codes get read aloud,
# written on a whiteboard, and typed by someone who is watching a video call
# rather than their keyboard. O/0, I/1 and L/1 are the pairs that cause failed
# joins, so none of them appear.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_GROUP_LENGTH = 3
CODE_GROUPS = 2  # e.g. "K7Q-2M4"
MAX_CODE_ATTEMPTS = 10


def generate_meeting_code(db: Session) -> str:
    """Generate a short, unique, human-typable meeting code.

    `secrets.choice` rather than `random.choice`: meeting codes are the only
    thing standing between a stranger and a private conversation, so they must
    not be predictable from previously issued codes.

    31 characters over 6 positions is ~887 million combinations, which is
    ample for a project of this size while staying short enough to read aloud.
    """
    for _ in range(MAX_CODE_ATTEMPTS):
        code = "-".join(
            "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_GROUP_LENGTH))
            for _ in range(CODE_GROUPS)
        )
        # The UNIQUE constraint on meetings.code is the real guarantee; this
        # check just avoids surfacing an integrity error for a collision we can
        # cheaply retry past.
        if db.scalar(select(Meeting).where(Meeting.code == code)) is None:
            return code

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Could not allocate a unique meeting code, please retry",
    )


def _participant_count(db: Session, meeting_id: int) -> int:
    """Distinct users who joined a meeting, including the host.

    COUNT(DISTINCT user_id), not a row count and not `len(participants)`.
    The attendance table is now unique per (meeting, user) so the two agree,
    but the explicit count states the intent and stays correct if the
    participant list is ever paginated or trimmed.

    The host is included when they joined — which they do, through the lobby,
    like everyone else. A host who created a meeting and never entered it is
    genuinely not a participant of it.
    """
    return int(
        db.scalar(
            select(func.count(func.distinct(MeetingParticipant.user_id))).where(
                MeetingParticipant.meeting_id == meeting_id
            )
        )
        or 0
    )


def _detail_with_count(db: Session, meeting: Meeting) -> MeetingDetail:
    """MeetingDetail with its participant_count filled in.

    One builder, used by every endpoint that returns a MeetingDetail, so no
    surface can forget the count and fall back to the default of 0.
    """
    return MeetingDetail.model_validate(meeting).model_copy(
        update={"participant_count": _participant_count(db, meeting.id)}
    )


# Leaving the meeting screen this many times ends a participant's interview.
# The FIRST departure is a warning; the second removes them.
INTERVIEW_MAX_DEPARTURES = 2

# Departures shorter than this are not counted. A notification stealing focus
# for a moment is not the same as leaving, and counting it would remove people
# for things they did not do.
INTERVIEW_MIN_DEPARTURE_MS = 400


def _system_line(db: Session, *, meeting_id: int, user_id: int, text_: str) -> None:
    """Write a `system` line into the meeting transcript.

    Interview Mode warnings and removals belong in the transcript so it is an
    account of what HAPPENED, not only of what was said. The text is composed
    here, on the server — a client could otherwise write whatever it liked into
    the permanent record of someone else's interview.

    A `segment_id` is generated so the row is covered by the same
    UNIQUE (meeting_id, segment_id) index as every other line, which keeps a
    retry idempotent.
    """
    row = Transcript(
        meeting_id=meeting_id,
        user_id=user_id,
        segment_id=f"sys-{uuid4().hex[:20]}",
        source=TranscriptSource.SYSTEM,
        content=text_,
        confidence=None,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def _count_departures(db: Session, meeting: Meeting, user_id: int) -> int:
    """How many times this participant has left the meeting screen.

    Counted on the SERVER from focus_events rather than trusted from the
    client: the number decides whether somebody is removed from an interview,
    and a browser must not be able to talk itself out of that.

    Only events after `interview_mode_started_at` count — tab switching before
    the mode was switched on was allowed. Only `blur` and `hidden` count; a
    `return` is the recovery, not another offence.
    """
    statement = select(func.count(FocusEvent.id)).where(
        FocusEvent.meeting_id == meeting.id,
        FocusEvent.user_id == user_id,
        FocusEvent.event_type.in_([FocusEventType.BLUR, FocusEventType.HIDDEN]),
    )
    if meeting.interview_mode_started_at is not None:
        statement = statement.where(
            FocusEvent.created_at >= meeting.interview_mode_started_at
        )
    return int(db.scalar(statement) or 0)


async def _announce_to_room(code: str, message: dict) -> int:
    """Push a room-wide state change to every connected participant.

    WHY THIS EXISTS
    ---------------
    Interview Mode did not work, and this was the cause. The state was written
    to the meeting record and returned to the HOST, and nothing told anyone
    else. The other participant's client had fetched the meeting once on mount
    and never read it again, so `is_interview_mode` stayed false on their
    screen: no dialog, no fullscreen, no enforcement. The feature worked only
    for the host — the one person it does not apply to.

    Both managers are notified because a participant may have one socket open
    and not the other: the inference socket is the meeting's text channel and
    is always connected, while the signalling socket can be absent if the call
    never established. Delivering to both means a state change does not depend
    on which sockets happen to be up.

    Returns the number of sockets that accepted it, which the caller logs
    rather than acts on — a state change that reached nobody is still correctly
    recorded on the meeting row, and any client that reconnects reads it from
    the `connected` handshake.
    """
    delivered = 0
    for manager in (inference_manager, signaling_manager):
        try:
            delivered += await manager.broadcast(code, message)
        except Exception:  # noqa: BLE001
            # A broadcast failure must never fail the request that caused it.
            # The database is the source of truth; this is only the fast path.
            logger.exception("Could not announce %s to room %s", message.get("type"), code)
    return delivered


def _load_meeting_by_code(db: Session, code: str) -> Meeting:
    """Fetch a meeting by code with host and participants eagerly loaded.

    `selectinload` issues one extra query for the whole collection instead of
    one per row. Without it, serialising a meeting with N participants costs
    N+1 queries — the classic ORM performance trap.
    """
    meeting = db.scalar(
        select(Meeting)
        .where(Meeting.code == code.strip().upper())
        .options(
            selectinload(Meeting.host),
            selectinload(Meeting.participants).selectinload(MeetingParticipant.user),
        )
    )

    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No meeting found with code '{code}'",
        )

    return meeting


def _assert_participant_or_host(meeting: Meeting, user: User) -> None:
    """Reject callers who have nothing to do with this meeting.

    Without this check, knowing a meeting id would be enough to read a private
    conversation's transcript. Membership, not merely being logged in, is the
    access boundary.
    """
    if meeting.host_id == user.id:
        return
    if any(participant.user_id == user.id for participant in meeting.participants):
        return

    # 403 rather than 404: the caller has proven they know a valid code, so
    # hiding the meeting's existence buys nothing and makes debugging harder.
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You are not a participant in this meeting",
    )


@router.post(
    "",
    response_model=MeetingPublic,
    status_code=status.HTTP_201_CREATED,
    summary="Create a meeting",
)
def create_meeting(payload: MeetingCreate, db: DbSession, current_user: CurrentUser) -> Meeting:
    """Create a meeting and return its join code.

    The creator becomes the host but is NOT auto-joined: creating a meeting for
    later and being in it now are different things, and `started_at` should
    reflect when people actually arrived.
    """
    meeting = Meeting(
        code=generate_meeting_code(db),
        title=payload.title.strip(),
        host_id=current_user.id,
        is_interview_mode=payload.is_interview_mode,
        # Stamped at creation when the mode is on from the start.
        #
        # Without this the flag was true while `interview_mode_started_at`
        # stayed NULL, and the violation rollup filters on that timestamp — so
        # a meeting created with the mode on filtered NOTHING and every focus
        # event ever recorded counted as a violation. Found by a test that was
        # asserting the opposite.
        interview_mode_started_at=(
            datetime.now(timezone.utc).replace(tzinfo=None)
            if payload.is_interview_mode
            else None
        ),
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)

    return meeting


@router.get(
    "/history",
    response_model=list[MeetingSummary],
    summary="Meetings you took part in",
)
def meeting_history(
    db: DbSession,
    current_user: CurrentUser,
    q: str | None = Query(
        default=None,
        max_length=200,
        description=(
            "Free-text search over meeting titles AND saved caption text. "
            "Omit to list everything."
        ),
    ),
) -> list[MeetingSummary]:
    """Every meeting the caller hosted or attended, newest first.

    Declared before the /{code} route on purpose: FastAPI matches routes in
    declaration order, so /{code} would otherwise swallow "history" and try to
    look up a meeting whose code is literally "history".

    QUERY COUNT IS THE WHOLE DESIGN OF THIS FUNCTION
    ------------------------------------------------
    The history page and the home page both draw participant avatars and a
    caption count for every row. Fetched naively that is 2N+1 queries for N
    meetings, and it gets worse as a user accumulates history — exactly the
    cost MeetingDetail's docstring warns about.

    This is four queries regardless of N:

      1. the meetings themselves
      2. `selectinload(Meeting.participants)` — one IN query for all of them
      3. `.selectinload(MeetingParticipant.user)` — one IN query for all users
      4. one grouped COUNT over transcripts
      5. one grouped COUNT(DISTINCT user_id) over participants

    The grouped count is the part that is easy to get wrong. One
    `len(meeting.transcripts)` per meeting would load every caption row of
    every meeting into memory just to count them, which for a day of demos is
    tens of thousands of rows to produce a handful of integers.
    """
    hosted = select(Meeting.id).where(Meeting.host_id == current_user.id)
    attended = select(MeetingParticipant.meeting_id).where(
        MeetingParticipant.user_id == current_user.id
    )

    statement = (
        select(Meeting)
        .where(Meeting.id.in_(hosted.union(attended)))
        .options(
            selectinload(Meeting.host),
            selectinload(Meeting.participants).selectinload(MeetingParticipant.user),
        )
        .order_by(Meeting.created_at.desc())
    )

    # The history page's search box covers titles AND what was said, because
    # "the meeting where we talked about the dataset" is how people actually
    # look for a transcript — they remember a phrase, not a title.
    #
    # Caption text is matched with a subquery rather than a JOIN. A join would
    # return one row per matching caption, so a meeting containing the word
    # twenty times would appear twenty times and would need a DISTINCT that
    # defeats the eager loading below.
    #
    # `ilike` rather than `like`: MySQL's default collation is already
    # case-insensitive, but SQLite's LIKE is case-sensitive for non-ASCII and
    # the documented zero-setup fallback is SQLite. SQLAlchemy compiles `ilike`
    # to LOWER(...) LIKE LOWER(...) where it has to, so the two backends agree.
    if q and q.strip():
        needle = f"%{q.strip()}%"
        said_it = select(Transcript.meeting_id).where(Transcript.content.ilike(needle))
        statement = statement.where(
            or_(Meeting.title.ilike(needle), Meeting.id.in_(said_it))
        )

    meetings = db.scalars(statement).all()

    if not meetings:
        return []

    meeting_ids = [meeting.id for meeting in meetings]

    counts = dict(
        db.execute(
            select(Transcript.meeting_id, func.count(Transcript.id))
            .where(Transcript.meeting_id.in_(meeting_ids))
            .group_by(Transcript.meeting_id)
        ).all()
    )

    # Distinct users per meeting, including the host, in ONE grouped query —
    # not one per meeting, and not `len(participants)`.
    #
    # `len(participants)` is what every surface used before, and it was a ROW
    # count: the attendance table was append-only, so somebody who reconnected
    # three times was reported as three participants. The rows are unique per
    # (meeting, user) now, so the two agree — but counting explicitly states
    # the intent and survives the participant list being trimmed.
    participant_counts = dict(
        db.execute(
            select(
                MeetingParticipant.meeting_id,
                func.count(func.distinct(MeetingParticipant.user_id)),
            )
            .where(MeetingParticipant.meeting_id.in_(meeting_ids))
            .group_by(MeetingParticipant.meeting_id)
        ).all()
    )

    return [
        # Validated from the ORM object, then copied with the counts layered on.
        # `model_validate` has no `update` argument in pydantic v2 — that is
        # `model_copy` — and setting `meeting.caption_count` instead would make
        # SQLAlchemy treat the instance as having a dirty column.
        MeetingSummary.model_validate(meeting).model_copy(
            update={
                "caption_count": counts.get(meeting.id, 0),
                "participant_count": participant_counts.get(meeting.id, 0),
            }
        )
        for meeting in meetings
    ]


@router.get("/{code}", response_model=MeetingDetail, summary="Meeting detail")
def get_meeting(code: str, db: DbSession, current_user: CurrentUser) -> Meeting:
    """Look up a meeting by code.

    Any authenticated user holding a valid code may read this, because they
    need to see the title before deciding to join. The transcript endpoints
    are the ones that enforce membership.
    """
    return _detail_with_count(db, _load_meeting_by_code(db, code))


@router.post("/{code}/join", response_model=MeetingJoinResponse, summary="Join a meeting")
def join_meeting(code: str, db: DbSession, current_user: CurrentUser) -> MeetingJoinResponse:
    """Join a meeting, recording attendance. ONE ROW PER (meeting, user).

    Rejoining UPDATES the existing row rather than inserting another. It used
    to insert, which made `meeting_participants` an append-only log — and the
    participant count shown on Home and History was `len(participants)`, a row
    count rather than a count of people. A participant who reconnected three
    times was reported as three participants.

    What the merged row keeps: the EARLIEST `joined_at`, because that is when
    the person actually arrived, and `left_at` cleared to NULL, because they
    are here now.

    What is lost, stated plainly: how many times somebody reconnected. Nothing
    ever displayed that, while the wrong count was displayed in four places.
    """
    meeting = _load_meeting_by_code(db, code)

    if meeting.ended_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This meeting has already ended",
        )

    now = datetime.now(timezone.utc)

    # "First participant" means the meeting clock had not started yet. The
    # frontend uses this to decide which peer creates the WebRTC offer; if both
    # peers offered simultaneously the negotiation would collide.
    is_first = meeting.started_at is None
    if is_first:
        meeting.started_at = now

    # Upsert. The UNIQUE constraint on (meeting_id, user_id) is the real
    # guarantee — this lookup just avoids provoking an IntegrityError for the
    # ordinary case of someone rejoining.
    existing = db.scalar(
        select(MeetingParticipant).where(
            MeetingParticipant.meeting_id == meeting.id,
            MeetingParticipant.user_id == current_user.id,
        )
    )

    # Removed from an interview, and removal is final. Checked HERE rather than
    # only in the client, because the client of somebody who has just been
    # removed is exactly the client least worth trusting — reloading the page
    # or re-pasting the link must not get them back in.
    if existing is not None and existing.removed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You were removed from this interview for leaving the meeting "
                "screen more than once. Only the host can readmit you."
            ),
        )

    if existing is None:
        db.add(
            MeetingParticipant(
                meeting_id=meeting.id, user_id=current_user.id, joined_at=now
            )
        )
    else:
        # They are back. Clear the departure; keep the original arrival time.
        existing.left_at = None

    try:
        db.commit()
    except IntegrityError:
        # Two simultaneous joins from the same user — two tabs, or a retry
        # after a dropped response. The constraint did its job; the row that
        # won is equally correct, so reuse it.
        db.rollback()
        existing = db.scalar(
            select(MeetingParticipant).where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.user_id == current_user.id,
            )
        )
        if existing is not None:
            existing.left_at = None
            db.commit()

    db.refresh(meeting)

    return MeetingJoinResponse(
        meeting=_detail_with_count(db, _load_meeting_by_code(db, code)),
        is_first_participant=is_first,
    )


@router.post("/{code}/leave", response_model=MeetingDetail, summary="Leave a meeting")
def leave_meeting(code: str, db: DbSession, current_user: CurrentUser) -> Meeting:
    """Stamp the caller's most recent attendance row with a leave time."""
    meeting = _load_meeting_by_code(db, code)

    open_row = db.scalar(
        select(MeetingParticipant)
        .where(
            MeetingParticipant.meeting_id == meeting.id,
            MeetingParticipant.user_id == current_user.id,
            MeetingParticipant.left_at.is_(None),
        )
        .order_by(MeetingParticipant.joined_at.desc())
    )

    if open_row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You are not currently in this meeting",
        )

    open_row.left_at = datetime.now(timezone.utc)
    db.commit()

    return _detail_with_count(db, _load_meeting_by_code(db, code))


@router.patch(
    "/{code}/interview-mode",
    response_model=MeetingDetail,
    summary="Switch Interview Mode on or off (host only)",
)
async def set_interview_mode(
    code: str, payload: InterviewModeUpdate, db: DbSession, current_user: CurrentUser
) -> Meeting:
    """Turn Interview Mode ON during a meeting. Host only, and one-way.

    WHY THE STATE LIVES ON THE MEETING RECORD
    -----------------------------------------
    Not in browser state and not only in a WebSocket broadcast. A participant
    who joins late, or reloads, or reconnects after a dropped socket must
    arrive already knowing the mode is on — otherwise refreshing the page would
    be a way to escape it, which makes the whole feature theatre.

    The broadcast tells everyone who is *currently* connected; this row is what
    tells everyone who connects *next*.

    Host only, for the same reason only the host can end a meeting: this
    changes what the other participants are subject to.

    IT IS ONE-WAY
    -------------
    Once on, it cannot be switched off; `enabled: false` is rejected with 409.
    An interview that can be un-invigilated mid-session is not an interview,
    and a candidate who saw the mode turn off would reasonably assume the
    recording had stopped. The only way out is the host ending the meeting,
    which is also the only thing that releases the participant's keyboard lock
    and fullscreen.
    """
    meeting = _load_meeting_by_code(db, code)

    if meeting.host_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the meeting host can change Interview Mode",
        )

    if meeting.ended_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This meeting has ended",
        )

    if not payload.enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Interview Mode cannot be switched off once it is on. "
                "End the meeting to finish the interview."
            ),
        )

    # Already on: do not re-stamp the start time, which would discard every
    # violation recorded so far. Backfill it only if it is somehow missing, so
    # a row predating the creation-time stamp above cannot leave the rollup
    # filtering on NULL.
    if meeting.is_interview_mode:
        if meeting.interview_mode_started_at is None:
            meeting.interview_mode_started_at = datetime.now(timezone.utc).replace(
                tzinfo=None
            )
            db.commit()
            db.refresh(meeting)
        return _detail_with_count(db, _load_meeting_by_code(db, code))

    meeting.is_interview_mode = True
    # Stamped on switch-on, so focus events recorded earlier in the meeting are
    # not counted as violations of a mode that was not yet active.
    meeting.interview_mode_started_at = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
    db.refresh(meeting)
    fresh = _detail_with_count(db, _load_meeting_by_code(db, code))

    # THE FIX FOR BUG 3. Without this the state reached only the host.
    delivered = await _announce_to_room(
        meeting.code,
        {
            "type": "interview-mode",
            "meeting_code": meeting.code,
            "is_interview_mode": True,
            "interview_mode_started_at": (
                fresh.interview_mode_started_at.isoformat()
                if fresh.interview_mode_started_at
                else None
            ),
            "host": {"id": current_user.id, "name": current_user.name},
        },
    )
    logger.info(
        "Interview Mode on for %s, announced to %d socket(s)", meeting.code, delivered
    )

    return fresh


@router.post(
    "/{code}/focus-events",
    response_model=FocusEventPublic,
    status_code=status.HTTP_201_CREATED,
    summary="Log an Interview Mode focus change",
)
async def log_focus_event(
    code: str, payload: FocusEventCreate, db: DbSession, current_user: CurrentUser
) -> FocusEventPublic:
    """Record that the caller's window lost or regained focus.

    Stored server-side rather than kept in browser state so the record
    survives a page reload — a tab switch the participant then refreshes away
    should still appear in the meeting record.

    What this can and cannot see is worth being precise about, because
    overstating it is the fastest way to lose credibility: the browser reports
    only that *this tab* lost focus or became hidden. It cannot detect a second
    monitor, a phone, notes on the desk, or another person in the room. This is
    a deterrent, not proctoring.
    """
    meeting = _load_meeting_by_code(db, code)
    _assert_participant_or_host(meeting, current_user)

    if not meeting.is_interview_mode:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Interview Mode is not enabled for this meeting",
        )

    event = FocusEvent(
        meeting_id=meeting.id,
        user_id=current_user.id,
        event_type=payload.event_type,
        # Only meaningful on a 'return'. The client owns this number because
        # only the client saw the departure; the server cannot time an absence
        # it was never told about.
        duration_away_ms=payload.duration_away_ms,
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    public = FocusEventPublic(
        id=event.id,
        meeting_id=event.meeting_id,
        user_id=event.user_id,
        user_name=current_user.name,
        event_type=event.event_type,
        duration_away_ms=event.duration_away_ms,
        created_at=event.created_at,
    )

    # --- the Interview Mode rule ------------------------------------------
    #
    # Decided HERE, on the server, from rows the server wrote. The number
    # decides whether somebody is removed from an interview, so a browser must
    # not be able to talk itself out of it — or into removing someone else.
    #
    # A `return` event is the recovery and is never an offence, so only
    # departures are judged.
    action = "none"
    departures = 0

    is_departure = payload.event_type in (FocusEventType.BLUR, FocusEventType.HIDDEN)
    too_brief = (
        payload.duration_away_ms is not None
        and payload.duration_away_ms < INTERVIEW_MIN_DEPARTURE_MS
    )

    if meeting.is_interview_mode and is_departure and current_user.id != meeting.host_id:
        departures = _count_departures(db, meeting, current_user.id)

        if departures >= INTERVIEW_MAX_DEPARTURES:
            action = "removed"
            # Mark them removed BEFORE announcing, so a rejoin racing the
            # broadcast is already refused.
            participant = db.scalar(
                select(MeetingParticipant).where(
                    MeetingParticipant.meeting_id == meeting.id,
                    MeetingParticipant.user_id == current_user.id,
                )
            )
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            if participant is not None:
                participant.removed_at = now
                participant.left_at = participant.left_at or now
                db.commit()

            _system_line(
                db,
                meeting_id=meeting.id,
                user_id=current_user.id,
                text_=(
                    f"{current_user.name} left the meeting screen "
                    f"{departures} times and was removed from the interview."
                ),
            )
            await _announce_to_room(
                meeting.code,
                {
                    "type": "participant-removed",
                    "meeting_code": meeting.code,
                    "user": {"id": current_user.id, "name": current_user.name},
                    "departures": departures,
                    "reason": "left the meeting screen more than once",
                },
            )
        else:
            action = "warned"
            _system_line(
                db,
                meeting_id=meeting.id,
                user_id=current_user.id,
                text_=(
                    f"{current_user.name} left the meeting screen. "
                    f"Warned: leaving again will remove them from the interview."
                ),
            )

    # Tell the HOST, in real time, and only the host.
    #
    # A violation is a record *about* a participant, so broadcasting it to the
    # room would show one candidate another candidate's lapses — which is
    # surveillance of each other rather than a tool for the person running the
    # interview, and it is exactly why GET /focus-events is host-only.
    #
    # The host's own focus changes are not reported: they are not policed, and
    # alerting them about their own tab switches would be noise.
    if current_user.id != meeting.host_id:
        for manager in (inference_manager, signaling_manager):
            try:
                await manager.send_to_user(
                    meeting.code,
                    meeting.host_id,
                    {
                        "type": "focus-event",
                        "meeting_code": meeting.code,
                        "event": public.model_dump(mode="json"),
                        # So the host's toast can say "warned" or "removed"
                        # rather than leaving them to count departures.
                        "action": action,
                        "departures": departures,
                    },
                )
            except Exception:  # noqa: BLE001
                # The row is already committed and the host can still read the
                # log; a failed notification must not fail the request.
                logger.exception("Could not notify host of a focus event")

    # The participant's own client acts on this: `warned` shows the warning
    # overlay with a way back, `removed` ends their meeting.
    return public.model_copy(update={"action": action, "departures": departures})


@router.get(
    "/{code}/focus-events",
    response_model=FocusSummary,
    summary="Focus events for a meeting (host only)",
)
def get_focus_events(code: str, db: DbSession, current_user: CurrentUser) -> FocusSummary:
    """Summarise focus events. Host only.

    Restricted to the host because this is a record *about* the participants:
    letting everyone read everyone else's attention log would be surveillance
    of each other rather than a tool for the person running the interview.
    """
    meeting = _load_meeting_by_code(db, code)

    if meeting.host_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the meeting host can read focus events",
        )

    rows = db.scalars(
        select(FocusEvent)
        .where(FocusEvent.meeting_id == meeting.id)
        .options(selectinload(FocusEvent.user))
        .order_by(FocusEvent.created_at.asc())
    ).all()

    events = [
        FocusEventPublic(
            id=row.id,
            meeting_id=row.meeting_id,
            user_id=row.user_id,
            user_name=row.user.name,
            event_type=row.event_type,
            # Issue K-3: this was omitted, so it defaulted to None and the
            # host's interview log showed an em dash for every duration even
            # though the database held the value — and the by_participant
            # rollup below read it correctly from the same rows.
            duration_away_ms=row.duration_away_ms,
            created_at=row.created_at,
        )
        for row in rows
    ]

    # --- per-participant rollup -------------------------------------------
    # Only events after the mode was switched on count. Without that filter a
    # focus change from earlier in the meeting — when tab switching was
    # perfectly allowed — would be reported as a violation.
    started = meeting.interview_mode_started_at
    per_user: dict[int, dict] = {}
    for row in rows:
        if started is not None and row.created_at < started:
            continue
        bucket = per_user.setdefault(
            row.user_id,
            {"user_name": row.user.name, "away_count": 0, "total": 0, "longest": 0},
        )
        if row.event_type.value in ("blur", "hidden"):
            bucket["away_count"] += 1
        if row.duration_away_ms:
            bucket["total"] += row.duration_away_ms
            bucket["longest"] = max(bucket["longest"], row.duration_away_ms)

    by_participant = [
        ParticipantViolations(
            user_id=user_id,
            user_name=data["user_name"],
            away_count=data["away_count"],
            total_away_ms=data["total"],
            longest_away_ms=data["longest"],
        )
        for user_id, data in sorted(
            per_user.items(), key=lambda kv: -kv[1]["away_count"]
        )
    ]

    return FocusSummary(
        meeting_id=meeting.id,
        total_events=len(events),
        # A `return` is the recovery, not another offence — counting all three
        # types would roughly double the apparent number of incidents.
        away_count=sum(
            1 for event in events if event.event_type != FocusEventType.RETURN
        ),
        events=events,
        by_participant=by_participant,
    )


@router.post("/{code}/end", response_model=MeetingDetail, summary="End a meeting (host only)")
async def end_meeting(code: str, db: DbSession, current_user: CurrentUser) -> Meeting:
    """Close a meeting for everyone. Host only.

    Restricted to the host because ending a meeting makes its code unusable —
    any participant being able to do that would be a griefing vector.
    """
    meeting = _load_meeting_by_code(db, code)

    if meeting.host_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the meeting host can end the meeting",
        )

    if meeting.ended_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This meeting has already ended",
        )

    now = datetime.now(timezone.utc)
    meeting.ended_at = now

    # Close every attendance row still open, so a participant who closed their
    # laptop instead of clicking Leave does not stay "in" the meeting forever.
    for participant in meeting.participants:
        if participant.left_at is None:
            participant.left_at = now

    db.commit()
    fresh = _detail_with_count(db, _load_meeting_by_code(db, code))

    # Announce the end to the room.
    #
    # For an ordinary meeting this is a courtesy — the other client would
    # discover it on its next request. For an INTERVIEW it is required: ending
    # the meeting is the only normal way out of interview mode, and the
    # participant's client has to be told so it can release the keyboard lock,
    # leave fullscreen, remove its listeners and move to the ended page. Without
    # this the candidate stays locked in a meeting that no longer exists.
    delivered = await _announce_to_room(
        meeting.code,
        {
            "type": "meeting-ended",
            "meeting_code": meeting.code,
            "ended_at": fresh.ended_at.isoformat() if fresh.ended_at else None,
            "ended_by": {"id": current_user.id, "name": current_user.name},
            "was_interview_mode": bool(fresh.is_interview_mode),
        },
    )
    logger.info("Meeting %s ended, announced to %d socket(s)", meeting.code, delivered)

    return fresh
