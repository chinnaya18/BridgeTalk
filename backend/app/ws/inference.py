"""WebSocket endpoint: hand landmarks in, recognised text out.

    WS /ws/predict/{meeting_code}?token=<jwt>

WHAT CROSSES THIS SOCKET
------------------------
Coordinates. Twenty-one (x, y, z) triples per hand — about 500 bytes a frame,
roughly 5 KB/s at our 10 FPS send rate. **No video frame ever travels this
socket**, and there is no code path here that could accept one. MediaPipe runs
in the browser, so the user's camera feed never leaves their machine.

That is the central privacy claim of BridgeTalk's architecture, and this file is
where it is either true or not. It is true.

WHY THE TOKEN IS IN THE QUERY STRING
------------------------------------
The browser WebSocket API cannot set an Authorization header — the constructor
takes a URL and nothing else. The options are a query parameter, a cookie, or a
first message containing the token. We use a query parameter, which is standard
practice, with one caveat worth knowing: query strings appear in server access
logs in a way headers do not. On a locally-hosted project that is acceptable;
in production it would argue for short-lived, single-use socket tickets.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.security import decode_access_token
from app.database import SessionLocal
from app.ml.normalization import (
    normalize_hands,
    normalize_primary_hand,
    sequence_frame_features,
)
from app.ml.predictor import (
    ModelNotLoadedError,
    dynamic_predictor,
    isl_predictor,
    predictor,
)
from app.ml.sequence import SequenceBuffer
from app.ml.smoothing import NEUTRAL_LABEL, PredictionSmoother, SmoothingConfig
from app.ws.captions import (
    build_caption_event,
    persist_final_caption,
    validate_caption,
)
from app.models.meeting import Meeting
from app.models.user import User
from app.ws.connection_manager import inference_manager

logger = logging.getLogger("bridgetalk.ws.inference")

router = APIRouter()

# WebSocket close codes. 1008 is "policy violation", the conventional code for
# an authentication failure, and 1011 is "internal error".
WS_POLICY_VIOLATION = 1008
WS_INTERNAL_ERROR = 1011

# The three recognition modes. Anything else is rejected rather than silently
# treated as static — a client sending "STATIC" or "letters" should be told it
# is wrong, not quietly given behaviour it did not ask for.
#
# ASL and ISL are separate modes rather than a language flag on one mode
# because they genuinely route to different models with different input
# widths, and the client must track a different number of hands for each.
STATIC_MODE = "static"     # ASL fingerspelling — one hand, 63 features
ISL_MODE = "isl"           # ISL fingerspelling — two hands, 126 features
DYNAMIC_MODE = "dynamic"   # word signs — a (30, 126) sequence
VALID_MODES = frozenset({STATIC_MODE, ISL_MODE, DYNAMIC_MODE})


def _authenticate(token: str) -> User | None:
    """Resolve a JWT from the query string into a User.

    Uses its own short-lived session rather than the request-scoped `get_db`
    dependency: a WebSocket lives for minutes or hours, and holding a database
    connection open for that whole time would exhaust the pool with a handful
    of participants.
    """
    payload = decode_access_token(token)
    if payload is None:
        return None

    subject = payload.get("sub")
    if subject is None:
        return None

    try:
        user_id = int(subject)
    except (TypeError, ValueError):
        return None

    with SessionLocal() as session:
        return session.get(User, user_id)


def _meeting_exists(meeting_code: str) -> bool:
    """Check the meeting is real before accepting a socket for it."""
    with SessionLocal() as session:
        meeting = session.scalar(
            select(Meeting).where(Meeting.code == meeting_code.strip().upper())
        )
        return meeting is not None and meeting.ended_at is None


def _top2_margin(probabilities) -> float:
    """Gap between the best and second-best class.

    Confidence alone cannot distinguish "certain" from "cannot tell these two
    apart": a model may be 0.72 on the winner while the runner-up sits at
    0.70. The client requires a clear margin before committing a sign, and it
    cannot compute one without this.
    """
    if probabilities is None or len(probabilities) < 2:
        return 1.0
    ordered = sorted(probabilities, reverse=True)
    return float(ordered[0] - ordered[1])


def _error(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": message}


def _room_state(meeting_code: str) -> dict[str, Any] | None:
    """The meeting's current room-level state, for the `connected` handshake.

    Read fresh from the database on every connection rather than cached,
    because the whole point is to be correct for a client that was
    disconnected while something changed.

    Returns None for a code with no meeting row — notably the `DEMO` code used
    by the standalone /detect page, which is not a real meeting.
    """
    try:
        with SessionLocal() as session:
            meeting = session.scalar(select(Meeting).where(Meeting.code == meeting_code))
            if meeting is None:
                return None
            return {
                "is_interview_mode": bool(meeting.is_interview_mode),
                "interview_mode_started_at": (
                    meeting.interview_mode_started_at.isoformat()
                    if meeting.interview_mode_started_at
                    else None
                ),
                "host": {"id": meeting.host_id},
                "ended_at": meeting.ended_at.isoformat() if meeting.ended_at else None,
            }
    except Exception:  # noqa: BLE001
        # A failure here must not stop the socket connecting. Sign recognition
        # does not depend on room state, and a client that gets no `meeting`
        # block simply keeps whatever it already had.
        logger.exception("Could not read room state for %s", meeting_code)
        return None


def _handle_static_frame(
    hands: list[dict[str, Any]],
    smoother: PredictionSmoother,
    received_at: float,
) -> dict[str, Any] | None:
    """One frame through Model A: a single hand shape becomes a letter.

    Returns the message to send back, or an error message. Kept synchronous and
    free of WebSocket calls so it can be unit-tested against a list of frames
    without a running server.
    """
    # No hand in frame. This is the neutral state, and it is resolved WITHOUT
    # calling the model — there are no landmarks to classify. It is also why
    # 'nothing' is not a trained class: see ml/models/dataset_manifest.json.
    if not hands:
        result = smoother.push(None, 0.0)
        return {
            "type": "prediction",
            "mode": STATIC_MODE,
            "label": NEUTRAL_LABEL,
            "confidence": 0.0,
            "stable": False,
            "sentence": result.sentence,
            "hand_detected": False,
            "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
            "_result": result,
        }

    try:
        features = normalize_primary_hand(hands)
    except (ValueError, TypeError) as exc:
        return _error("INVALID_MESSAGE", f"Bad landmark data: {exc}")

    try:
        label, confidence, probabilities = predictor.predict(features)
    except ModelNotLoadedError as exc:
        return _error("MODEL_NOT_LOADED", str(exc))
    except ValueError as exc:
        return _error("INVALID_MESSAGE", str(exc))

    result = smoother.push(label, confidence)

    return {
        "type": "prediction",
        "mode": STATIC_MODE,
        "label": result.label,
        "confidence": round(result.confidence, 4),
        # The runner-up gap, so the client can reject near-ties.
        "margin": round(_top2_margin(probabilities), 4),
        "stable": result.stable,
        "emitted": result.emitted,
        "sentence": result.sentence,
        "hand_detected": True,
        # Server receive-to-send time. Surfacing a real number the UI can
        # display is worth a lot in a review — it turns "it feels fast" into
        # "38 milliseconds".
        "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
        "_result": result,
    }


def _handle_isl_frame(
    hands: list[dict[str, Any]],
    smoother: PredictionSmoother,
    received_at: float,
) -> dict[str, Any] | None:
    """One frame through Model C: two hand shapes become an ISL letter.

    Structurally identical to the static path — one frame is the whole answer,
    so there is no buffering and no sequence. The only difference is the
    feature vector: `normalize_hands` produces 126 floats with a fixed slot per
    hand, where ASL's `normalize_primary_hand` produces 63 for one hand.

    Slotting by handedness rather than detection order is what makes a
    two-handed alphabet learnable at all. MediaPipe reports hands in whatever
    order it found them, so without it the same letter would land in two
    different arrangements from frame to frame.
    """
    if not hands:
        result = smoother.push(None, 0.0)
        return {
            "type": "prediction",
            "mode": ISL_MODE,
            "label": NEUTRAL_LABEL,
            "confidence": 0.0,
            "stable": False,
            "sentence": result.sentence,
            "hand_detected": False,
            "hands_seen": 0,
            "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
            "_result": result,
        }

    try:
        features = normalize_hands(hands)
    except (ValueError, TypeError) as exc:
        return _error("INVALID_MESSAGE", f"Bad landmark data: {exc}")

    try:
        label, confidence, probabilities = isl_predictor.predict(features)
    except ModelNotLoadedError as exc:
        return _error("MODEL_NOT_LOADED", str(exc))
    except ValueError as exc:
        return _error("INVALID_MESSAGE", str(exc))

    result = smoother.push(label, confidence)

    return {
        "type": "prediction",
        "mode": ISL_MODE,
        "label": result.label,
        "confidence": round(result.confidence, 4),
        # The runner-up gap, so the client can reject near-ties.
        "margin": round(_top2_margin(probabilities), 4),
        "stable": result.stable,
        "emitted": result.emitted,
        "sentence": result.sentence,
        "hand_detected": True,
        # Surfaced so the UI can say "only one hand visible" on a letter that
        # needs two — by far the most common reason an ISL prediction is wrong.
        "hands_seen": len(hands),
        "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
        "_result": result,
    }


def _handle_dynamic_frame(
    hands: list[dict[str, Any]],
    buffer: SequenceBuffer,
    smoother: PredictionSmoother,
    received_at: float,
) -> dict[str, Any] | None:
    """One frame through Model B: a window of frames becomes a word.

    The important difference from the static path is that **most frames produce
    no prediction at all**. A word sign needs a full window of 30 frames — three
    seconds at 10 FPS — and even then only every `stride`-th frame is
    classified. Rather than going silent while that happens, this reports how
    full the buffer is, so the UI can show "listening…" with real progress
    instead of appearing broken.
    """
    if not dynamic_predictor.is_loaded:
        return _error(
            "MODEL_NOT_LOADED",
            dynamic_predictor.load_error
            or "Word-sign recognition is not available on this server",
        )

    if hands:
        try:
            # Shape plus wrist position — see sequence_frame_features. The ISL
            # alphabet path above uses normalize_hands instead, because for a
            # letter the position genuinely should not matter.
            features = sequence_frame_features(hands)
        except (ValueError, TypeError) as exc:
            return _error("INVALID_MESSAGE", f"Bad landmark data: {exc}")
    else:
        features = None

    try:
        window = buffer.push(features)
    except ValueError as exc:
        return _error("INVALID_MESSAGE", str(exc))

    # Buffer not ready, or this frame fell between strides. Feed the smoother
    # the neutral signal when the hands are gone so its reset logic still runs,
    # but do not invent a prediction.
    if window is None:
        result = smoother.push(None, 0.0) if not hands else None
        return {
            "type": "prediction",
            "mode": DYNAMIC_MODE,
            "label": NEUTRAL_LABEL,
            "confidence": 0.0,
            "stable": False,
            "sentence": result.sentence if result else smoother.sentence,
            "hand_detected": bool(hands),
            "buffering": True,
            "buffer_filled": buffer.filled,
            "buffer_length": buffer.length,
            "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
            "_result": result,
        }

    try:
        label, confidence, probabilities = dynamic_predictor.predict(window)
    except ModelNotLoadedError as exc:
        return _error("MODEL_NOT_LOADED", str(exc))
    except ValueError as exc:
        return _error("INVALID_MESSAGE", str(exc))

    result = smoother.push(label, confidence)

    return {
        "type": "prediction",
        "mode": DYNAMIC_MODE,
        "label": result.label,
        "confidence": round(result.confidence, 4),
        # The runner-up gap, so the client can reject near-ties.
        "margin": round(_top2_margin(probabilities), 4),
        "stable": result.stable,
        "emitted": result.emitted,
        "sentence": result.sentence,
        "hand_detected": bool(hands),
        "buffering": False,
        "buffer_filled": buffer.filled,
        "buffer_length": buffer.length,
        "latency_ms": round((time.perf_counter() - received_at) * 1000, 1),
        "_result": result,
    }


@router.websocket("/ws/predict/{meeting_code}")
async def predict_socket(
    websocket: WebSocket,
    meeting_code: str,
    token: str = Query(..., description="JWT from POST /api/auth/login"),
) -> None:
    """Stream landmarks in, stream predictions out."""

    # --- authenticate ---------------------------------------------------------
    # The handshake is completed FIRST, then the socket is closed with an
    # application close code if authentication fails.
    #
    # Rejecting before accepting is the tempting alternative, but Starlette
    # turns that into a plain HTTP 403 and the browser reports a generic
    # code 1006 ("abnormal closure") — indistinguishable from the server being
    # down. The client then retries a bad token twelve times with backoff.
    # Accepting first lets us send code 1008 with a reason the UI can act on,
    # and the socket is closed immediately, so nothing useful is exposed.
    user = _authenticate(token)
    if user is None:
        await websocket.accept()
        await websocket.send_json(
            _error("UNAUTHORIZED", "Invalid or expired token — please log in again")
        )
        await websocket.close(code=WS_POLICY_VIOLATION, reason="Invalid or expired token")
        return

    normalized_code = meeting_code.strip().upper()

    # A "DEMO" code is allowed so the sign-detection panel can be exercised
    # without first creating a meeting. It is still authenticated — it skips
    # the meeting lookup, not the token check.
    if normalized_code != "DEMO" and not _meeting_exists(normalized_code):
        await websocket.accept()
        await websocket.send_json(
            _error("MEETING_NOT_FOUND", f"No active meeting with code {normalized_code}")
        )
        await websocket.close(
            code=WS_POLICY_VIOLATION, reason="No such meeting, or it has ended"
        )
        return

    connection = await inference_manager.connect(
        websocket, normalized_code, user.id, user.name
    )

    # One set of recognition state per connection. Sharing it between two people
    # signing at once would interleave their letters into a single sentence.
    #
    # Each mode gets its own smoother because they need different thresholds and
    # different debounce timing (see SmoothingConfig.for_dynamic). The sentence
    # is handed between them on a mode switch, so the user keeps writing one
    # continuous piece of text.
    smoothers = {
        STATIC_MODE: PredictionSmoother(),
        # ISL letters concatenate exactly like ASL letters, so word_mode stays
        # off and the static thresholds apply. The alphabet differs; the
        # business of turning a stream of letters into text does not.
        ISL_MODE: PredictionSmoother(),
        DYNAMIC_MODE: PredictionSmoother(SmoothingConfig.for_dynamic(), word_mode=True),
    }
    buffer = SequenceBuffer()
    active_mode = STATIC_MODE

    smoother = smoothers[STATIC_MODE]
    connection.state["smoother"] = smoother

    # Tell the client what it is connected to, so the UI can show model status
    # rather than silently producing nothing when no model is loaded.
    await inference_manager.send_personal(
        connection,
        {
            "type": "connected",
            "meeting_code": normalized_code,
            "user": {"id": user.id, "name": user.name},
            # Room state, so a client that JOINS or RECONNECTS learns it from
            # the handshake rather than only from a live broadcast it may have
            # missed while its socket was down. This is the other half of the
            # Bug 3 fix: the broadcast covers everyone currently connected,
            # this covers everyone who connects next.
            "meeting": _room_state(normalized_code),
            "model": predictor.describe(),
            # Advertised so the UI can enable or hide each mode rather than
            # offering one that cannot work on this deployment.
            "isl_model": isl_predictor.describe(),
            "dynamic_model": dynamic_predictor.describe(),
            "config": {
                "confidence_threshold": smoother.config.confidence_threshold,
                "majority_window": smoother.config.majority_window,
                "majority_min": smoother.config.majority_min,
                "cooldown_ms": smoother.config.cooldown_ms,
            },
            "dynamic_config": {
                "confidence_threshold": smoothers[DYNAMIC_MODE].config.confidence_threshold,
                "majority_window": smoothers[DYNAMIC_MODE].config.majority_window,
                "majority_min": smoothers[DYNAMIC_MODE].config.majority_min,
                "cooldown_ms": smoothers[DYNAMIC_MODE].config.cooldown_ms,
                **buffer.describe(),
            },
        },
    )

    if not predictor.is_loaded:
        await inference_manager.send_personal(
            connection,
            _error(
                "MODEL_NOT_LOADED",
                predictor.load_error or "No sign model is loaded on the server",
            ),
        )

    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")

            # --- UI controls ---------------------------------------------
            if message_type == "clear":
                smoothers[active_mode].clear()
                buffer.reset()
                await inference_manager.send_personal(
                    connection, {"type": "sentence", "sentence": ""}
                )
                continue

            if message_type == "backspace":
                await inference_manager.send_personal(
                    connection,
                    {"type": "sentence", "sentence": smoothers[active_mode].backspace()},
                )
                continue

            if message_type == "ping":
                await inference_manager.send_personal(connection, {"type": "pong"})
                continue

            # Speech recognised by the browser's Web Speech API, relayed to the
            # other participant. It travels on this socket rather than the
            # signalling one because this is the meeting's *text* channel —
            # both translation directions belong together, and a dropped video
            # call must not take the captions down with it.
            # --- captions, from EITHER source -----------------------------
            # One handler for sign and speech. They used to travel two
            # different ways, which is how the sign path ended up broadcasting
            # the whole accumulated sentence while speech sent only the phrase.
            if message_type == "caption":
                problem = validate_caption(message)
                if problem:
                    await inference_manager.send_personal(
                        connection, _error("INVALID_MESSAGE", problem)
                    )
                    continue

                is_final = bool(message.get("is_final", False))
                event = build_caption_event(
                    meeting_code=normalized_code,
                    segment_id=message["segment_id"],
                    speaker_id=user.id,
                    speaker_name=user.name,
                    source=message["source"],
                    text=message["text"],
                    is_final=is_final,
                    confidence=message.get("confidence"),
                )

                # Broadcast to EVERYONE, sender included. Excluding the sender
                # meant each participant assembled their caption list from a
                # different code path — local state for their own words, the
                # socket for the other person's — and the two disagreed. Now
                # there is one source of truth for both sides.
                await inference_manager.broadcast(normalized_code, event)

                # Persist once, on the final event, keyed by segment_id. The
                # DEMO code is not a real meeting, so nothing is stored for it.
                if is_final and normalized_code != "DEMO":
                    with SessionLocal() as session:
                        meeting = session.scalar(
                            select(Meeting).where(Meeting.code == normalized_code)
                        )
                        if meeting is not None:
                            persist_final_caption(
                                session,
                                meeting_id=meeting.id,
                                user_id=user.id,
                                segment_id=message["segment_id"],
                                source=message["source"],
                                text=message["text"],
                                confidence=message.get("confidence"),
                            )
                continue

            if message_type != "landmarks":
                await inference_manager.send_personal(
                    connection,
                    _error("INVALID_MESSAGE", f"Unknown message type: {message_type!r}"),
                )
                continue

            # --- the actual work ------------------------------------------
            received_at = time.perf_counter()
            hands = message.get("hands") or []

            requested_mode = str(message.get("mode") or STATIC_MODE).strip().lower()
            if requested_mode not in VALID_MODES:
                await inference_manager.send_personal(
                    connection,
                    _error(
                        "INVALID_MESSAGE",
                        f"Unknown mode {requested_mode!r}. Expected one of "
                        f"{sorted(VALID_MODES)}.",
                    ),
                )
                continue

            # --- mode switch ------------------------------------------------
            if requested_mode != active_mode:
                previous = smoothers[active_mode]
                smoothers[requested_mode].adopt(previous.sentence)
                # A partially-filled window recorded before the switch describes
                # the wrong kind of gesture, so it is discarded rather than
                # forming the first half of a word sign.
                buffer.reset()
                active_mode = requested_mode
                connection.state["smoother"] = smoothers[active_mode]

            smoother = smoothers[active_mode]

            if requested_mode == DYNAMIC_MODE:
                result_message = _handle_dynamic_frame(hands, buffer, smoother, received_at)
            elif requested_mode == ISL_MODE:
                result_message = _handle_isl_frame(hands, smoother, received_at)
            else:
                result_message = _handle_static_frame(hands, smoother, received_at)

            if result_message is None:
                continue

            if result_message.get("type") == "error":
                await inference_manager.send_personal(connection, result_message)
                continue

            result = result_message.pop("_result")
            await inference_manager.send_personal(connection, result_message)
            # NOTE: this loop no longer broadcasts anything.
            #
            # It used to send `result.sentence` — the whole ACCUMULATED
            # sentence — as the caption text, which is why captions grew
            # without bound and the transcript stored the same sentence
            # over and over with one more word each time.
            #
            # The client now owns segmentation: it receives the per-frame
            # prediction above, decides where an utterance starts and ends,
            # and sends a `caption` message carrying a segment_id. Keeping
            # that decision in one place is the point — it was previously
            # split between a Python smoother and a JavaScript buffer that
            # each held half of it and disagreed.

    except WebSocketDisconnect:
        # Normal: the tab closed or the user left the meeting.
        pass
    except Exception:  # noqa: BLE001
        logger.exception("Inference socket failed for %s", user.name)
        try:
            await websocket.close(code=WS_INTERNAL_ERROR)
        except RuntimeError:
            # Already closed — nothing to do.
            pass
    finally:
        await inference_manager.disconnect(connection)
