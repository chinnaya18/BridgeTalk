"""Phase 5-6 — WebSocket endpoint tests.

These run through Starlette's TestClient, which speaks the real WebSocket
protocol against the real routes. No model is loaded (the app lifespan does not
run under TestClient), so these cover the parts that must work *regardless* of
the model: authentication, message validation, relay behaviour, and the
should-initiate rule that stops both peers offering at once.

The prediction path itself is covered by test_smoothing.py, which exercises the
algorithm directly, and by the end-to-end check documented in REVIEW_DEMO.md.
"""

import pytest
from starlette.websockets import WebSocketDisconnect

from app.core.security import create_access_token

WS_POLICY_VIOLATION = 1008


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
def meeting(client, auth_headers):
    response = client.post(
        "/api/meetings", json={"title": "WS test"}, headers=auth_headers
    )
    assert response.status_code == 201
    return response.json()


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("endpoint", ["predict", "signal"])
def test_socket_rejects_a_garbage_token(client, endpoint):
    """A bad token must be closed with 1008, not left open.

    1008 specifically, rather than failing the handshake: the browser reports a
    failed handshake as a generic 1006 that is indistinguishable from the
    server being down, and the client then retries a dead token twelve times.
    """
    with client.websocket_connect(f"/ws/{endpoint}/DEMO?token=not-a-jwt") as socket:
        message = socket.receive_json()
        assert message["type"] == "error"
        assert message["code"] == "UNAUTHORIZED"

        with pytest.raises(WebSocketDisconnect) as excinfo:
            socket.receive_json()
        assert excinfo.value.code == WS_POLICY_VIOLATION


@pytest.mark.parametrize("endpoint", ["predict", "signal"])
def test_socket_requires_a_token_at_all(client, endpoint):
    """The token is a required query parameter, so its absence is a 403."""
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/{endpoint}/DEMO"):
            pass


def test_socket_rejects_a_token_for_a_deleted_user(client, registered_user, db_session):
    """Signature validity is not enough — the user must still exist."""
    from sqlalchemy import select

    from app.models.user import User

    token = registered_user["access_token"]
    user = db_session.scalar(select(User).where(User.email == "swarna@example.com"))
    db_session.delete(user)
    db_session.commit()

    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        assert socket.receive_json()["code"] == "UNAUTHORIZED"


def test_expired_token_is_rejected(client, registered_user):
    from datetime import timedelta

    expired = create_access_token(
        subject=registered_user["user"]["id"], expires_delta=timedelta(seconds=-60)
    )
    with client.websocket_connect(f"/ws/predict/DEMO?token={expired}") as socket:
        assert socket.receive_json()["code"] == "UNAUTHORIZED"


def test_predict_socket_rejects_an_unknown_meeting(client, registered_user):
    """A valid token for a meeting that does not exist is still refused."""
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/predict/ZZZ-999?token={token}") as socket:
        message = socket.receive_json()
        assert message["code"] == "MEETING_NOT_FOUND"


# ---------------------------------------------------------------------------
# Inference socket
# ---------------------------------------------------------------------------


def test_predict_socket_announces_model_and_config(client, registered_user):
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        hello = socket.receive_json()

        assert hello["type"] == "connected"
        assert hello["meeting_code"] == "DEMO"
        # The client needs the thresholds to explain its own behaviour in the UI.
        assert hello["config"]["majority_min"] <= hello["config"]["majority_window"]
        assert "loaded" in hello["model"]


def test_predict_socket_rejects_unknown_message_types(client, registered_user):
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        socket.receive_json()  # connected
        # No model is loaded here, so an error frame may follow.
        socket.send_json({"type": "definitely-not-a-real-type"})

        for _ in range(3):
            message = socket.receive_json()
            if message.get("code") == "INVALID_MESSAGE":
                return
        pytest.fail("Unknown message type was not rejected")


def test_empty_hands_produce_the_neutral_state_without_a_model(client, registered_user):
    """No hand means no landmarks, so the model is never consulted.

    This is why 'nothing' is not a trained class — see dataset_manifest.json.
    It also means the neutral state works even with no model loaded at all.
    """
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        socket.receive_json()  # connected
        socket.send_json({"type": "landmarks", "mode": "static", "timestamp": 0, "hands": []})

        for _ in range(3):
            message = socket.receive_json()
            if message.get("type") == "prediction":
                assert message["label"] == "nothing"
                assert message["hand_detected"] is False
                assert "latency_ms" in message
                return
        pytest.fail("No prediction frame received for empty hands")


def test_ping_is_answered(client, registered_user):
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        socket.receive_json()
        socket.send_json({"type": "ping"})

        for _ in range(3):
            if socket.receive_json().get("type") == "pong":
                return
        pytest.fail("ping was not answered")


