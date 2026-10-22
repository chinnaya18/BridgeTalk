"""Phase 7 — Interview Mode focus event tests.

Interview Mode is the feature most likely to be over-claimed in a review, so
the tests pin down exactly what it does: it records tab-focus transitions for
participants of a meeting that opted into it, readable only by the host.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select


@pytest.fixture()
def second_user(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Thamizhthilaga S D S",
            "email": "thamizh@example.com",
            "password": "another-password",
            "role": "hearing",
        },
    )
    assert response.status_code == 201
    return response.json()


@pytest.fixture()
def second_headers(second_user):
    return {"Authorization": f"Bearer {second_user['access_token']}"}


@pytest.fixture()
def interview_meeting(client, auth_headers):
    response = client.post(
        "/api/meetings",
        json={"title": "Technical interview", "is_interview_mode": True},
        headers=auth_headers,
    )
    assert response.status_code == 201
    return response.json()


@pytest.fixture()
def normal_meeting(client, auth_headers):
    response = client.post(
        "/api/meetings",
        json={"title": "Ordinary chat", "is_interview_mode": False},
        headers=auth_headers,
    )
    assert response.status_code == 201
    return response.json()


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("event_type", ["blur", "hidden", "return"])
def test_each_event_type_can_be_logged(client, auth_headers, interview_meeting, event_type):
    """These three are everything the browser will tell us — no more."""
    response = client.post(
        f"/api/meetings/{interview_meeting['code']}/focus-events",
        json={"event_type": event_type},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    assert response.json()["event_type"] == event_type


def test_invalid_event_type_is_rejected(client, auth_headers, interview_meeting):
    response = client.post(
        f"/api/meetings/{interview_meeting['code']}/focus-events",
        json={"event_type": "screenshotted-the-answers"},
        headers=auth_headers,
    )
    assert response.status_code == 422


def test_logging_requires_interview_mode(client, auth_headers, normal_meeting):
    """A meeting that did not opt in must not silently collect focus data.

    Accepting the write would mean attention logging could be switched on
    without the participants ever being told.
    """
    response = client.post(
        f"/api/meetings/{normal_meeting['code']}/focus-events",
        json={"event_type": "blur"},
        headers=auth_headers,
    )
    assert response.status_code == 409


def test_non_participants_cannot_log_events(client, second_headers, interview_meeting):
    response = client.post(
        f"/api/meetings/{interview_meeting['code']}/focus-events",
        json={"event_type": "blur"},
        headers=second_headers,
    )
    assert response.status_code == 403


def test_logging_requires_auth(client, interview_meeting):
    response = client.post(
        f"/api/meetings/{interview_meeting['code']}/focus-events",
        json={"event_type": "blur"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def test_host_can_read_the_summary(client, auth_headers, interview_meeting):
    code = interview_meeting["code"]
    for event_type in ["blur", "return", "hidden", "return"]:
        client.post(
            f"/api/meetings/{code}/focus-events",
            json={"event_type": event_type},
            headers=auth_headers,
        )

    response = client.get(f"/api/meetings/{code}/focus-events", headers=auth_headers)
    assert response.status_code == 200

    body = response.json()
    assert body["total_events"] == 4
    # A `return` is the recovery, not another offence. Counting all four would
    # report twice as many incidents as actually happened.
    assert body["away_count"] == 2
    assert len(body["events"]) == 4
    assert body["events"][0]["user_name"] == "Swarna Rathna A"


def test_events_are_returned_in_chronological_order(client, auth_headers, interview_meeting):
    code = interview_meeting["code"]
    for event_type in ["blur", "return", "hidden"]:
        client.post(
            f"/api/meetings/{code}/focus-events",
            json={"event_type": event_type},
            headers=auth_headers,
        )

    events = client.get(f"/api/meetings/{code}/focus-events", headers=auth_headers).json()["events"]
    assert [event["event_type"] for event in events] == ["blur", "return", "hidden"]


def test_participants_cannot_read_each_others_focus_events(
    client, auth_headers, second_headers, interview_meeting
):
    """Only the host may read this.

    It is a record *about* the participants; letting everyone read everyone
    else's attention log would be participants surveilling each other rather
    than a tool for whoever is running the interview.
    """
    code = interview_meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    response = client.get(f"/api/meetings/{code}/focus-events", headers=second_headers)
    assert response.status_code == 403


def test_summary_is_empty_for_a_meeting_with_no_events(client, auth_headers, interview_meeting):
    response = client.get(
        f"/api/meetings/{interview_meeting['code']}/focus-events", headers=auth_headers
    )
    assert response.status_code == 200

    body = response.json()
    assert body["total_events"] == 0
    assert body["away_count"] == 0
    assert body["events"] == []


def test_a_joined_participant_can_log_their_own_events(
    client, auth_headers, second_headers, interview_meeting
):
    code = interview_meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    response = client.post(
        f"/api/meetings/{code}/focus-events",
        json={"event_type": "hidden"},
        headers=second_headers,
    )
    assert response.status_code == 201
    assert response.json()["user_name"] == "Thamizhthilaga S D S"

    summary = client.get(f"/api/meetings/{code}/focus-events", headers=auth_headers).json()
    assert summary["events"][0]["user_name"] == "Thamizhthilaga S D S"


# --------------------------------------------------------------------------- #
# Interview Mode toggle (host only)
# --------------------------------------------------------------------------- #
#
# The mode can now be switched on DURING a meeting rather than only chosen at
# creation. Two things must hold: only the host can do it, and the state lives
# on the meeting row so a participant who reloads cannot escape it.


def test_host_can_switch_interview_mode_on(client, auth_headers):
    meeting = client.post(
        "/api/meetings", json={"title": "Toggle"}, headers=auth_headers
    ).json()
    assert meeting["is_interview_mode"] is False
    assert meeting["interview_mode_started_at"] is None

    on = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    )
    assert on.status_code == 200, on.text
    assert on.json()["is_interview_mode"] is True
    # The start time is what the violation rollup filters on, so switching the
    # mode on without stamping it would count every earlier event.
    assert on.json()["interview_mode_started_at"] is not None


def test_interview_mode_cannot_be_switched_off(client, auth_headers):
    """It is ONE-WAY. Only ending the meeting finishes an interview.

    An interview that can be un-invigilated mid-session is not an interview,
    and a candidate who saw the mode turn off would reasonably assume the
    recording had stopped.
    """
    meeting = client.post(
        "/api/meetings", json={"title": "One way"}, headers=auth_headers
    ).json()
    client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    )

    off = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": False},
        headers=auth_headers,
    )
    assert off.status_code == 409, off.text
    assert "cannot be switched off" in off.json()["detail"].lower()

    # And it really is still on.
    current = client.get(f"/api/meetings/{meeting['code']}", headers=auth_headers).json()
    assert current["is_interview_mode"] is True


def test_switching_interview_mode_on_twice_keeps_the_original_start_time(
    client, auth_headers
):
    """Re-stamping would discard every violation recorded so far."""
    meeting = client.post(
        "/api/meetings", json={"title": "Idempotent"}, headers=auth_headers
    ).json()

    first = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    ).json()
    second = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    ).json()

    assert first["interview_mode_started_at"] == second["interview_mode_started_at"]


def test_a_meeting_created_with_interview_mode_stamps_its_start_time(
    client, auth_headers
):
    """Otherwise the rollup filters on NULL and counts every event.

    The flag and the timestamp have to move together: `get_focus_events`
    discards events recorded before `interview_mode_started_at`, so a meeting
    with the flag set and the timestamp NULL filtered nothing at all.
    """
    meeting = client.post(
        "/api/meetings",
        json={"title": "On from the start", "is_interview_mode": True},
        headers=auth_headers,
    ).json()

    assert meeting["is_interview_mode"] is True
    assert meeting["interview_mode_started_at"] is not None


def test_a_participant_cannot_switch_interview_mode(client, auth_headers, second_user):
    """This changes what the OTHER participants are subject to.

    Same reasoning as only the host being able to end a meeting: a participant
    turning it on for everyone, or off for themselves, would make the feature
    meaningless.
    """
    meeting = client.post(
        "/api/meetings", json={"title": "Not yours"}, headers=auth_headers
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)

    guest = {"Authorization": f"Bearer {second_user['access_token']}"}
    client.post(f"/api/meetings/{meeting['code']}/join", headers=guest)

    response = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=guest,
    )
    assert response.status_code == 403


def test_switching_on_stamps_a_start_time(client, auth_headers):
    """Needed to tell a violation from an ordinary earlier tab switch.

    Focus events recorded before the mode was active are not offences, and
    without this timestamp there is no way to separate them.
    """
    meeting = client.post(
        "/api/meetings", json={"title": "Stamped"}, headers=auth_headers
    ).json()

    body = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    ).json()
    assert body.get("interview_mode_started_at"), "switch-on did not record when"

    cleared = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": False},
        headers=auth_headers,
    ).json()
    # Cleared on switch-off so a later switch-on starts a fresh window rather
    # than inheriting the first one.
    assert cleared.get("interview_mode_started_at") is None


def test_cannot_toggle_a_meeting_that_has_ended(client, auth_headers):
    meeting = client.post(
        "/api/meetings", json={"title": "Over"}, headers=auth_headers
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/end", headers=auth_headers)

    response = client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    )
    assert response.status_code == 409


# --------------------------------------------------------------------------- #
# Duration and the per-participant rollup
# --------------------------------------------------------------------------- #


def test_duration_away_is_stored_and_rolled_up(client, auth_headers):
    """A 300 ms notification steal and a two-minute absence are different.

    The host's log is only useful if it can tell them apart, which is why the
    duration is persisted rather than just the fact of the event.
    """
    meeting = client.post(
        "/api/meetings", json={"title": "Durations", "is_interview_mode": True},
        headers=auth_headers,
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    client.patch(
        f"/api/meetings/{meeting['code']}/interview-mode",
        json={"enabled": True}, headers=auth_headers,
    )

    client.post(f"/api/meetings/{meeting['code']}/focus-events",
                json={"event_type": "hidden"}, headers=auth_headers)
    client.post(f"/api/meetings/{meeting['code']}/focus-events",
                json={"event_type": "return", "duration_away_ms": 42_000},
                headers=auth_headers)
    client.post(f"/api/meetings/{meeting['code']}/focus-events",
                json={"event_type": "hidden"}, headers=auth_headers)
    client.post(f"/api/meetings/{meeting['code']}/focus-events",
                json={"event_type": "return", "duration_away_ms": 8_000},
                headers=auth_headers)

    summary = client.get(
        f"/api/meetings/{meeting['code']}/focus-events", headers=auth_headers
    ).json()

    assert summary["away_count"] == 2
    rollup = summary["by_participant"]
    assert len(rollup) == 1
    assert rollup[0]["away_count"] == 2
    assert rollup[0]["total_away_ms"] == 50_000
    assert rollup[0]["longest_away_ms"] == 42_000, "longest absence not tracked"


def test_rollup_ignores_events_from_before_the_mode_was_switched_on(
    client, auth_headers, db_session
):
    """Tab switching was allowed then, so it is not a violation now.

    WHY THIS TEST REACHES INTO THE DATABASE
    ---------------------------------------
    The invariant is that `get_focus_events` discards events recorded before
    `interview_mode_started_at`. Setting that situation up through the API alone
    is no longer possible, and both reasons are deliberate:

      * `log_focus_event` returns 409 when the mode is off, so no event can be
        recorded during a genuine "before" period;
      * the mode is one-way and never re-stamps its start time, so the start
        cannot be moved to after an existing event.

    Both of those are correct. So the start time is moved directly, which is
    what actually exercises the filter.
    """
    from app.models.meeting import Meeting

    meeting = client.post(
        "/api/meetings",
        json={"title": "Before and after", "is_interview_mode": True},
        headers=auth_headers,
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)

    logged = client.post(
        f"/api/meetings/{meeting['code']}/focus-events",
        json={"event_type": "hidden"},
        headers=auth_headers,
    )
    assert logged.status_code == 201, logged.text

    # It counts while the start time precedes it.
    before = client.get(
        f"/api/meetings/{meeting['code']}/focus-events", headers=auth_headers
    ).json()
    assert before["by_participant"][0]["away_count"] == 1

    # Move the start time to AFTER the event. It must drop out.
    row = db_session.scalar(select(Meeting).where(Meeting.code == meeting["code"]))
    row.interview_mode_started_at = datetime.now(timezone.utc).replace(
        tzinfo=None
    ) + timedelta(hours=1)
    db_session.commit()

    after = client.get(
        f"/api/meetings/{meeting['code']}/focus-events", headers=auth_headers
    ).json()
    assert after["by_participant"] == [], (
        "an event from before the mode started was counted as a violation"
    )


def test_each_event_in_the_log_carries_its_duration(client, auth_headers):
    """Issue K-3: duration_away_ms was dropped from every event.

    The value was stored and the by_participant rollup read it correctly, but
    the per-event list omitted it — so the host's interview log showed an em
    dash for every duration.
    """
    meeting = client.post(
        "/api/meetings",
        json={"title": "Durations", "is_interview_mode": True},
        headers=auth_headers,
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)

    client.post(
        f"/api/meetings/{meeting['code']}/focus-events",
        json={"event_type": "hidden"},
        headers=auth_headers,
    )
    client.post(
        f"/api/meetings/{meeting['code']}/focus-events",
        json={"event_type": "return", "duration_away_ms": 4200},
        headers=auth_headers,
    )

    summary = client.get(
        f"/api/meetings/{meeting['code']}/focus-events", headers=auth_headers
    ).json()

    by_type = {event["event_type"]: event for event in summary["events"]}
    # The 'return' row is the one that carries the number.
    assert by_type["return"]["duration_away_ms"] == 4200, (
        "the per-event list dropped the duration the database holds"
    )
    # 'hidden' genuinely has none: the duration is only known on return.
    assert by_type["hidden"]["duration_away_ms"] is None
    # And the rollup still agrees, as it always did.
    assert summary["by_participant"][0]["total_away_ms"] == 4200


# ---------------------------------------------------------------------------
# Bug 3 — leaving the meeting screen: warn once, then remove
# ---------------------------------------------------------------------------


def _interview_meeting(client, auth_headers, second_headers):
    """A meeting with interview mode on and both people in it."""
    meeting = client.post(
        "/api/meetings", json={"title": "Interview"}, headers=auth_headers
    ).json()
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)
    client.patch(
        f"/api/meetings/{code}/interview-mode",
        json={"enabled": True},
        headers=auth_headers,
    )
    return meeting


def _depart(client, code, headers):
    return client.post(
        f"/api/meetings/{code}/focus-events",
        json={"event_type": "blur"},
        headers=headers,
    )


def test_first_departure_warns_rather_than_removing(
    client, auth_headers, second_headers
):
    meeting = _interview_meeting(client, auth_headers, second_headers)
    first = _depart(client, meeting["code"], second_headers)

    assert first.status_code == 201, first.text
    assert first.json()["action"] == "warned"
    assert first.json()["departures"] == 1

    # And they are still in the meeting.
    rejoin = client.post(
        f"/api/meetings/{meeting['code']}/join", headers=second_headers
    )
    assert rejoin.status_code == 200


def test_second_departure_removes_them(client, auth_headers, second_headers):
    meeting = _interview_meeting(client, auth_headers, second_headers)
    _depart(client, meeting["code"], second_headers)
    second = _depart(client, meeting["code"], second_headers)

    assert second.status_code == 201, second.text
    assert second.json()["action"] == "removed"
    assert second.json()["departures"] == 2


def test_a_removed_participant_cannot_rejoin(client, auth_headers, second_headers):
    """Removal is final. Reloading the page must not get them back in."""
    meeting = _interview_meeting(client, auth_headers, second_headers)
    _depart(client, meeting["code"], second_headers)
    _depart(client, meeting["code"], second_headers)

    rejoin = client.post(
        f"/api/meetings/{meeting['code']}/join", headers=second_headers
    )
    assert rejoin.status_code == 403, rejoin.text
    assert "removed" in rejoin.json()["detail"].lower()

    # Still refused on a later attempt — it is not a one-off.
    again = client.post(
        f"/api/meetings/{meeting['code']}/join", headers=second_headers
    )
    assert again.status_code == 403


def test_the_host_is_never_removed_by_their_own_rule(
    client, auth_headers, second_headers
):
    """The host runs the interview; they are not policed by it."""
    meeting = _interview_meeting(client, auth_headers, second_headers)
    for _ in range(4):
        response = _depart(client, meeting["code"], auth_headers)
        assert response.json()["action"] == "none", response.text

    rejoin = client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    assert rejoin.status_code == 200


def test_departures_outside_interview_mode_do_nothing(
    client, auth_headers, second_headers
):
    meeting = client.post(
        "/api/meetings", json={"title": "Ordinary"}, headers=auth_headers
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=second_headers)

    # focus-events are refused entirely when the mode is off.
    response = _depart(client, meeting["code"], second_headers)
    assert response.status_code == 409


def test_a_return_event_is_never_an_offence(client, auth_headers, second_headers):
    """Coming back is the recovery, not another departure."""
    meeting = _interview_meeting(client, auth_headers, second_headers)
    _depart(client, meeting["code"], second_headers)

    came_back = client.post(
        f"/api/meetings/{meeting['code']}/focus-events",
        json={"event_type": "return", "duration_away_ms": 3000},
        headers=second_headers,
    )
    assert came_back.json()["action"] == "none"

    # Still in the meeting after returning.
    assert client.post(
        f"/api/meetings/{meeting['code']}/join", headers=second_headers
    ).status_code == 200


def test_both_the_warning_and_the_removal_are_written_to_the_transcript(
    client, auth_headers, second_headers
):
    """The transcript must account for what HAPPENED, not only what was said."""
    meeting = _interview_meeting(client, auth_headers, second_headers)
    _depart(client, meeting["code"], second_headers)
    _depart(client, meeting["code"], second_headers)

    lines = client.get(f"/api/transcripts/{meeting['id']}", headers=auth_headers).json()
    system = [line for line in lines if line["source"] == "system"]

    assert len(system) == 2, [line["content"] for line in system]
    assert "warned" in system[0]["content"].lower()
    assert "removed" in system[1]["content"].lower()
    # Attributed to the participant they concern, not to the host.
    assert all(line["user_name"] == "Thamizhthilaga S D S" for line in system)


def test_system_lines_are_attributed_and_have_a_segment_id(
    client, auth_headers, second_headers
):
    """So they are covered by the same idempotency index as every other line."""
    meeting = _interview_meeting(client, auth_headers, second_headers)
    _depart(client, meeting["code"], second_headers)

    lines = client.get(f"/api/transcripts/{meeting['id']}", headers=auth_headers).json()
    system = [line for line in lines if line["source"] == "system"]
    assert system
    assert system[0]["segment_id"], "a system line must carry a segment_id"
    assert system[0]["confidence"] is None
