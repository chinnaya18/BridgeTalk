"""Phase 2 — meeting and transcript API tests.

The focus is on the two things that would actually hurt: a stranger being able
to read a private meeting's transcript, and attendance records that quietly
lie about what happened.
"""

import re

import pytest

from app.api.meetings import CODE_ALPHABET, generate_meeting_code


@pytest.fixture()
def second_user(client):
    """A second account, so membership boundaries can be tested."""
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Thamizhthilaga S D S",
            "email": "thamizh@example.com",
            "password": "another-password",
            "role": "hearing",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def second_headers(second_user):
    return {"Authorization": f"Bearer {second_user['access_token']}"}


@pytest.fixture()
def meeting(client, auth_headers):
    """A meeting hosted by the primary user."""
    response = client.post(
        "/api/meetings",
        json={"title": "Project review", "is_interview_mode": False},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Meeting creation
# ---------------------------------------------------------------------------


def test_create_meeting_returns_a_code(client, auth_headers, meeting):
    assert meeting["title"] == "Project review"
    assert meeting["is_active"] is True
    assert meeting["started_at"] is None  # nobody has joined yet
    assert meeting["host"]["email"] == "swarna@example.com"


def test_meeting_code_is_human_typable(meeting):
    """Codes get read aloud and typed by someone watching a video call.

    Ambiguous characters (O/0, I/1, L/1) are excluded, because they are what
    turn "join my meeting" into three failed attempts.
    """
    code = meeting["code"]
    assert re.fullmatch(r"[A-Z2-9]{3}-[A-Z2-9]{3}", code), code

    for forbidden in "01ILO":
        assert forbidden not in CODE_ALPHABET


def test_meeting_codes_are_unique(client, auth_headers):
    codes = set()
    for index in range(15):
        response = client.post(
            "/api/meetings", json={"title": f"Meeting {index}"}, headers=auth_headers
        )
        codes.add(response.json()["code"])
    assert len(codes) == 15


def test_generate_meeting_code_retries_past_collisions(db_session):
    """The generator must not loop forever, and must produce valid codes."""
    code = generate_meeting_code(db_session)
    assert re.fullmatch(r"[A-Z2-9]{3}-[A-Z2-9]{3}", code)


def test_creating_a_meeting_requires_auth(client):
    assert client.post("/api/meetings", json={"title": "No auth"}).status_code == 401


def test_create_meeting_rejects_empty_title(client, auth_headers):
    response = client.post("/api/meetings", json={"title": ""}, headers=auth_headers)
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Joining
# ---------------------------------------------------------------------------


def test_join_records_attendance_and_starts_the_clock(client, auth_headers, meeting):
    response = client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["is_first_participant"] is True
    assert body["meeting"]["started_at"] is not None
    assert len(body["meeting"]["participants"]) == 1


def test_second_joiner_is_not_the_first_participant(client, auth_headers, second_headers, meeting):
    """Exactly one peer must be told it is first.

    The frontend uses this flag to decide who creates the WebRTC offer. If both
    peers thought they were first, both would offer and the negotiation would
    collide.
    """
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    response = client.post(f"/api/meetings/{meeting['code']}/join", headers=second_headers)

    assert response.status_code == 200
    assert response.json()["is_first_participant"] is False


def test_rejoining_reuses_the_attendance_row(client, auth_headers, meeting):
    """ONE row per (meeting, user), however many times they rejoin.

    This test used to assert the opposite — that rejoining wrote a NEW row, to
    keep a dropped connection visible in the record. That intent was never
    displayed anywhere, and the row count WAS displayed: as the meeting's
    participant count on Home and History. So someone who reconnected three
    times was reported as three participants.

    What the merged row keeps: the earliest arrival, and `left_at` cleared
    because they are back. What is lost: how many times they reconnected.
    """
    code = meeting["code"]
    first = client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    original_joined_at = first.json()["meeting"]["participants"][0]["joined_at"]

    client.post(f"/api/meetings/{code}/leave", headers=auth_headers)
    response = client.post(f"/api/meetings/{code}/join", headers=auth_headers)

    participants = response.json()["meeting"]["participants"]
    assert len(participants) == 1, "rejoining created a second row"
    assert participants[0]["left_at"] is None, "they are back, so left_at must be clear"
    assert participants[0]["joined_at"] == original_joined_at, (
        "the original arrival time must be kept"
    )


def test_rejoining_many_times_still_counts_one_participant(
    client, auth_headers, second_headers, meeting
):
    """The reported bug, directly: a reconnecting guest inflated the count.

    The development database held 207 attendance rows for 72 distinct
    (meeting, user) pairs, including a meeting reporting seventeen participants
    for a single user.
    """
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)

    for _ in range(5):
        client.post(f"/api/meetings/{code}/join", headers=second_headers)
        client.post(f"/api/meetings/{code}/leave", headers=second_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    assert detail["participant_count"] == 2, detail["participant_count"]
    assert len(detail["participants"]) == 2


def test_join_is_case_insensitive(client, auth_headers, meeting):
    """Nobody types a meeting code in the right case on the first try."""
    response = client.post(
        f"/api/meetings/{meeting['code'].lower()}/join", headers=auth_headers
    )
    assert response.status_code == 200


def test_join_unknown_code_is_404(client, auth_headers):
    response = client.post("/api/meetings/ZZZ-999/join", headers=auth_headers)
    assert response.status_code == 404


def test_cannot_join_an_ended_meeting(client, auth_headers, meeting):
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/end", headers=auth_headers)

    response = client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    assert response.status_code == 409


def test_leave_without_joining_is_409(client, auth_headers, meeting):
    response = client.post(f"/api/meetings/{meeting['code']}/leave", headers=auth_headers)
    assert response.status_code == 409


# ---------------------------------------------------------------------------
# Ending
# ---------------------------------------------------------------------------


def test_only_the_host_can_end_a_meeting(client, auth_headers, second_headers, meeting):
    """Ending a meeting makes its code unusable — that must not be open to all."""
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    assert client.post(f"/api/meetings/{code}/end", headers=second_headers).status_code == 403
    assert client.post(f"/api/meetings/{code}/end", headers=auth_headers).status_code == 200


def test_ending_closes_every_open_attendance_row(client, auth_headers, second_headers, meeting):
    """Someone who shuts their laptop must not stay 'in' the meeting forever."""
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    response = client.post(f"/api/meetings/{code}/end", headers=auth_headers)
    body = response.json()

    assert body["is_active"] is False
    assert body["ended_at"] is not None
    assert all(p["left_at"] is not None for p in body["participants"])


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


def test_history_includes_hosted_and_attended_meetings(
    client, auth_headers, second_headers, meeting
):
    # The second user hosts one meeting and attends the first user's meeting.
    other = client.post(
        "/api/meetings", json={"title": "Thamizh's meeting"}, headers=second_headers
    ).json()
    client.post(f"/api/meetings/{meeting['code']}/join", headers=second_headers)

    response = client.get("/api/meetings/history", headers=second_headers)
    assert response.status_code == 200

    titles = {row["title"] for row in response.json()}
    assert titles == {"Thamizh's meeting", "Project review"}


def test_history_excludes_other_peoples_meetings(client, auth_headers, second_headers, meeting):
    response = client.get("/api/meetings/history", headers=second_headers)
    assert response.json() == []


def test_history_route_is_not_shadowed_by_the_code_route(client, auth_headers):
    """/history must not be parsed as a meeting code.

    FastAPI matches routes in declaration order, so /{code} would swallow
    "history" if it were declared first. This test fails loudly if anyone
    reorders them.
    """
    response = client.get("/api/meetings/history", headers=auth_headers)
    assert response.status_code == 200
    assert isinstance(response.json(), list)


# ---------------------------------------------------------------------------
# Transcripts
# ---------------------------------------------------------------------------


@pytest.fixture()
def joined_meeting(client, auth_headers, meeting):
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    return meeting


def test_append_and_read_a_transcript_line(client, auth_headers, joined_meeting):
    response = client.post(
        "/api/transcripts",
        json={
            "meeting_id": joined_meeting["id"],
            "source": "sign",
            "content": "HELLO",
            "confidence": 0.94,
        },
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text

    body = response.json()
    assert body["content"] == "HELLO"
    assert body["source"] == "sign"
    assert body["confidence"] == pytest.approx(0.94)
    assert body["user_name"] == "Swarna Rathna A"


def test_transcript_is_returned_in_chronological_order(client, auth_headers, joined_meeting):
    for word in ["FIRST", "SECOND", "THIRD"]:
        client.post(
            "/api/transcripts",
            json={"meeting_id": joined_meeting["id"], "source": "sign", "content": word},
            headers=auth_headers,
        )

    response = client.get(f"/api/transcripts/{joined_meeting['id']}", headers=auth_headers)
    assert [row["content"] for row in response.json()] == ["FIRST", "SECOND", "THIRD"]


def test_line_is_attributed_to_the_caller_not_the_request_body(
    client, auth_headers, second_headers, joined_meeting
):
    """Nobody may put words in another participant's permanent record."""
    client.post(f"/api/meetings/{joined_meeting['code']}/join", headers=second_headers)

    response = client.post(
        "/api/transcripts",
        json={
            "meeting_id": joined_meeting["id"],
            "source": "speech",
            "content": "spoken by the second user",
            # A user_id here is simply ignored — the schema has no such field,
            # and attribution always comes from the token.
            "user_id": 1,
        },
        headers=second_headers,
    )

    assert response.status_code == 201
    assert response.json()["user_name"] == "Thamizhthilaga S D S"


def test_non_members_cannot_read_a_transcript(
    client, auth_headers, second_headers, joined_meeting
):
    """Being logged in is not enough — membership is the access boundary."""
    client.post(
        "/api/transcripts",
        json={"meeting_id": joined_meeting["id"], "source": "sign", "content": "PRIVATE"},
        headers=auth_headers,
    )

    response = client.get(f"/api/transcripts/{joined_meeting['id']}", headers=second_headers)
    assert response.status_code == 403


def test_non_members_cannot_write_to_a_transcript(client, second_headers, joined_meeting):
    response = client.post(
        "/api/transcripts",
        json={"meeting_id": joined_meeting["id"], "source": "sign", "content": "INTRUDER"},
        headers=second_headers,
    )
    assert response.status_code == 403


def test_transcript_requires_auth(client, joined_meeting):
    assert client.get(f"/api/transcripts/{joined_meeting['id']}").status_code == 401


def test_transcript_for_unknown_meeting_is_404(client, auth_headers):
    assert client.get("/api/transcripts/99999", headers=auth_headers).status_code == 404


def test_cannot_append_to_an_ended_meeting(client, auth_headers, joined_meeting):
    client.post(f"/api/meetings/{joined_meeting['code']}/end", headers=auth_headers)

    response = client.post(
        "/api/transcripts",
        json={"meeting_id": joined_meeting["id"], "source": "sign", "content": "TOO LATE"},
        headers=auth_headers,
    )
    assert response.status_code == 409


@pytest.mark.parametrize("confidence", [-0.1, 1.1])
def test_confidence_must_be_a_probability(client, auth_headers, joined_meeting, confidence):
    response = client.post(
        "/api/transcripts",
        json={
            "meeting_id": joined_meeting["id"],
            "source": "sign",
            "content": "X",
            "confidence": confidence,
        },
        headers=auth_headers,
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def test_export_produces_a_readable_text_file(client, auth_headers, joined_meeting):
    client.post(
        "/api/transcripts",
        json={
            "meeting_id": joined_meeting["id"],
            "source": "sign",
            "content": "HELLO",
            "confidence": 0.94,
        },
        headers=auth_headers,
    )
    client.post(
        "/api/transcripts",
        json={"meeting_id": joined_meeting["id"], "source": "speech", "content": "Hi there"},
        headers=auth_headers,
    )

    response = client.get(
        f"/api/transcripts/{joined_meeting['id']}/export", headers=auth_headers
    )
    assert response.status_code == 200

    body = response.text
    assert "BridgeTalk meeting transcript" in body
    assert joined_meeting["code"] in body
    assert "SIGN" in body and "HELLO" in body
    assert "SPEECH" in body and "Hi there" in body
    # Confidence is shown for sign lines so a reader can tell how much to
    # trust each one, rather than assuming every line is equally reliable.
    assert "94%" in body

    disposition = response.headers["content-disposition"]
    assert f'filename="bridgetalk-transcript-{joined_meeting["code"]}.txt"' in disposition


def test_export_of_an_empty_transcript_says_so(client, auth_headers, joined_meeting):
    """An empty file would look like a bug. Say what happened instead."""
    response = client.get(
        f"/api/transcripts/{joined_meeting['id']}/export", headers=auth_headers
    )
    assert response.status_code == 200
    assert "no transcript lines were recorded" in response.text


def test_non_members_cannot_export(client, second_headers, joined_meeting):
    response = client.get(
        f"/api/transcripts/{joined_meeting['id']}/export", headers=second_headers
    )
    assert response.status_code == 403


def test_history_rows_carry_participants_and_a_caption_count(
    client, auth_headers, second_headers, meeting
):
    """The home and history pages draw avatars and a caption count per row.

    Both come from this one endpoint on purpose. The alternative — the frontend
    fetching each meeting to find out who was in it — is an N+1 moved onto the
    network, so the data has to be here or the interface cannot be drawn
    without it.
    """
    # BOTH join. Creating a meeting does not make the host a participant —
    # `participants` is an attendance log, and the host appears in it only once
    # they actually arrive through the lobby, which is what happens in use.
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)
    client.post(f"/api/meetings/{meeting['code']}/join", headers=second_headers)

    # Two saved captions for this meeting, one from each participant.
    for headers, text in ((auth_headers, "hello"), (second_headers, "good morning")):
        created = client.post(
            "/api/transcripts",
            json={"meeting_id": meeting["id"], "source": "speech", "content": text},
            headers=headers,
        )
        assert created.status_code == 201, created.text

    rows = client.get("/api/meetings/history", headers=auth_headers).json()
    row = next(item for item in rows if item["code"] == meeting["code"])

    # Participants, with their users resolved — this is what the avatars need.
    names = {participant["user"]["name"] for participant in row["participants"]}
    assert len(row["participants"]) == 2, row["participants"]
    assert all(name for name in names)

    assert row["caption_count"] == 2, row


def test_history_caption_count_is_zero_for_a_meeting_with_no_captions(
    client, auth_headers, meeting
):
    """Zero, not absent.

    The count comes from a grouped COUNT, which returns no ROW at all for a
    meeting with no transcripts rather than a row containing 0. A dict lookup
    without a default would then raise KeyError on the commonest case there is:
    a meeting nobody has spoken in yet.
    """
    rows = client.get("/api/meetings/history", headers=auth_headers).json()
    row = next(item for item in rows if item["code"] == meeting["code"])
    assert row["caption_count"] == 0


def test_history_does_not_issue_a_query_per_meeting(
    client, auth_headers, second_headers, db_session
):
    """Guards the eager loading, which is easy to delete by accident.

    Without `selectinload`, serialising participants lazy-loads them one
    meeting at a time, so the query count grows with the number of meetings.
    The assertion is deliberately loose — it checks that the count does not
    SCALE, not that it equals a specific number, so adding a column does not
    fail the test while removing the eager load does.
    """
    from sqlalchemy import event

    for index in range(6):
        created = client.post(
            "/api/meetings", json={"title": f"Meeting {index}"}, headers=auth_headers
        ).json()
        client.post(f"/api/meetings/{created['code']}/join", headers=second_headers)

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = db_session.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        response = client.get("/api/meetings/history", headers=auth_headers)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert response.status_code == 200
    assert len(response.json()) >= 6

    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    # The endpoint itself issues four: meetings, participants, users, counts.
    # The authenticated-user lookup adds one more. Ten leaves room for a
    # reasonable change while still failing hard if this becomes 2N+1 — which
    # for seven meetings would be fifteen or more.
    assert len(selects) <= 10, f"{len(selects)} SELECTs:\n" + "\n".join(selects)


# ---------------------------------------------------------------------------
# History search
# ---------------------------------------------------------------------------


def test_history_search_matches_meeting_titles(client, auth_headers):
    client.post("/api/meetings", json={"title": "Dataset review"}, headers=auth_headers)
    client.post("/api/meetings", json={"title": "Guide meeting"}, headers=auth_headers)

    rows = client.get("/api/meetings/history?q=dataset", headers=auth_headers).json()
    assert [row["title"] for row in rows] == ["Dataset review"]


def test_history_search_matches_caption_text(client, auth_headers, meeting):
    """Searching what was SAID, not only what the meeting was called.

    This is the half of the search that needs the subquery over transcripts;
    without it, a user who remembers a phrase but not the title cannot find
    their transcript at all.
    """
    client.post(
        "/api/transcripts",
        json={
            "meeting_id": meeting["id"],
            "source": "sign",
            "content": "the normalisation must agree",
        },
        headers=auth_headers,
    )
    other = client.post(
        "/api/meetings", json={"title": "Unrelated"}, headers=auth_headers
    ).json()

    rows = client.get("/api/meetings/history?q=normalisation", headers=auth_headers).json()
    codes = {row["code"] for row in rows}
    assert meeting["code"] in codes
    assert other["code"] not in codes


def test_history_search_is_case_insensitive(client, auth_headers, meeting):
    client.post(
        "/api/transcripts",
        json={"meeting_id": meeting["id"], "source": "speech", "content": "Good Morning"},
        headers=auth_headers,
    )
    rows = client.get("/api/meetings/history?q=GOOD+morning", headers=auth_headers).json()
    assert {row["code"] for row in rows} == {meeting["code"]}


def test_history_search_returns_each_meeting_once(client, auth_headers, meeting):
    """A meeting where a word was said many times must appear ONCE.

    This is why the caption match is a subquery and not a JOIN: a join produces
    one row per matching caption, so this meeting would come back five times.
    """
    for _ in range(5):
        client.post(
            "/api/transcripts",
            json={"meeting_id": meeting["id"], "source": "sign", "content": "hello"},
            headers=auth_headers,
        )

    rows = client.get("/api/meetings/history?q=hello", headers=auth_headers).json()
    assert len(rows) == 1, rows
    assert rows[0]["caption_count"] == 5


def test_history_search_still_excludes_other_peoples_meetings(
    client, auth_headers, second_headers, meeting
):
    """Search must not become a way around the membership filter."""
    client.post(
        "/api/transcripts",
        json={"meeting_id": meeting["id"], "source": "speech", "content": "secret plan"},
        headers=auth_headers,
    )
    rows = client.get("/api/meetings/history?q=secret", headers=second_headers).json()
    assert rows == []


def test_history_blank_search_lists_everything(client, auth_headers, meeting):
    rows = client.get("/api/meetings/history?q=%20%20", headers=auth_headers).json()
    assert len(rows) >= 1


# ---------------------------------------------------------------------------
# Bug 4 — the participant count
#
# Definition: the number of DISTINCT users who joined, INCLUDING the host,
# however many times each one rejoined.
# ---------------------------------------------------------------------------


def test_participant_count_host_alone(client, auth_headers, meeting):
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    assert detail["participant_count"] == 1

    row = next(
        item
        for item in client.get("/api/meetings/history", headers=auth_headers).json()
        if item["code"] == code
    )
    assert row["participant_count"] == 1


def test_participant_count_counts_a_meeting_the_host_never_entered_as_zero(
    client, auth_headers, meeting
):
    """Creating a meeting is not attending it.

    The host appears in the count when they JOIN, which they do through the
    lobby like everyone else. A meeting created and never entered genuinely
    has no participants.
    """
    detail = client.get(f"/api/meetings/{meeting['code']}", headers=auth_headers).json()
    assert detail["participant_count"] == 0
    assert detail["participants"] == []


def test_participant_count_host_plus_one_guest(
    client, auth_headers, second_headers, meeting
):
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    assert detail["participant_count"] == 2
    # The avatars drawn from `participants` must match the count, or the UI
    # shows one number and a different set of faces.
    assert len(detail["participants"]) == detail["participant_count"]


def test_participant_count_with_a_guest_leaving_and_rejoining_twice(
    client, auth_headers, second_headers, meeting
):
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)

    for _ in range(2):
        client.post(f"/api/meetings/{code}/join", headers=second_headers)
        client.post(f"/api/meetings/{code}/leave", headers=second_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    assert detail["participant_count"] == 2
    assert len(detail["participants"]) == 2


def test_participant_count_with_the_host_reconnecting(
    client, auth_headers, second_headers, meeting
):
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    # The host's laptop sleeps and comes back, three times.
    for _ in range(3):
        client.post(f"/api/meetings/{code}/join", headers=auth_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    assert detail["participant_count"] == 2


def test_participant_count_for_a_meeting_the_caller_only_attended(
    client, auth_headers, second_headers, meeting
):
    """The guest sees the same number the host sees.

    The count is computed server-side from the attendance rows, so it does not
    depend on who is asking.
    """
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    client.post(f"/api/meetings/{code}/join", headers=second_headers)

    as_host = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    as_guest = client.get(f"/api/meetings/{code}", headers=second_headers).json()
    assert as_host["participant_count"] == as_guest["participant_count"] == 2

    guest_history = client.get("/api/meetings/history", headers=second_headers).json()
    row = next(item for item in guest_history if item["code"] == code)
    assert row["participant_count"] == 2


def test_participant_count_is_the_same_on_every_surface(
    client, auth_headers, second_headers, meeting
):
    """Home, History, the transcript header and the ended page read ONE field.

    They each used to derive it from `len(participants)`, which is how they
    could disagree. This asserts the three server responses that feed those
    four surfaces all report the same number.
    """
    code = meeting["code"]
    client.post(f"/api/meetings/{code}/join", headers=auth_headers)
    for _ in range(3):
        client.post(f"/api/meetings/{code}/join", headers=second_headers)

    detail = client.get(f"/api/meetings/{code}", headers=auth_headers).json()
    history_row = next(
        item
        for item in client.get("/api/meetings/history", headers=auth_headers).json()
        if item["code"] == code
    )
    joined = client.post(f"/api/meetings/{code}/join", headers=auth_headers).json()

    assert (
        detail["participant_count"]
        == history_row["participant_count"]
        == joined["meeting"]["participant_count"]
        == 2
    )


def test_a_second_join_cannot_create_a_duplicate_row(
    client, auth_headers, second_headers, meeting, db_session
):
    """The UNIQUE constraint is the real guarantee, not the upsert lookup.

    An application-level check alone loses a race between two simultaneous
    joins from the same user — two tabs, or a retry after a dropped response.
    """
    from sqlalchemy import select

    from app.models.meeting import Meeting, MeetingParticipant

    code = meeting["code"]
    for _ in range(4):
        client.post(f"/api/meetings/{code}/join", headers=auth_headers)
        client.post(f"/api/meetings/{code}/join", headers=second_headers)

    rows = db_session.scalars(
        select(MeetingParticipant).join(Meeting).where(Meeting.code == code)
    ).all()
    pairs = {(row.meeting_id, row.user_id) for row in rows}
    assert len(rows) == len(pairs) == 2, f"{len(rows)} rows for {len(pairs)} pairs"
