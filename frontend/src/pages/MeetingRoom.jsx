import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import DebugOverlay from '../components/DebugOverlay';
import HandOverlayCanvas from '../components/HandOverlayCanvas';
import InterviewModeDialog from '../components/InterviewModeDialog';
import InterviewModeOverlay from '../components/InterviewModeOverlay';
import CaptionRail from '../components/meeting/CaptionRail';
import ControlBar from '../components/meeting/ControlBar';
import DetailsPanel from '../components/meeting/DetailsPanel';
import LiveTranscriptPanel from '../components/meeting/LiveTranscriptPanel';
import PeoplePanel from '../components/meeting/PeoplePanel';
import SettingsDialog from '../components/meeting/SettingsDialog';
import SidePanel from '../components/meeting/SidePanel';
import Stage from '../components/meeting/Stage';
import { Icon, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useCaptionStore } from '../hooks/useCaptionStore';
import { useHandLandmarker } from '../hooks/useHandLandmarker';
import { useInterviewMode } from '../hooks/useInterviewMode';
import { useMediaDevices } from '../hooks/useMediaDevices';
import { useMeetingPreferences } from '../hooks/useMeetingPreferences';
import { useScreenShare } from '../hooks/useScreenShare';
import { useSignCaptions } from '../hooks/useSignCaptions';
import { useSignSocket } from '../hooks/useSignSocket';
import { useSpeechCaptions } from '../hooks/useSpeechCaptions';
import { useWebRTC } from '../hooks/useWebRTC';
import { meetings as meetingsApi, transcripts as transcriptsApi } from '../services/api';
import { loadDevicePreferences, saveDevicePreferences } from '../services/devicePreferences';
import { formatElapsed } from '../utils/formatters';
import { toWireFormat } from '../utils/landmarkUtils';
import { shortcutFor } from '../utils/shortcuts';

/**
 * The meeting room.
 *
 * FOUR THINGS RUN AT ONCE HERE, AND THEY SHARE ONE CAMERA
 * -------------------------------------------------------
 *   1. MediaPipe reads the local video element for hand landmarks (local only)
 *   2. those landmarks stream to /ws/predict and come back as text
 *   3. the same MediaStream is published to the peer over WebRTC
 *   4. the speech engine captions the microphone for the other direction
 *
 * getUserMedia is called exactly once and the resulting stream is shared.
 * Calling it twice would ask for the camera twice and, on some machines, fail
 * outright because the device is already open.
 *
 * PRODUCING CAPTIONS IS SEPARATE FROM DISPLAYING THEM
 * --------------------------------------------------
 * Producing is automatic: an unmuted microphone produces speech captions, and
 * sign recognition switched on with a live camera produces sign captions.
 * Neither depends on any display setting, and neither depends on a panel
 * component being mounted — which is why all of it lives in meeting-level hooks.
 *
 * The captions button controls DISPLAY only. Nobody's speech should go
 * unrecognised because they chose not to look at captions themselves.
 */

const SEND_INTERVAL_MS = 100; // 10 FPS to the inference socket

// Violations before the host is prompted to remove the participant.
const MAX_VIOLATIONS = 3;

// How long a caption keeps the blue ring on its author's tile.
const ACTIVITY_HOLD_MS = 1500;