# ---------------------------------------------------------------------------
# Signalling socket
# ---------------------------------------------------------------------------


def test_first_peer_does_not_initiate(client, registered_user, meeting):
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/signal/{meeting['code']}?token={token}") as socket:
        joined = socket.receive_json()

        assert joined["type"] == "joined"
        assert joined["peers"] == []
        # Nobody to call yet.
        assert joined["should_initiate"] is False


def test_second_peer_initiates_and_first_is_notified(
    client, registered_user, second_user, meeting
):
    """Exactly one side must create the offer.

    If both peers offered at once the negotiations would collide ("glare") and
    both would have to back off and retry. The rule is that whoever arrives
    second starts the call, because they are the one who knows somebody is
    already waiting.
    """
    first_token = registered_user["access_token"]
    second_token = second_user["access_token"]
    code = meeting["code"]

    with client.websocket_connect(f"/ws/signal/{code}?token={first_token}") as first:
        assert first.receive_json()["should_initiate"] is False

        with client.websocket_connect(f"/ws/signal/{code}?token={second_token}") as second:
            joined = second.receive_json()
            assert joined["should_initiate"] is True
            assert len(joined["peers"]) == 1

            notice = first.receive_json()
            assert notice["type"] == "peer-joined"
            assert notice["peer"]["name"] == "Thamizhthilaga S D S"


def test_offer_answer_and_ice_are_relayed_verbatim(
    client, registered_user, second_user, meeting
):
    """The server does not parse SDP or ICE — it only stamps the sender.

    Not parsing them is deliberate: it means a WebRTC specification change
    needs no backend change at all.
    """
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/signal/{code}?token={registered_user['access_token']}"
    ) as first:
        first.receive_json()

        with client.websocket_connect(
            f"/ws/signal/{code}?token={second_user['access_token']}"
        ) as second:
            second.receive_json()
            first.receive_json()  # peer-joined

            second.send_json({"type": "offer", "payload": {"sdp": "OFFER_SDP", "type": "offer"}})
            offer = first.receive_json()
            assert offer["type"] == "offer"
            assert offer["payload"]["sdp"] == "OFFER_SDP"
            assert offer["from"]["name"] == "Thamizhthilaga S D S"

            first.send_json({"type": "answer", "payload": {"sdp": "ANSWER_SDP", "type": "answer"}})
            answer = second.receive_json()
            assert answer["payload"]["sdp"] == "ANSWER_SDP"

            first.send_json({"type": "ice-candidate", "payload": {"candidate": "candidate:1 udp"}})
            candidate = second.receive_json()
            assert candidate["type"] == "ice-candidate"
            assert candidate["payload"]["candidate"] == "candidate:1 udp"


def test_signalling_refuses_to_relay_arbitrary_messages(client, registered_user, meeting):
    """The relay has a closed vocabulary.

    Without that, this socket becomes a general purpose message bus between
    participants that nothing validates.
    """
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/signal/{meeting['code']}?token={token}") as socket:
        socket.receive_json()
        socket.send_json({"type": "arbitrary-payload", "payload": {"anything": True}})

        message = socket.receive_json()
        assert message["type"] == "error"
        assert message["code"] == "INVALID_MESSAGE"


def test_sender_is_told_when_nobody_received_the_offer(client, registered_user, meeting):
    """An offer nobody heard should say so, not spin forever."""
    token = registered_user["access_token"]
    with client.websocket_connect(f"/ws/signal/{meeting['code']}?token={token}") as socket:
        socket.receive_json()
        socket.send_json({"type": "offer", "payload": {"sdp": "x", "type": "offer"}})

        message = socket.receive_json()
        assert message["type"] == "no-peers"


def test_speech_is_relayed_to_the_other_participant(
    client, registered_user, second_user, meeting
):
    """The hearing user's words reach the deaf user's caption bar.

    Speech travels on the inference socket rather than the signalling one
    because that is the meeting's text channel — both translation directions
    belong together, and a dropped video call must not take captions down too.
    """
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/predict/{code}?token={registered_user['access_token']}"
    ) as listener:
        listener.receive_json()

        with client.websocket_connect(
            f"/ws/predict/{code}?token={second_user['access_token']}"
        ) as speaker:
            speaker.receive_json()

            # The bespoke "speech" message type is gone. Sign and speech now
            # share one `caption` event with a producer-generated segment_id —
            # see test_captions.py and app/ws/captions.py for why.
            speaker.send_json(
                {
                    "type": "caption",
                    "segment_id": "seg-relay",
                    "source": "speech",
                    "text": "Hello there",
                    "is_final": True,
                }
            )

            for _ in range(5):
                message = listener.receive_json()
                if message.get("type") == "caption":
                    assert message["source"] == "speech"
                    assert message["text"] == "Hello there"
                    assert message["is_final"] is True
                    assert message["speaker"]["name"] == "Thamizhthilaga S D S"
                    assert message["segment_id"] == "seg-relay"
                    return
            pytest.fail("Speech caption was not relayed")


