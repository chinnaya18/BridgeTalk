"""Pydantic schemas for meetings and participants."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.user import UserPublic


class MeetingCreate(BaseModel):
    """Request body for POST /api/meetings."""

    title: str = Field(
        min_length=1,
        max_length=200,
        examples=["Project review with Dr. Manavalan"],
    )
    is_interview_mode: bool = Field(
        default=False,
        description=(
            "Logs tab-switch and window-blur events for this meeting. A "
            "deterrent, not proctoring — it cannot detect a second device or "
            "another person in the room."
        ),
    )


class ParticipantPublic(BaseModel):
    """One participant's attendance record."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user: UserPublic
    joined_at: datetime
    left_at: Optional[datetime] = None


class MeetingPublic(BaseModel):
    """A meeting as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str
    host: UserPublic
    is_interview_mode: bool
    # When the mode was switched on, or null if it is off. The client needs
    # this to show participants who join late that the mode is already active,
    # and the host's violation view uses it to ignore focus events from before
    # the mode started.
    interview_mode_started_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    created_at: datetime

    # Computed rather than stored: a meeting is active until someone ends it,
    # so `ended_at is None` is the single source of truth and cannot fall out
    # of sync with a separate boolean column.
    is_active: bool


class MeetingDetail(MeetingPublic):
    """A meeting plus its attendance list.

    Separate from MeetingPublic so that listing history does not drag every
    participant row along with every meeting.
    """

    participants: list[ParticipantPublic] = []

    # The number of DISTINCT users who joined, including the host.
    #
    # Computed by the server with COUNT(DISTINCT user_id) rather than left to
    # each client to derive from `participants`. Every surface — Home's recent
    # cards, History rows, the transcript header and the meeting-ended page —
    # now reads this one field, so they cannot disagree.
    #
    # `len(participants)` was what they all used before, and it was a ROW count:
    # the attendance table was append-only, so somebody who reconnected three
    # times was reported as three participants. The rows are now unique per
    # (meeting, user), so this and `len(participants)` agree — but the explicit
    # count is kept because it states the intent and stays correct if the
    # participant list is ever paginated or trimmed.
    participant_count: int = Field(
        default=0,
        description=(
            "Distinct users who joined this meeting, including the host."
        ),
    )


class MeetingSummary(MeetingDetail):
    """A meeting as it appears in the history list and on the home page.

    Adds the two things the interface needs for a meeting row that the detail
    view does not: who took part (so their avatars can be shown) and how many
    captions were saved.

    WHY THIS CARRIES PARTICIPANTS, WHICH MeetingDetail's DOCSTRING WARNED OFF
    ------------------------------------------------------------------------
    MeetingDetail notes that listing history should not "drag every participant
    row along with every meeting". That concern was about the N+1 query a naive
    list would cause, and it is addressed rather than ignored: the history
    endpoint eager-loads participants with `selectinload`, which costs two
    extra queries for the whole page regardless of how many meetings it
    returns, and the caption counts come from one grouped COUNT rather than one
    per meeting. Four queries total, not 2N+1.

    The alternative was for the frontend to fetch each meeting individually to
    draw its avatars, which is the N+1 the warning was about, moved to the
    network where it costs more.
    """

    caption_count: int = Field(
        default=0,
        description="Number of saved caption rows, i.e. transcript entries.",
    )


class MeetingJoinResponse(BaseModel):
    """Response to POST /api/meetings/{code}/join."""

    meeting: MeetingDetail
    # True when this call is what started the meeting clock, i.e. the caller is
    # the first person in. The frontend uses it to decide who creates the
    # WebRTC offer, which is how we avoid both peers offering at once.
    is_first_participant: bool
