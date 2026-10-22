import { useCallback, useEffect, useRef, useState } from 'react';

import { buildPredictSocketUrl } from '../services/api';

/**
 * Manages the WebSocket to /ws/predict, with automatic reconnection.
 *
 * WHY THE RECONNECT LOGIC IS WORTH THE COMPLEXITY
 * -----------------------------------------------
 * A laptop that sleeps, a Wi-Fi handover between access points, or the backend
 * restarting during development all drop this socket. Without reconnection the
 * demo silently stops recognising anything, with no error and no clue why —
 * the camera is still on, the skeleton still draws, and nothing appears.
 *
 * Backoff is exponential with jitter. Exponential so a server that is down does
 * not get hammered; jittered so that if several clients drop at once they do
 * not all retry in lockstep and re-create the same stampede.
 */

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;
const MAX_ATTEMPTS = 12;

export function useSignSocket({
  meetingCode,
  enabled = true,
  onCaption,
  onRoomState,
  onMeetingEnded,
  onFocusEvent,
} = {}) {
  const socketRef = useRef(null);
  const retryTimerRef = useRef(null);
  const attemptRef = useRef(0);
  // Distinguishes a deliberate close (component unmounting, user leaving) from
  // a dropped connection. Without it, unmounting triggers a reconnect to a
  // socket nobody is listening to any more.
  const intentionalCloseRef = useRef(false);

  const [status, setStatus] = useState('idle'); // idle|connecting|open|reconnecting|closed|error
  const [prediction, setPrediction] = useState(null);
  const [sentence, setSentence] = useState('');
  const [serverError, setServerError] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  // Model B is a stretch goal and a backend without one is a supported
  // configuration, so the UI has to be told whether the word-sign toggle is
  // worth offering at all rather than assuming it works.
  const [dynamicModelInfo, setDynamicModelInfo] = useState(null);
  const [islModelInfo, setIslModelInfo] = useState(null);

  // Kept in a ref so a changing callback identity does not tear down and
  // rebuild the socket on every parent render.
  const onCaptionRef = useRef(onCaption);
  useEffect(() => {
    onCaptionRef.current = onCaption;
  }, [onCaption]);

  // Room-level state changes: Interview Mode being switched on, and the
  // meeting being ended. Held in refs for the same reason as onCaption — a
  // changing callback identity must not tear down and rebuild the socket.
  const onRoomStateRef = useRef(onRoomState);
  useEffect(() => {
    onRoomStateRef.current = onRoomState;
  }, [onRoomState]);

  const onMeetingEndedRef = useRef(onMeetingEnded);
  useEffect(() => {
    onMeetingEndedRef.current = onMeetingEnded;
  }, [onMeetingEnded]);

  // Interview Mode violations, sent by the server to the HOST only.
  const onFocusEventRef = useRef(onFocusEvent);
  useEffect(() => {
    onFocusEventRef.current = onFocusEvent;
  }, [onFocusEvent]);

  const connect = useCallback(() => {
    if (!meetingCode) return;

    // Guard against opening a second socket over a live one.
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.OPEN ||
        socketRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(buildPredictSocketUrl(meetingCode));
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setStatus('open');
      setServerError(null);
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (message.type) {
        case 'connected':
          setModelInfo(message.model ?? null);
          setDynamicModelInfo(message.dynamic_model ?? null);
          setIslModelInfo(message.isl_model ?? null);
          // Room state from the handshake. This is what makes reloading or
          // reconnecting NOT a way to escape Interview Mode: the server
          // reports the current state on every connection, so a client that
          // missed the live broadcast still learns it.
          if (message.meeting) onRoomStateRef.current?.(message.meeting);
          break;

        case 'interview-mode':
          // Live announcement, broadcast by the server when the host switches
          // it on. Before this existed the state reached only the host, which
          // is why Interview Mode did not work at all for the participant.
          onRoomStateRef.current?.({
            is_interview_mode: message.is_interview_mode,
            interview_mode_started_at: message.interview_mode_started_at ?? null,
            host: message.host ?? null,
          });
          break;

        case 'focus-event':
          // Only the host receives these — the server targets their socket
          // rather than broadcasting, because a violation is a record about a
          // participant and the room must not see each other's.
          //
          // `action` ("warned"/"removed") and `departures` arrive BESIDE
          // `event`, not inside it, so they are folded in here. Passing
          // `message.event` alone left the host's toast reading
          // `event.action === undefined` every time, so a removal was
          // announced with the same bland "left the meeting screen" line as a
          // first warning and the host was never actually told what the
          // server had decided.
          onFocusEventRef.current?.({
            ...message.event,
            action: message.action ?? message.event?.action ?? 'none',
            departures: message.departures ?? message.event?.departures ?? 0,
          });
          break;

        case 'participant-removed':
          // Broadcast to the room when Interview Mode removes somebody. The
          // participant it names ends their own meeting; everyone else just
          // learns why a tile disappeared.
          onRoomStateRef.current?.({ removed: message.user ?? null });
          break;

        case 'meeting-ended':
          // The only normal way out of Interview Mode. The handler releases
          // the keyboard lock, leaves fullscreen and navigates away.
          onMeetingEndedRef.current?.(message);
          break;

        case 'prediction':
          setPrediction(message);
          setSentence(message.sentence ?? '');
          break;

        case 'sentence':
          setSentence(message.sentence ?? '');
          break;

        case 'caption':
          // One event for both sources, from EVERY participant including
          // ourselves. The receiver replaces the line with this segment_id
          // rather than appending — that is what stops a caption growing into
          // "warm warm warm" as interims arrive.
          onCaptionRef.current?.(message);
          break;

        case 'error':
          setServerError({ code: message.code, message: message.message });
          break;

        case 'pong':
          break;

        default:
          break;
      }
    };

    socket.onerror = () => {
      // The browser deliberately does not say why a WebSocket failed, to avoid
      // leaking cross-origin information. onclose carries the useful code.
      setStatus('error');
    };

    socket.onclose = (event) => {
      socketRef.current = null;

      if (intentionalCloseRef.current) {
        setStatus('closed');
        return;
      }

      // 1008 is our policy-violation code: a bad token or a meeting that does
      // not exist. Retrying cannot fix either, so stop and say so.
      if (event.code === 1008) {
        setStatus('error');
        setServerError({
          code: 'UNAUTHORIZED',
          message: event.reason || 'Not authorised for this meeting. Try logging in again.',
        });
        return;
      }

      if (attemptRef.current >= MAX_ATTEMPTS) {
        setStatus('closed');
        setServerError({
          code: 'RECONNECT_FAILED',
          message: `Gave up after ${MAX_ATTEMPTS} attempts. Is the backend running?`,
        });
        return;
      }

      const delay = Math.min(INITIAL_RETRY_MS * 2 ** attemptRef.current, MAX_RETRY_MS);
      // Up to 30% jitter, so simultaneous drops do not retry in lockstep.
      const jittered = delay * (0.85 + Math.random() * 0.3);
      attemptRef.current += 1;

      setStatus('reconnecting');
      retryTimerRef.current = setTimeout(connect, jittered);
    };
  }, [meetingCode]);

  useEffect(() => {
    if (!enabled || !meetingCode) return undefined;

    intentionalCloseRef.current = false;
    attemptRef.current = 0;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      setStatus('idle');
    };
  }, [connect, enabled, meetingCode]);

  /** Send one frame of landmarks. Silently no-ops if the socket is not open. */
  const sendLandmarks = useCallback((hands, mode = 'static') => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    // bufferedAmount guards against a slow network: if frames are queuing up
    // faster than they drain, dropping the newest is far better than building
    // an ever-growing backlog that makes predictions arrive seconds late.
    if (socket.bufferedAmount > 64 * 1024) return false;

    socket.send(
      JSON.stringify({ type: 'landmarks', mode, timestamp: Date.now(), hands }),
    );
    return true;
  }, []);

  /**
   * Send a caption, from either source.
   *
   * Both directions use this one call. They used to have separate message
   * types and separate server handling, which is how the sign path ended up
   * broadcasting the whole accumulated sentence while speech sent only the
   * current phrase.
   *
   * `segmentId` is the producer's id for this utterance and must stay the same
   * across every interim and the final. The server keys its single transcript
   * row on it.
   *
   * Captions travel on this socket rather than the signalling one because this
   * is the meeting's *text* channel — both translation directions belong
   * together, and a dropped video call must not take the captions down too.
   */
  const sendCaption = useCallback(({ segmentId, source, text, isFinal, confidence = null }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (!segmentId || !source) return false;

    socket.send(
      JSON.stringify({
        type: 'caption',
        segment_id: segmentId,
        source,
        text: text ?? '',
        is_final: Boolean(isFinal),
        confidence,
      }),
    );
    return true;
  }, []);

  const sendControl = useCallback((type) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }));
  }, []);

  const clearSentence = useCallback(() => sendControl('clear'), [sendControl]);
  const backspace = useCallback(() => sendControl('backspace'), [sendControl]);

  return {
    status,
    prediction,
    sentence,
    serverError,
    modelInfo,
    dynamicModelInfo,
    islModelInfo,
    sendLandmarks,
    sendCaption,
    clearSentence,
    backspace,
    isConnected: status === 'open',
  };
}