def test_empty_speech_is_ignored(client, registered_user, second_user, meeting):
    """Whitespace-only results from the recogniser must not become subtitles."""
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/predict/{code}?token={registered_user['access_token']}"
    ) as listener:
        listener.receive_json()

        with client.websocket_connect(
            f"/ws/predict/{code}?token={second_user['access_token']}"
        ) as speaker:
            speaker.receive_json()
            speaker.send_json(
                {
                    "type": "caption",
                    "segment_id": "seg-empty",
                    "source": "speech",
                    "text": "   ",
                    "is_final": True,
                }
            )

            # The ping proves the connection survived the empty speech and that
            # nothing was broadcast in between. Drained in a loop because the
            # server also emits a MODEL_NOT_LOADED frame on connect when no
            # model is present, which is the case under test.
            speaker.send_json({"type": "ping"})
            # Whitespace is still broadcast as an event — it is simply never
            # persisted (test_captions.py pins that). So the drain has to read
            # past the caption echo as well as the connect-time model warning.
            for _ in range(6):
                if speaker.receive_json().get("type") == "pong":
                    return
            pytest.fail("Empty speech disrupted the socket")


# --------------------------------------------------------------------------- #
# Presentation presence (Part B)
# --------------------------------------------------------------------------- #


def test_presentation_messages_are_relayed(client, registered_user, second_user, meeting):
    """Presentation start/stop is PRESENCE, which this socket already carries.

    The server still does not parse SDP, ICE, or anything about the screen —
    it stamps the sender and forwards the payload, exactly as for an offer.
    """
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/signal/{code}?token={registered_user['access_token']}"
    ) as presenter:
        presenter.receive_json()

        with client.websocket_connect(
            f"/ws/signal/{code}?token={second_user['access_token']}"
        ) as viewer:
            viewer.receive_json()

            presenter.send_json(
                {"type": "presentation-start", "payload": {"stream_id": "stream-xyz"}}
            )

            for _ in range(5):
                message = viewer.receive_json()
                if message.get("type") == "presentation-start":
                    # The stream id is what lets the receiver route the inbound
                    # track to the screen tile instead of guessing from arrival
                    # order, which is not guaranteed.
                    assert message["payload"]["stream_id"] == "stream-xyz"
                    assert message["from"]["name"] == "Swarna Rathna A"
                    return
            pytest.fail("presentation-start was not relayed")


def test_presentation_stop_is_relayed(client, registered_user, second_user, meeting):
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/signal/{code}?token={registered_user['access_token']}"
    ) as presenter:
        presenter.receive_json()

        with client.websocket_connect(
            f"/ws/signal/{code}?token={second_user['access_token']}"
        ) as viewer:
            viewer.receive_json()

            presenter.send_json({"type": "presentation-stop", "payload": {}})

            for _ in range(5):
                if viewer.receive_json().get("type") == "presentation-stop":
                    return
            pytest.fail("presentation-stop was not relayed")


def test_the_relay_vocabulary_is_still_closed(client, registered_user, meeting):
    """Adding presentation types must not have opened the socket to anything.

    Keeping this vocabulary closed is what stops the signalling channel
    becoming an unvalidated message bus between participants.
    """
    code = meeting["code"]

    with client.websocket_connect(
        f"/ws/signal/{code}?token={registered_user['access_token']}"
    ) as socket:
        socket.receive_json()
        socket.send_json({"type": "run-arbitrary-thing", "payload": {}})

        for _ in range(4):
            message = socket.receive_json()
            if message.get("code") == "INVALID_MESSAGE":
                return
        pytest.fail("an unknown signalling type was accepted")


# ---------------------------------------------------------------------------
# Bug 3 — room-wide state changes must reach the OTHER participant
# ---------------------------------------------------------------------------


def _drain_until(socket, message_type, limit=10):
    """Read messages until one of `message_type` arrives, or give up.

    The predict socket sends `connected` first and may send `prediction` or
    `error` messages, so a test cannot assume the next frame is the one it
    wants.
    """
    for _ in range(limit):
        message = socket.receive_json()
        if message.get("type") == message_type:
            return message
    raise AssertionError(f"no {message_type!r} message arrived within {limit} frames")


