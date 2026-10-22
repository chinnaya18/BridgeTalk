"""The `meetings`, `meeting_participants` and `focus_events` tables."""

import enum
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    UniqueConstraint,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:  # pragma: no cover - import only for type checkers
    from app.models.transcript import Transcript
    from app.models.user import User


class FocusEventType(str, enum.Enum):
    """What the browser reported during Interview Mode.

    - `BLUR`   — the window lost keyboard focus (user clicked another app)
    - `HIDDEN` — the tab became invisible (user switched tabs or minimised)
    - `RETURN` — focus/visibility came back

    Being precise about what these mean matters, because Interview Mode is a
    deterrent and not proctoring: these three events are genuinely all the
    browser will tell us. It cannot see a second monitor, a phone, or another
    person in the room.
    """

    BLUR = "blur"
    HIDDEN = "hidden"
    RETURN = "return"


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # A short, human-typable join code (e.g. "K7Q-2M4"). Indexed and unique
    # because every join hits the database by code, never by id.
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True, nullable=False)

    title: Mapped[str] = mapped_column(String(200), nullable=False)

    host_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    is_interview_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # When the mode was switched on. Interview mode can be toggled DURING a
    # meeting, so a focus event from before it started is not a violation —
    # without this timestamp there is no way to tell the two apart.
    interview_mode_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # `started_at` is set when the first participant joins, not at creation —
    # a meeting created on Monday for Friday should not report a Monday start.
    # `ended_at` stays NULL while the meeting is live, which is exactly the
    # filter the history endpoint uses to separate active from past meetings.
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )

    # --- Relationships ----------------------------------------------------
    host: Mapped["User"] = relationship(back_populates="hosted_meetings")
    participants: Mapped[list["MeetingParticipant"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    transcripts: Mapped[list["Transcript"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    focus_events: Mapped[list["FocusEvent"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )

    @property
    def is_active(self) -> bool:
        """A meeting is active until someone ends it."""
        return self.ended_at is None

    def __repr__(self) -> str:  # pragma: no cover - debugging convenience
        return f"<Meeting id={self.id} code={self.code!r} active={self.is_active}>"


class MeetingParticipant(Base):
    """Who was in a meeting, and when. ONE ROW PER (meeting, user).

    This used to be an append-only log: rejoining after a dropped connection
    wrote a new row rather than mutating the old one. The intent was to keep
    the history of disconnections, but nothing ever displayed that history —
    while the participant count on Home and History was `len(participants)`, a
    ROW count rather than a count of people. On the development database that
    meant 207 rows for 72 distinct (meeting, user) pairs, including a meeting
    reporting seventeen participants for a single user.

    So it is now a set, enforced by a UNIQUE constraint. `joined_at` keeps the
    person's EARLIEST arrival and `left_at` is NULL while they are present.
    `database/migrations/003_unique_participant.sql` merges existing rows.

    The trade, stated plainly: how many times somebody reconnected is no longer
    recorded.
    """

    __tablename__ = "meeting_participants"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    meeting_id: Mapped[int] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )
    left_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Set when Interview Mode removes somebody for leaving the meeting screen
    # twice. Distinct from `left_at`, which only means "not here now": a
    # removed participant may NOT rejoin, and `join_meeting` refuses them.
    removed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    meeting: Mapped["Meeting"] = relationship(back_populates="participants")
    user: Mapped["User"] = relationship(back_populates="participations")

    # "Is this user currently in this meeting?" is asked on every join request,
    # and it filters on both columns at once — hence the composite index.
    #
    # The UNIQUE constraint is what actually prevents duplicates. The join
    # endpoint upserts, but an application-level check alone loses a race
    # between two simultaneous joins from the same user — two tabs, or a retry
    # after a dropped response.
    __table_args__ = (
        Index("ix_participant_meeting_user", "meeting_id", "user_id"),
        UniqueConstraint("meeting_id", "user_id", name="uq_participant_meeting_user"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging convenience
        return f"<MeetingParticipant meeting={self.meeting_id} user={self.user_id}>"


class FocusEvent(Base):
    """One Interview Mode focus change, logged against the meeting.

    Stored server-side rather than kept in browser state so that the record
    survives a page reload — a tab switch the user then refreshes away should
    still appear in the meeting record.
    """

    __tablename__ = "focus_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    meeting_id: Mapped[int] = mapped_column(
        ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[FocusEventType] = mapped_column(
        Enum(
            FocusEventType,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    # How long the participant was away, in milliseconds. Recorded on the
    # 'return' row, because that is the first moment the duration is known.
    # A 300 ms notification stealing focus and a two-minute absence are not the
    # same event, and a log that cannot tell them apart is not worth keeping.
    duration_away_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )

    meeting: Mapped["Meeting"] = relationship(back_populates="focus_events")
    user: Mapped["User"] = relationship(back_populates="focus_events")

    def __repr__(self) -> str:  # pragma: no cover - debugging convenience
        return f"<FocusEvent meeting={self.meeting_id} type={self.event_type.value}>"
