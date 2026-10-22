"""Pydantic schemas for Interview Mode focus events."""

from datetime import datetime

from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.models.meeting import FocusEventType


class InterviewModeUpdate(BaseModel):
    """Host-only request to switch interview mode on or off mid-meeting."""

    enabled: bool


class FocusEventCreate(BaseModel):
    """Request body for POST /api/meetings/{code}/focus-events."""

    event_type: FocusEventType
    # Sent by the client on a 'return' event: how long the participant
    # was away. The client owns this because only it saw the departure.
    duration_away_ms: Optional[int] = None


class FocusEventPublic(BaseModel):
    """One logged focus change."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    meeting_id: int
    user_id: int
    user_name: str
    event_type: FocusEventType
    duration_away_ms: Optional[int] = None
    created_at: datetime

    # What the server decided about this event, under the Interview Mode rule.
    # "none" outside an interview, "warned" on a first departure, "removed" on
    # the one that ends it. The client acts on this rather than counting for
    # itself — the count decides a removal, so it is the server's to make.
    action: str = "none"
    departures: int = 0


class ParticipantViolations(BaseModel):
    """One participant's violation record, which is what the host acts on.

    The removal prompt is driven per person, so an aggregate count across the
    whole meeting is not enough — two participants with one lapse each is a
    different situation from one participant with four.
    """

    user_id: int
    user_name: str
    away_count: int
    total_away_ms: int
    longest_away_ms: int


class FocusSummary(BaseModel):
    """Aggregate view for the host.

    `away_count` counts only the events that represent leaving — a `return`
    event is the recovery, not another offence, so counting all three types
    would roughly double the apparent number of incidents.
    """

    meeting_id: int
    total_events: int
    away_count: int
    events: list[FocusEventPublic]
    # Per participant, so the host can see who to act on.
    by_participant: list[ParticipantViolations] = []