def _expect_broadcast(socket, message_type, limit=10):
    """Assert a broadcast arrived, failing FAST if it did not.

    WHY THE PING SENTINEL
    ---------------------
    `receive_json()` blocks. Draining for a message that is never sent hangs the
    test run instead of failing it, which is how the first version of these
    tests behaved when the broadcast was removed to check they bite — a hang is
    technically a detection but a useless one.

    A WebSocket delivers in order, so sending `ping` after the action under test
    and watching for `pong` gives a deterministic end marker: if `pong` arrives
    first, the broadcast did not happen, and the test fails with a readable
    message rather than stalling.
    """
    socket.send_json({"type": "ping"})
    for _ in range(limit):
        message = socket.receive_json()
        if message.get("type") == message_type:
            return message
        if message.get("type") == "pong":
            raise AssertionError(
                f"no {message_type!r} broadcast arrived — the ping sentinel came "
                f"back first, so nothing was sent to this participant"
            )
    raise AssertionError(f"no {message_type!r} message arrived within {limit} frames")


def test_switching_interview_mode_on_reaches_the_other_participant(
    client, auth_headers, registered_user, second_user, meeting
):
    """THE BUG 3 REGRESSION TEST.

    Interview Mode wrote the state to the meeting row and returned it to the
    HOST, and nothing told anyone else. The other participant's client had
    fetched the meeting once on mount and never read it again, so
    `is_interview_mode` stayed false on their screen: no dialog, no fullscreen,
    no enforcement. The feature worked only for the host.
    """
    guest_token = create_access_token(second_user["user"]["id"])
    client.post(f"/api/meetings/{meeting['code']}/join", headers=auth_headers)

    with client.websocket_connect(
        f"/ws/predict/{meeting['code']}?token={guest_token}"
    ) as guest_socket:
        _drain_until(guest_socket, "connected")

        # The HOST switches it on over REST.
        response = client.patch(
            f"/api/meetings/{meeting['code']}/interview-mode",
            json={"enabled": True},
            headers=auth_headers,
        )
        assert response.status_code == 200, response.text

        # The GUEST must be told, without asking.
        announced = _expect_broadcast(guest_socket, "interview-mode")

    assert announced["is_interview_mode"] is True
    assert announced["meeting_code"] == meeting["code"]
    assert announced["interview_mode_started_at"] is not None
    assert announced["host"]["id"] == registered_user["user"]["id"]


def test_ending_a_meeting_reaches_the_other_participant(
    client, auth_headers, second_user, meeting
):
    """Ending the meeting is the only normal way out of interview mode.

    The participant's client has to be told so it can release the keyboard
    lock, leave fullscreen and remove its listeners. Without this the candidate
    stays locked into a meeting that no longer exists.
    """
    guest_token = create_access_token(second_user["user"]["id"])

    with client.websocket_connect(
        f"/ws/predict/{meeting['code']}?token={guest_token}"
    ) as guest_socket:
        _drain_until(guest_socket, "connected")

        response = client.post(
            f"/api/meetings/{meeting['code']}/end", headers=auth_headers
        )
        assert response.status_code == 200, response.text

        announced = _expect_broadcast(guest_socket, "meeting-ended")

    assert announced["meeting_code"] == meeting["code"]
    assert announced["ended_at"] is not None
    assert announced["ended_by"]["id"] is not None


def test_the_connected_handshake_carries_the_interview_state(
    client, auth_headers, second_user
):
    """So a client that JOINS or RECONNECTS learns it without a live broadcast.

    This is the other half of the fix: the broadcast covers everyone currently
    connected, the handshake covers everyone who connects next. Reloading the
    page must not be a way to escape the mode.
    """
    created = client.post(
        "/api/meetings",
        json={"title": "Already invigilated", "is_interview_mode": True},
        headers=auth_headers,
    ).json()
    guest_token = create_access_token(second_user["user"]["id"])

    with client.websocket_connect(
        f"/ws/predict/{created['code']}?token={guest_token}"
    ) as guest_socket:
        connected = _drain_until(guest_socket, "connected")

    assert connected["meeting"] is not None, "the handshake carried no room state"
    assert connected["meeting"]["is_interview_mode"] is True
    assert connected["meeting"]["interview_mode_started_at"] is not None
    assert connected["meeting"]["ended_at"] is None


def test_the_handshake_reports_interview_mode_off_when_it_is_off(
    client, auth_headers, second_user, meeting
):
    guest_token = create_access_token(second_user["user"]["id"])
    with client.websocket_connect(
        f"/ws/predict/{meeting['code']}?token={guest_token}"
    ) as guest_socket:
        connected = _drain_until(guest_socket, "connected")

    assert connected["meeting"]["is_interview_mode"] is False
    assert connected["meeting"]["interview_mode_started_at"] is None


def test_the_demo_code_has_no_room_state(client, registered_user):
    """DEMO is not a real meeting, so there is no row to report."""
    token = create_access_token(registered_user["user"]["id"])
    with client.websocket_connect(f"/ws/predict/DEMO?token={token}") as socket:
        connected = _drain_until(socket, "connected")
    assert connected["meeting"] is None