export default function MeetingRoom() {
  const { code } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  // Held in a ref so callbacks declared above the socket can raise a toast
  // without taking `toast` as a dependency and re-creating themselves.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // ?debug=1 only. "I spoke and nothing happened" is not a reportable bug
  // without knowing which stage died.
  const debugEnabled = searchParams.get('debug') === '1';
  const lastSentRef2 = useRef('—');
  const lastReceivedRef = useRef('—');

  const localVideoRef = useRef(null);
  const rafRef = useRef(null);
  const lastSentRef = useRef(0);

  const [meeting, setMeeting] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [landmarks, setLandmarks] = useState([]);

  const { preferences, update: updatePreferences } = useMeetingPreferences(user?.id);

  // Device ids come from session storage, written by the lobby.
  //
  // THIS USED TO READ QUERY PARAMETERS, AND THAT WAS THE BUG.
  // Reported problem 6 was that the join URL carried a raw `deviceId`. The
  // lobby was changed to write sessionStorage, but this page was still reading
  // `searchParams.get('camera')` — which is now always null, so every meeting
  // silently used the system default and the lobby's picker did nothing.
  const initialDevices = useRef(loadDevicePreferences() ?? {}).current;
  const [micId, setMicId] = useState(initialDevices.micId ?? '');
  const [cameraId, setCameraId] = useState(initialDevices.cameraId ?? '');
  const [speakerId, setSpeakerId] = useState(initialDevices.speakerId ?? '');

  // Sign recognition is OPT-IN. It used to default to true for everyone, which
  // is why a hearing participant's resting hands were classified as signs
  // ("M at 71%") while they were not signing at all. The lobby's "I will be
  // signing in this meeting" checkbox is what turns it on at join.
  const [signRecognitionOn, setSignRecognitionOn] = useState(
    Boolean(initialDevices.willSign),
  );
  // Captions are DISPLAY only, and on by default for everyone.
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [micOn, setMicOn] = useState(initialDevices.micOn !== false);
  const [cameraOn, setCameraOn] = useState(initialDevices.cameraOn !== false);

  // Set when the server announces the meeting has ended. Drives the teardown
  // effect below, which is the only normal way out of Interview Mode.
  const [meetingEndedBy, setMeetingEndedBy] = useState(null);

  // Per-participant violation tally, built from the live focus-event stream.
  // Host-only: nobody else is sent these.
  const [violations, setViolations] = useState({});

  // The server's verdict on THIS participant under the Interview Mode rule.
  // 'none' until they leave the meeting screen, then 'warned', then removal.
  const [interviewVerdict, setInterviewVerdict] = useState('none');
  const [removedFromInterview, setRemovedFromInterview] = useState(false);

  const [openPanel, setOpenPanel] = useState(null); // null | details | people | transcript
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [transcriptLines, setTranscriptLines] = useState([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);

  const recognitionMode = preferences.recognitionMode;

  const { cameras, microphones, speakers } = useMediaDevices({ enabled: true });

  // --- meeting record ------------------------------------------------------

  const refreshTranscript = useCallback(
    async (meetingId) => {
      if (!meetingId) return;
      setTranscriptLoading(true);
      setTranscriptError(null);
      try {
        const rows = await transcriptsApi.list(meetingId);
        setTranscriptLines(
          rows.map((row) => ({
            id: `db-${row.id}`,
            speaker: row.user_name,
            source: row.source,
            text: row.content,
            confidence: row.confidence,
            timestamp: row.created_at,
          })),
        );
      } catch (cause) {
        setTranscriptError(cause?.message ?? 'Could not load the transcript');
      } finally {
        setTranscriptLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function joinMeeting() {
      try {
        const result = await meetingsApi.join(code);
        if (cancelled) return;
        setMeeting(result.meeting);
        refreshTranscript(result.meeting.id);
      } catch {
        // Already in the meeting, or it has ended — fall back to a read so the
        // room still renders rather than dumping the user back to Home.
        try {
          const detail = await meetingsApi.get(code);
          if (!cancelled) {
            setMeeting(detail);
            refreshTranscript(detail.id);
          }
        } catch {
          if (!cancelled) navigate('/', { replace: true });
        }
      }
    }

    joinMeeting();
    return () => {
      cancelled = true;
    };
  }, [code, navigate, refreshTranscript]);

  // --- one camera, shared ---------------------------------------------------

  useEffect(() => {
    let stream = null;
    let cancelled = false;

    async function startMedia() {
      try {
        // `exact` is deliberate: without it the browser treats the id as a
        // preference and may hand back a different camera, which would make the
        // lobby's selector a lie.
        stream = await navigator.mediaDevices.getUserMedia({
          video: initialDevices.cameraId
            ? {
                deviceId: { exact: initialDevices.cameraId },
                width: { ideal: 640 },
                height: { ideal: 480 },
              }
            : { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          // Echo cancellation and noise suppression are not optional here.
          // Speech recognition runs on this microphone, so the remote
          // participant's voice coming back through the speakers would be
          // transcribed as if this user had said it.
          audio: initialDevices.micId
            ? {
                deviceId: { exact: initialDevices.micId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        // Carry the lobby's mute state through, rather than surprising someone
        // with a live microphone they had deliberately switched off.
        if (initialDevices.micOn === false) {
          stream.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
        }
        if (initialDevices.cameraOn === false) {
          stream.getVideoTracks().forEach((track) => track.stop());
        }

        setLocalStream(stream);
      } catch (error) {
        if (cancelled) return;
        if (error.name === 'NotAllowedError') {
          setCameraError(
            'Camera and microphone permission denied. Allow access from the icon in your browser address bar, then reload.',
          );
        } else if (error.name === 'NotReadableError') {
          setCameraError('Your camera is in use by another app. Close it and reload.');
        } else {
          setCameraError(`Could not start camera or microphone: ${error.message}`);
        }
      }
    }

    startMedia();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acquire once, on mount
  }, []);

  // Attach the stream to the local <video>, which MediaPipe reads frames from.
  // The tile owns its own element for display; this hidden one is the detection
  // source, so it is wired here and kept out of the layout.
  //
  // AND IT HAS TO BE PLAYED EXPLICITLY.
  //
  // The element carries `autoPlay`, but it is also `display: none`, and Chrome
  // does not autoplay an element it is not rendering. So it sat at
  // `paused: true` with `currentTime` frozen at 0 for the whole meeting —
  // while `readyState` was 4 and `videoWidth` 640, which is everything the
  // guard in `detect()` checks before handing the frame to MediaPipe.
  //
  // That is the worst shape a bug can take: nothing errored. MediaPipe ran at
  // 10 FPS on the SAME first frame for the entire call and truthfully reported
  // no hands, whatever the signer did. The hearing user's captions were empty
  // because the signs were never captured at all.
  //
  // play() needs no user gesture here because the element is muted.
  useEffect(() => {
    const video = localVideoRef.current;
    if (!video || !localStream) return;

    video.srcObject = localStream;
    video.play().catch((cause) => {
      // AbortError is routine — a replaced srcObject or a remount interrupts
      // the pending play(). Anything else means hand tracking is about to run
      // on a frozen frame, which is exactly the silence that hid this bug, so
      // it gets said out loud.
      if (cause?.name !== 'AbortError') {
        console.warn('The hand-tracking video would not play', cause);
      }
    });
  }, [localStream]);

  // --- captions ------------------------------------------------------------
  // ONE store for both sources and both participants. Every caption — mine and
  // theirs, sign and speech — arrives through the socket and is applied here by
  // segment id. Each side used to render its own words from local state and the
  // other person's from the socket, which is why the two screens disagreed
  // about what had been said.
  const { captions, applyCaption } = useCaptionStore();

  // DECLARED BEFORE useSignSocket, deliberately. `const` bindings sit in the
  // temporal dead zone until their initialiser runs, so passing this to the
  // hook above its own declaration threw "Cannot access 'applyAndRecord' before
  // initialization" and took the whole screen to the error boundary.
  const applyAndRecord = useCallback(
    (event) => {
      lastReceivedRef.current = `${event.source}/${event.is_final ? 'final' : 'interim'}: ${(event.text ?? '').slice(0, 28)}`;
      applyCaption(event);
    },
    [applyCaption],
  );

  /**
   * Room state, from the socket handshake or a live broadcast.
   *
   * THE FIX FOR BUG 3. Interview Mode wrote the state to the meeting row and
   * returned it to the HOST; nothing told anyone else, and this component
   * fetched the meeting once on mount and never read it again. So
   * `interviewOn` stayed false on the participant's screen and none of the
   * enforcement below ever ran — the feature worked only for the host, the one
   * person it does not apply to.
   *
   * Merged into the existing record rather than replacing it, because the
   * announcement carries only the room-level fields.
   *
   * DECLARED ABOVE useSignSocket deliberately: `const` bindings sit in the
   * temporal dead zone until their initialiser runs, so passing this to the
   * hook above its own declaration would throw during render.
   */
  const applyRoomState = useCallback((state) => {
    if (!state) return;
    setMeeting((current) => {
      if (!current) return current;
      const next = {
        ...current,
        is_interview_mode:
          // One-way: once on it stays on, so a stale `false` from a race
          // between the handshake and a live broadcast cannot turn it off.
          current.is_interview_mode || Boolean(state.is_interview_mode),
        interview_mode_started_at:
          state.interview_mode_started_at ?? current.interview_mode_started_at,
      };
      if (state.ended_at) next.ended_at = state.ended_at;
      return next;
    });
  }, []);

  const handleMeetingEnded = useCallback(
    (message) => {
      setMeetingEndedBy(message?.ended_by?.name ?? null);
    },
    [],
  );

  /**
   * An Interview Mode violation, pushed to the host in real time.
   *
   * Pushed rather than polled: the host acts on this by talking to the
   * candidate, so a five-second poll is five seconds of a conversation already
   * going wrong. Only the host's socket receives it.
   *
   * `blur` and `hidden` are departures and increment the count; `return` is the
   * recovery and carries the duration, so it updates the total without counting
   * as another offence — the same rule the server's rollup uses.
   */
  const handleFocusEvent = useCallback(
    (event) => {
      if (!event) return;
      const isDeparture = event.event_type === 'blur' || event.event_type === 'hidden';

      setViolations((current) => {
        const existing = current[event.user_id] ?? {
          userName: event.user_name,
          awayCount: 0,
          totalAwayMs: 0,
        };
        return {
          ...current,
          [event.user_id]: {
            userName: event.user_name ?? existing.userName,
            awayCount: existing.awayCount + (isDeparture ? 1 : 0),
            totalAwayMs: existing.totalAwayMs + (event.duration_away_ms ?? 0),
          },
        };
      });

      if (isDeparture) {
        // The server decides; the host is told what it decided rather than
        // being left to count departures themselves.
        const message =
          event.action === 'removed'
            ? `${event.user_name} was removed from the interview — left the meeting screen ${event.departures} times`
            : event.action === 'warned'
              ? `${event.user_name} left the meeting screen — warned`
              : `${event.user_name} left the meeting screen`;
        toastRef.current?.show(message, {
          icon: event.action === 'removed' ? 'person_remove' : 'warning',
          durationMs: event.action === 'removed' ? 8000 : 4000,
        });
      } else if (event.duration_away_ms != null) {
        toastRef.current?.show(
          `${event.user_name} came back after ${formatElapsed(
            Math.round(event.duration_away_ms / 1000),
          )}`,
          { icon: 'policy' },
        );
      }
    },
    [],
  );

  const {
    status: signSocketStatus,
    prediction,
    serverError: signError,
    modelInfo,
    dynamicModelInfo,
    islModelInfo,
    sendLandmarks,
    sendCaption,
  } = useSignSocket({
    meetingCode: code,
    enabled: Boolean(meeting),
    onCaption: applyAndRecord,
    onRoomState: applyRoomState,
    onMeetingEnded: handleMeetingEnded,
    onFocusEvent: handleFocusEvent,
  });

  // Producers hand captions to the socket. They never touch the store directly:
  // the round trip through the server is what guarantees both participants see
  // identical text, and it is also what persists it.
  const emitCaption = useCallback(
    (caption) => {
      lastSentRef2.current = `${caption.source}/${caption.isFinal ? 'final' : 'interim'}: ${caption.text.slice(0, 28)}`;
      sendCaption(caption);
    },
    [sendCaption],
  );

  // A final caption means a new row exists server-side. Refresh the transcript
  // then — and only then — so the panel matches the database without polling.
  const lastFinalRef = useRef(0);
  useEffect(() => {
    const finals = captions.filter((caption) => caption.isFinal).length;
    if (finals !== lastFinalRef.current) {
      lastFinalRef.current = finals;
      if (meeting?.id) refreshTranscript(meeting.id);
    }
  }, [captions, meeting?.id, refreshTranscript]);

  // --- hand tracking -------------------------------------------------------
  // One hand for ASL fingerspelling, two for ISL fingerspelling and word signs.
  // Their features have a slot per hand, and tracking only one would leave half
  // of every input vector zero.
  const { detect, error: landmarkerError, isReady } = useHandLandmarker({
    numHands: recognitionMode === 'static' ? 1 : 2,
    enabled: signRecognitionOn,
  });

  useEffect(() => {
    // Gated on the camera as well as the sign toggle. Tracking a released
    // camera is what left a frozen skeleton drawn over a black tile.
    if (!localStream || !isReady || !signRecognitionOn || !cameraOn) {
      // Clear any skeleton left from the last frame we processed, so the
      // overlay cannot outlive the video it was drawn from.
      setLandmarks([]);
      return undefined;
    }

    let active = true;
    const tick = () => {
      if (!active) return;

      const result = detect(localVideoRef.current);
      const now = performance.now();
      const shouldSend = now - lastSentRef.current >= SEND_INTERVAL_MS;

      if (result?.landmarks?.length) {
        setLandmarks(result.landmarks);
        if (shouldSend) {
          lastSentRef.current = now;
          sendLandmarks(toWireFormat(result), recognitionMode);
        }
      } else {
        setLandmarks([]);
        if (shouldSend) {
          lastSentRef.current = now;
          // Empty frames matter: they drive the neutral reset that closes a
          // word when the signer lowers their hands, and in dynamic mode they
          // mark the boundary between two signs.
          sendLandmarks([], recognitionMode);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [localStream, isReady, signRecognitionOn, cameraOn, detect, sendLandmarks, recognitionMode]);

  // --- producing sign captions ---------------------------------------------
  // Segmentation lives in useSignCaptions, not in a server-side smoother and
  // not in this component. The old code committed a word every time a 2.5 s
  // cooldown lapsed, which is why one held pose produced "warm warm warm" — a
  // timer cannot tell "still signing this" from "signed it again". The hook
  // watches hand MOTION, commits once per movement, and refuses to repeat a
  // token until the hands have returned to rest.
  const signCaptions = useSignCaptions({
    enabled: Boolean(signRecognitionOn && cameraOn && meeting),
    mode: recognitionMode,
    prediction,
    landmarks,
    onCaption: emitCaption,
  });

  // --- producing speech captions -------------------------------------------
  // Keyed to ONE thing: is my microphone unmuted. Not to a panel toggle.
  //
  // Recognition used to be gated on a `speechOn` flag that defaulted to off, so
  // a participant who never found that toggle produced no captions at all —
  // while the panel still said "listening", because that reported the
  // recogniser object's state rather than whether any audio reached it. That is
  // the reported "spoke and nothing happened".
  const speech = useSpeechCaptions({
    enabled: Boolean(micOn && meeting),
    engine: preferences.speechEngine,
    language: preferences.speechLanguage,
    meetingCode: code,
    onCaption: emitCaption,
  });

  // --- the call ------------------------------------------------------------
  const {
    remoteStream,
    connectionState,
    peer,
    error: rtcError,
    hangUp,
    replaceVideoTrack,
    replaceAudioTrack,
    addScreenTrack,
    removeScreenSender,
    remoteScreenStream,
    remotePresenter,
    sendSignal,
  } = useWebRTC({
    meetingCode: code,
    localStream,
    enabled: Boolean(localStream && meeting),
  });

  // --- controls ------------------------------------------------------------

  const toggleMic = useCallback(() => {
    setMicOn((current) => {
      const next = !current;
      // Disabling the track rather than removing it: the peer connection stays
      // negotiated, so unmuting is instant instead of triggering a fresh
      // offer/answer round trip.
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, [localStream]);

  /**
   * Turn the camera genuinely on or off.
   *
   * THE BUG THIS FIXES
   * ------------------
   * This used to set `track.enabled = false`, which keeps the hardware open,
   * keeps the indicator light on, and merely transmits black frames. Two things
   * went wrong as a result:
   *
   *   * the tile went black while the camera was demonstrably still running, so
   *     the button said "Turn camera on" about a camera that was on;
   *   * the detection loop early-returned on !cameraOn WITHOUT clearing
   *     `landmarks`, so the last hand skeleton stayed in React state and kept
   *     drawing over the black tile forever. That is exactly the reported
   *     "both tiles black, yet the skeleton is drawn".
   *
   * Off now STOPS the track and releases the device. On re-acquires it and swaps
   * it into the existing peer connection with replaceTrack, so the remote side
   * sees the stream resume without a renegotiation.
   */
  const toggleCamera = useCallback(async () => {
    if (cameraOn) {
      // Clear the overlay FIRST, or a stale skeleton is visible for the frame
      // or two before React re-renders without it.
      setLandmarks([]);

      localStream?.getVideoTracks().forEach((track) => {
        track.stop();
        localStream.removeTrack(track);
      });
      await replaceVideoTrack(null);
      setCameraOn(false);
      return;
    }

    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: cameraId
          ? { deviceId: { exact: cameraId }, width: { ideal: 640 }, height: { ideal: 480 } }
          : { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });

      const [track] = fresh.getVideoTracks();
      if (!track) throw new Error('No video track');

      localStream?.addTrack(track);
      await replaceVideoTrack(track);
      setCameraOn(true);
    } catch (cause) {
      setCameraError(
        cause?.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow it in your browser, then try again.'
          : `Could not restart the camera: ${cause?.message ?? cause}`,
      );
    }
  }, [cameraOn, cameraId, localStream, replaceVideoTrack]);

  /**
   * Swap one device mid-call.
   *
   * The new track has to go three places, and missing any one of them is a
   * distinct bug: into the local MediaStream (so MediaPipe and the speech
   * engine read it), into the peer sender (so the other person gets it), and
   * into session storage (so a reload keeps it).
   */
  const changeDevice = useCallback(
    async (kind, deviceId) => {
      if (kind === 'speaker') {
        setSpeakerId(deviceId);
        saveDevicePreferences({ micId, cameraId, speakerId: deviceId, willSign: signRecognitionOn });
        return;
      }

      const isAudio = kind === 'mic';
      if (isAudio) setMicId(deviceId);
      else setCameraId(deviceId);
      saveDevicePreferences({
        micId: isAudio ? deviceId : micId,
        cameraId: isAudio ? cameraId : deviceId,
        speakerId,
        willSign: signRecognitionOn,
      });

      if (!localStream) return;
      // The camera being off is not a reason to open it: the user changed which
      // camera they will use, not whether it is on.
      if (!isAudio && !cameraOn) return;

      try {
        const fresh = await navigator.mediaDevices.getUserMedia(
          isAudio
            ? {
                audio: {
                  deviceId: { exact: deviceId },
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
              }
            : {
                video: {
                  deviceId: { exact: deviceId },
                  width: { ideal: 640 },
                  height: { ideal: 480 },
                },
              },
        );

        const [track] = isAudio ? fresh.getAudioTracks() : fresh.getVideoTracks();
        if (!track) return;

        const old = isAudio ? localStream.getAudioTracks() : localStream.getVideoTracks();
        old.forEach((existing) => {
          existing.stop();
          localStream.removeTrack(existing);
        });

        track.enabled = isAudio ? micOn : true;
        localStream.addTrack(track);

        if (isAudio) await replaceAudioTrack(track);
        else await replaceVideoTrack(track);
      } catch (cause) {
        setCameraError(
          `Could not switch ${isAudio ? 'microphone' : 'camera'}: ${cause?.message ?? cause}`,
        );
      }
    },
    [
      micId, cameraId, speakerId, signRecognitionOn, localStream, cameraOn, micOn,
      replaceAudioTrack, replaceVideoTrack,
    ],
  );

  const leaveMeeting = useCallback(
    async ({ endForEveryone = false } = {}) => {
      hangUp();
      try {
        if (endForEveryone) await meetingsApi.end(code);
        else await meetingsApi.leave(code);
      } catch {
        // Leaving is best-effort; the user is going regardless.
      }
      navigate(`/ended/${code}`, { replace: true, state: { endedByHost: endForEveryone } });
    },
    [code, hangUp, navigate],
  );

  // --- interview mode ------------------------------------------------------
  // The mode lives on the MEETING RECORD, not in local state, so a participant
  // who reloads or reconnects arrives already subject to it. Reloading must not
  // be a way out.
  const isHost = Boolean(meeting?.host?.id && user?.id && meeting.host.id === user.id);
  const interviewOn = Boolean(meeting?.is_interview_mode);

  /**
   * Report leaving the meeting screen, and act on what the server says.
   *
   * The server owns the count. It replies with a verdict — `warned` on a first
   * departure, `removed` on the one that ends the interview — because that
   * decision must not be a browser's to make: a client that could decline to
   * count its own departures could sit outside the meeting indefinitely.
   */
  const handleViolation = useCallback(
    ({ type, durationMs }) => {
      if (!interviewOn) return;
      meetingsApi
        .logFocusEvent(code, type, durationMs)
        .then((event) => {
          if (event?.action === 'removed') setRemovedFromInterview(true);
          else if (event?.action === 'warned') setInterviewVerdict('warned');
        })
        .catch(() => {
          // Best effort. A failed log must never interrupt the meeting itself.
        });
    },
    [code, interviewOn],
  );

  const interview = useInterviewMode({
    enabled: interviewOn,
    verdict: removedFromInterview ? 'removed' : interviewVerdict,
    isHost,
    onViolation: handleViolation,
    maxViolations: MAX_VIOLATIONS,
  });

  /**
   * Switch Interview Mode ON. One-way, and host only.
   *
   * It cannot be switched off: an interview that can be un-invigilated
   * mid-session is not an interview, and a candidate who saw the mode turn off
   * would reasonably assume the recording had stopped. The server rejects
   * `enabled: false` with 409. The only way out is ending the meeting.
   */
  const startInterviewMode = useCallback(async () => {
    if (!isHost || interviewOn) return;
    try {
      const updated = await meetingsApi.setInterviewMode(code, true);
      setMeeting(updated);
      toast.show('Interview mode is on for everyone', { icon: 'policy' });
    } catch (cause) {
      toast.show(cause?.message ?? 'Could not start interview mode', { icon: 'error' });
    }
  }, [code, interviewOn, isHost, toast]);

  /**
   * Removed from the interview. Their meeting is over.
   *
   * The teardown has to be as complete as the one for a meeting ending: the
   * keyboard lock released and fullscreen left, or they are stranded in a
   * locked page with browser shortcuts still captured and no meeting behind
   * it. Rejoining is refused by the server, so the ended page is the end of it.
   */
  useEffect(() => {
    if (!removedFromInterview) return;

    let cancelled = false;
    (async () => {
      try {
        await interview.releaseEnforcement?.();
      } catch {
        // Nothing to release, or the browser refused. Leaving anyway.
      }
      hangUp();
      try {
        await meetingsApi.leave(code);
      } catch {
        // Already marked removed server-side; leaving is a courtesy.
      }
      if (!cancelled) {
        navigate(`/ended/${code}`, {
          replace: true,
          state: {
            removed: true,
            reason:
              'You were removed from this interview for leaving the meeting '
              + 'screen more than once.',
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `interview` changes identity on every violation; re-running would
    // navigate twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removedFromInterview, code, hangUp, navigate]);

  /**
   * The meeting ended, announced by the server.
   *
   * This is the ONLY normal way out of Interview Mode, so the teardown has to
   * be complete: release the keyboard lock, leave fullscreen, and leave the
   * page. Without it a candidate stays locked into a meeting that no longer
   * exists, with browser shortcuts still captured.
   */
  useEffect(() => {
    if (!meetingEndedBy) return;

    let cancelled = false;
    (async () => {
      try {
        await interview.releaseEnforcement?.();
      } catch {
        // Nothing to release, or the browser refused. Leaving anyway.
      }
      hangUp();
      if (!cancelled) {
        navigate(`/ended/${code}`, {
          replace: true,
          state: { endedByHost: true, endedBy: meetingEndedBy },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `interview` is intentionally omitted: it changes identity on every
    // violation, and re-running this effect would navigate twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingEndedBy, code, hangUp, navigate]);

  // --- screen sharing ------------------------------------------------------
  const screenShare = useScreenShare({ addScreenTrack, removeScreenSender, sendSignal });

  const handlePresent = useCallback(async () => {
    if (screenShare.isPresenting) {
      screenShare.stopPresenting();
      return;
    }

    // Someone else has the stage. Ask rather than silently taking it.
    if (remotePresenter) {
      const takeOver = window.confirm(
        `${remotePresenter.name} is presenting. Take over presenting?`,
      );
      if (!takeOver) return;
    }

    // Opening the screen picker takes focus away from the page, which the
    // interview-mode detector would otherwise record as a violation. The picker
    // is the app's own dialog, so it is suppressed for its duration.
    interview.suppressBriefly?.(4000);
    await screenShare.startPresenting();
  }, [screenShare, remotePresenter, interview]);

  const screenStream = screenShare.isPresenting
    ? screenShare.localScreenStream
    : remoteScreenStream;

  // --- fullscreen ----------------------------------------------------------
  const toggleFullscreen = useCallback(() => {
    const element = document.documentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      element.requestFullscreen?.().catch(() => {
        toast.show('Your browser would not allow full screen', { icon: 'error' });
      });
    }
  }, [toast]);

  // --- who is active -------------------------------------------------------
  /**
   * Whose tile gets the blue ring, and who shows the signing hand.
   *
   * Derived from recent CAPTIONS rather than from an audio level meter. A level
   * meter on the remote stream would show the ring for any noise — a door, a
   * cough — whereas a caption means the system actually recognised something
   * from that person. For a captioning product, "produced a caption recently" is
   * the honest definition of active.
   *
   * It also gives sign activity for free, which no audio meter could.
   */
  const [activity, setActivity] = useState({});
  useEffect(() => {
    const newest = captions[captions.length - 1];
    if (!newest?.speakerName) return undefined;

    setActivity((current) => ({
      ...current,
      [newest.speakerName]: { source: newest.source, at: Date.now() },
    }));

    const timer = setTimeout(() => {
      setActivity((current) => {
        const entry = current[newest.speakerName];
        if (!entry || Date.now() - entry.at < ACTIVITY_HOLD_MS) return current;
        const next = { ...current };
        delete next[newest.speakerName];
        return next;
      });
    }, ACTIVITY_HOLD_MS + 50);

    return () => clearTimeout(timer);
  }, [captions]);

  const localName = user?.name ?? 'You';
  const remoteName = peer?.name ?? null;

  const localActivity = activity[localName];
  const remoteActivity = remoteName ? activity[remoteName] : null;

  /**
   * Show or hide the caption area — from the button and the shortcut alike.
   *
   * Turning captions off REMOVES the strip entirely (the stage reclaims the
   * 140px), so there is nothing left on screen to explain where the captions
   * went. On a deaf-accessibility tool that is the whole translation channel
   * disappearing in silence, and it is exactly how a meeting was spent with
   * the hearing participant seeing no signs at all while the transcript
   * filled up normally behind them.
   *
   * So switching them OFF says so, and says how to get them back. Switching
   * them on needs no announcement: the captions reappearing is the feedback.
   */
  const toggleCaptions = useCallback(() => {
    setCaptionsVisible((value) => {
      if (value) {
        toastRef.current?.show('Captions hidden — press Ctrl/Cmd+Shift+C to show them again', {
          icon: 'closed_caption_disabled',
          durationMs: 5000,
        });
      }
      return !value;
    });
  }, []);

  // --- keyboard shortcuts --------------------------------------------------
  // Ctrl/Cmd+D microphone, Ctrl/Cmd+E camera, Ctrl/Cmd+Shift+C captions.
  // Skipped while focus is in a text field, or typing a meeting code would
  // toggle the mic.
  useEffect(() => {
    const handler = (event) => {
      // The rule lives in utils/shortcuts.js, where it is unit-tested.
      const action = shortcutFor(event);
      if (!action) return;

      event.preventDefault();
      if (action === 'mic') toggleMic();
      else if (action === 'camera') toggleCamera();
      else if (action === 'captions') toggleCaptions();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleCamera, toggleMic, toggleCaptions]);

  // --- toasts --------------------------------------------------------------
  // Keyed on the peer's NAME, not the peer object: useWebRTC produces a new
  // object on reconnect, which would announce the same person joining twice.
  const lastPeerNameRef = useRef(null);
  useEffect(() => {
    const name = peer?.name ?? null;
    if (name === lastPeerNameRef.current) return;

    if (name) toast.show(`${name} joined the meeting`, { icon: 'person_add' });
    else if (lastPeerNameRef.current) {
      toast.show(`${lastPeerNameRef.current} left the meeting`, { icon: 'person_remove' });
    }
    lastPeerNameRef.current = name;
  }, [peer?.name, toast]);

  const lastPresenterRef = useRef(null);
  useEffect(() => {
    const name = remotePresenter?.name ?? null;
    if (name === lastPresenterRef.current) return;
    if (name) toast.show(`${name} started presenting`, { icon: 'present_to_all' });
    lastPresenterRef.current = name;
  }, [remotePresenter?.name, toast]);

  // --- start on a mode the server can actually serve ------------------------
  // Defaulting to ASL when only the ISL word model is trained would show an
  // empty panel and look broken, so the first usable mode is selected once the
  // server reports what it has. Word signs are preferred: that is the model a
  // fluent signer will use.
  useEffect(() => {
    const available = {
      dynamic: dynamicModelInfo?.loaded,
      isl: islModelInfo?.loaded,
      static: modelInfo?.loaded,
    };
    if (available[recognitionMode] || Object.values(available).every((v) => v === undefined)) {
      return;
    }
    const usable = ['dynamic', 'isl', 'static'].find((name) => available[name]);
    if (usable) updatePreferences({ recognitionMode: usable });
  }, [modelInfo, islModelInfo, dynamicModelInfo, recognitionMode, updatePreferences]);

  // Has the server told us about its models yet? The socket reports all three
  // in its `connected` message, so until then every one of them is null — which
  // is NOT the same as "none is loaded", and must not be rendered as if it were.
  const signModelsKnown =
    modelInfo != null || islModelInfo != null || dynamicModelInfo != null;
  const signAvailable = Boolean(
    modelInfo?.loaded || islModelInfo?.loaded || dynamicModelInfo?.loaded,
  );

  const errorBanner = cameraError || rtcError || landmarkerError || screenShare.error
    || signError?.message;

  const panelTitle = useMemo(
    () => ({ details: 'Meeting details', people: 'People', transcript: 'Transcript' })[openPanel],
    [openPanel],
  );

  // ---------------------------------------------------------------- render --

  return (
    <div className="on-dark flex h-screen flex-col overflow-hidden bg-dark-bg">
      {/* The hidden detection source. MediaPipe needs a <video> it can read
          frames from; the visible tile has its own element, and sharing one
          between the two would couple the detection loop to the tile's layout. */}
      <video ref={localVideoRef} autoPlay playsInline muted className="hidden" />

      {/* Blocks the meeting until acknowledged. Its button is also the user
          gesture the browser requires before fullscreen is allowed, which is
          why enforcement starts on the click rather than on mount. */}
      {interviewOn && !isHost && !interview.acknowledged ? (
        <InterviewModeDialog
          hostName={meeting?.host?.name}
          capabilities={interview.capabilities}
          onAcknowledge={interview.acknowledge}
        />
      ) : null}

      {/* Covers the meeting while they are away or out of fullscreen, so
          leaving costs them the view rather than being free. */}
      {interview.mustBlock ? (
        <InterviewModeOverlay
          awayCount={interview.awayCount}
          maxViolations={MAX_VIOLATIONS}
          isFullscreen={interview.isFullscreen}
          isFinalWarning={interview.isFinalWarning}
          onReturn={interview.reEnterFullscreen}
        />
      ) : null}

      {debugEnabled ? (
        <DebugOverlay
          micTrack={localStream?.getAudioTracks()[0]?.readyState ?? 'none'}
          cameraTrack={localStream?.getVideoTracks()[0]?.readyState ?? 'none'}
          speech={{
            engineActive: speech.engineActive,
            state: speech.state,
            lastInterim: speech.lastInterim,
            error: speech.error,
          }}
          sign={signCaptions.debug}
          socketStatus={signSocketStatus}
          lastSent={lastSentRef2.current}
          lastReceived={lastReceivedRef.current}
        />
      ) : null}

      {errorBanner ? (
        <p
          role="alert"
          className="flex shrink-0 items-center gap-2 bg-dark-danger/15 px-4 py-2 text-sm text-dark-danger"
        >
          <Icon name="error" size={18} />
          <span className="min-w-0">{errorBanner}</span>
        </p>
      ) : null}

      {/* Presenter bar. Only the presenter sees it; everyone else sees the
          shared screen itself, which needs no announcement. */}
      {screenShare.isPresenting ? (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 bg-dark-accent/15 px-4 py-2"
        >
          <span className="text-sm font-medium text-dark-accent">
            You are presenting to everyone
          </span>
          <button
            type="button"
            onClick={screenShare.stopPresenting}
            className="rounded-full border border-dark-danger px-3 py-1 text-sm text-dark-danger
                       transition-colors hover:bg-dark-danger/10"
          >
            Stop presenting
          </button>
        </div>
      ) : null}

      {/* stage + panel, side by side so the stage genuinely shrinks */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Stage
            localStream={localStream}
            localName={localName}
            localMuted={!micOn}
            localCameraOff={!cameraOn}
            localSpeaking={localActivity?.source === 'speech'}
            localSigning={localActivity?.source === 'sign'}
            remoteStream={remoteStream}
            remoteName={remoteName}
            remoteMuted={false}
            remoteCameraOff={false}
            remoteSpeaking={remoteActivity?.source === 'speech'}
            remoteSigning={remoteActivity?.source === 'sign'}
            screenStream={screenStream}
            presenterName={remotePresenter?.name}
            isPresentingLocally={screenShare.isPresenting}
            interviewOn={interviewOn}
            localOverlay={
              signRecognitionOn && cameraOn ? (
                <>
                  {preferences.showHandOverlay ? (
                    <HandOverlayCanvas landmarks={landmarks} mirrored />
                  ) : null}
                  <SignPill
                    pending={signCaptions.pending}
                    prediction={prediction}
                    onUndo={signCaptions.undoLast}
                    onClear={signCaptions.clearCurrent}
                  />
                </>
              ) : null
            }
          />

          {/* The caption area shows what OTHER people produced, never your
              own words (Bug 2). On the hearing user's screen that leaves the
              deaf user's sign captions; on the deaf user's screen it leaves
              the hearing user's speech captions — one rule covering both, and
              it still holds if a participant uses the other mode.

              Your own words are not lost: the signer sees them live on their
              own tile's detection pill, and BOTH sides of the conversation
              remain in the live transcript panel and in the saved transcript,
              which are the record. The server still broadcasts every caption
              to everyone, so nothing about persistence changes. */}
          <CaptionRail
            captions={captions}
            size={preferences.captionSize}
            visible={captionsVisible}
            excludeSpeakerId={user?.id ?? null}
          />
        </div>

        <SidePanel
          open={openPanel !== null}
          title={panelTitle ?? ''}
          onClose={() => setOpenPanel(null)}
        >
          {openPanel === 'details' ? <DetailsPanel meeting={meeting} code={code} /> : null}
          {openPanel === 'people' ? (
            <PeoplePanel
              localName={localName}
              localMuted={!micOn}
              localCameraOff={!cameraOn}
              localSigning={signRecognitionOn}
              remoteName={remoteName}
              remoteStream={remoteStream}
              remoteSigning={remoteActivity?.source === 'sign'}
              connectionState={connectionState}
              // Host-only: nobody else is sent focus events, so this is empty
              // for a participant and the panel renders nothing extra.
              violations={violations}
              interviewOn={interviewOn}
            />
          ) : null}
          {openPanel === 'transcript' ? (
            <LiveTranscriptPanel
              lines={transcriptLines}
              loading={transcriptLoading}
              error={transcriptError}
              onRefresh={() => refreshTranscript(meeting?.id)}
              onDownload={async (format) => {
                try {
                  const filename = await transcriptsApi.download(meeting.id, format);
                  toast.show(`Saved ${filename}`, { icon: 'download_done' });
                } catch (cause) {
                  toast.show(cause?.message ?? 'Could not download', { icon: 'error' });
                }
              }}
            />
          ) : null}
        </SidePanel>
      </div>

      <ControlBar
        micOn={micOn}
        cameraOn={cameraOn}
        captionsOn={captionsVisible}
        signOn={signRecognitionOn}
        signAvailable={signAvailable}
        signModelsKnown={signModelsKnown}
        isPresenting={screenShare.isPresenting}
        someoneElseIsPresenting={Boolean(remotePresenter)}
        openPanel={openPanel}
        isHost={isHost}
        interviewOn={interviewOn}
        meetingCode={code}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
        onToggleCaptions={toggleCaptions}
        onToggleSign={() => setSignRecognitionOn((value) => !value)}
        onPresent={handlePresent}
        onOpenPanel={(panel) => setOpenPanel((current) => (current === panel ? null : panel))}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleFullscreen={toggleFullscreen}
        onStartInterviewMode={startInterviewMode}
        canLeave={!interviewOn || isHost}
        onLeave={() => leaveMeeting()}
        onEndForEveryone={() => leaveMeeting({ endForEveryone: true })}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        preferences={preferences}
        onChange={updatePreferences}
        microphones={microphones}
        speakers={speakers}
        cameras={cameras}
        micId={micId}
        speakerId={speakerId}
        cameraId={cameraId}
        onMicChange={(value) => changeDevice('mic', value)}
        onSpeakerChange={(value) => changeDevice('speaker', value)}
        onCameraChange={(value) => changeDevice('camera', value)}
        modelInfo={modelInfo}
        islModelInfo={islModelInfo}
        dynamicModelInfo={dynamicModelInfo}
        speechState={speech.state}
        speechEngineActive={speech.engineActive}
      />
    </div>
  );
}

/**
 * What is being detected right now, on your own tile, with undo and clear.
 *
 * Only you see this. It exists so a signer can correct their own caption BEFORE
 * it is finalised and sent — the alternative is noticing a wrong word after it
 * has already appeared on the other person's screen and been written to the
 * transcript, where nothing in the interface can take it back.
 */
function SignPill({ pending, prediction, onUndo, onClear }) {
  const label = pending || prediction?.label || null;
  if (!label) return null;

  const confidence = prediction?.confidence;

  return (
    <div className="absolute left-2 top-2 z-10 flex max-w-[85%] items-center gap-1 rounded-full
                    bg-black/65 py-1 pl-3 pr-1 backdrop-blur">
      <span className="min-w-0 truncate text-xs font-medium text-dark-text">
        {label}
        {confidence != null ? (
          <span className="ml-1 text-dark-muted">{Math.round(confidence * 100)}%</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onUndo}
        aria-label="Undo the last recognised word"
        title="Undo last"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-dark-muted
                   transition-colors hover:bg-white/15 hover:text-dark-text"
      >
        <Icon name="undo" size={14} />
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear what has been recognised so far"
        title="Clear"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-dark-muted
                   transition-colors hover:bg-white/15 hover:text-dark-text"
      >
        <Icon name="backspace" size={14} />
      </button>
    </div>
  );
}
