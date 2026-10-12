import { useCallback, useEffect, useRef, useState } from 'react';

import { CAPTIONS, SIGN } from '../config/recognition';
import { createInterimThrottle } from '../utils/interimThrottle';
import { newSegmentId } from './useCaptionStore';

/**
 * Turns a stream of per-frame predictions into committed sign captions.
 *
 * WHY THIS REPLACED THE SERVER-SIDE SMOOTHER
 * ------------------------------------------
 * The old design classified EVERY sliding window and guarded against repeats
 * with a 2.5 s time-based cooldown. That produced the reported
 * "warm warm fast we we we we old warm warm warm": the signer held one pose,
 * the classifier answered three times a second, and every time the cooldown
 * lapsed the same word was committed again. A timer cannot tell "still signing
 * the same thing" from "signed it again".
 *
 * Movement can. A word sign is a trajectory: the hands leave rest, travel, and
 * come back. So this tracks motion energy and commits **once per movement
 * segment**, then refuses to commit that token again until the hands have
 * actually returned to rest.
 *
 * WHAT SILENCE LOOKS LIKE
 * ----------------------
 * Hands resting or out of frame produce nothing at all. Not a low-confidence
 * guess, not a neutral label — nothing. A model with 40 classes will always
 * return one of them, so refusing to ask is the only way to get silence.
 */
export function useSignCaptions({
  enabled = false,
  mode = 'dynamic',
  prediction,
  landmarks,
  onCaption,
} = {}) {
  const onCaptionRef = useRef(onCaption);
  useEffect(() => {
    onCaptionRef.current = onCaption;
  }, [onCaption]);

  // --- segment state -------------------------------------------------------
  const segmentRef = useRef(null);
  const wordsRef = useRef([]);
  const lastActivityRef = useRef(0);

  // --- movement state ------------------------------------------------------
  const previousLandmarksRef = useRef(null);
  const motionRef = useRef(0);
  const stillFramesRef = useRef(0);
  const absentFramesRef = useRef(0);
  const inMovementRef = useRef(false);
  // The best prediction seen during the current movement, so the sign is
  // judged on its clearest frame rather than whichever frame happened to be
  // last when the hands stopped.
  const bestRef = useRef(null);
  const lastCommittedRef = useRef(null);
  const restedSinceCommitRef = useRef(true);

  // --- letters -------------------------------------------------------------
  const stableLabelRef = useRef(null);
  const stableCountRef = useRef(0);
  // Frames since movement was last seen. A hand parked in frame must stop
  // producing captions, and motion is the only thing that distinguishes
  // "arrived in this shape" from "has been sitting in it" — see the note on
  // MOTION_LOOKBACK_FRAMES in the config.
  const framesSinceMotionRef = useRef(Number.MAX_SAFE_INTEGER);

  const [debug, setDebug] = useState({
    motion: 0,
    phase: 'idle',
    openSegment: null,
    committed: 0,
    rejected: 0,
  });
  const countsRef = useRef({ committed: 0, rejected: 0 });

  /** Mean per-landmark displacement since the previous frame. */
  const measureMotion = useCallback((hands) => {
    if (!hands?.length) {
      previousLandmarksRef.current = null;
      return null;
    }

    // Flatten to a comparable shape. Hand order from MediaPipe is not stable,
    // so only the total displacement is meaningful — not per-hand deltas.
    const flat = hands.flatMap((hand) => hand.map((p) => [p.x, p.y, p.z ?? 0]));
    const previous = previousLandmarksRef.current;
    previousLandmarksRef.current = flat;

    if (!previous || previous.length !== flat.length) return 0;

    let total = 0;
    for (let i = 0; i < flat.length; i += 1) {
      const dx = flat[i][0] - previous[i][0];
      const dy = flat[i][1] - previous[i][1];
      const dz = flat[i][2] - previous[i][2];
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return total / flat.length;
  }, []);

  /**
   * Put one caption on the wire. No throttling here — `emit` decides that.
   *
   * The segment id is read at SEND time, not when the update was queued, so a
   * coalesced interim always belongs to the segment that is still open.
   */
  const sendCaption = useCallback((text, isFinal) => {
    if (!segmentRef.current) segmentRef.current = newSegmentId('sg');
    onCaptionRef.current?.({
      segmentId: segmentRef.current,
      source: 'sign',
      text,
      isFinal,
      confidence: bestRef.current?.confidence ?? null,
    });
  }, []);

  /**
   * Interim updates are throttled; finals never are.
   *
   * Each committed word or letter is sent immediately as an interim update of
   * the open segment, so the other participant reads text while the signer is
   * still going rather than only after the pause. A fast fingerspeller can
   * commit several letters a second, and each one is a socket message
   * broadcast to the room, so the rate is capped at
   * CAPTIONS.SIGN_INTERIM_THROTTLE_MS (200 ms = 5/second).
   *
   * The throttle COALESCES rather than drops — see utils/interimThrottle.js.
   * An interim carries the full current text, so discarding the last one
   * before a pause would leave the other side a word short and make the final
   * appear to jump.
   */
  const throttleRef = useRef(null);
  if (throttleRef.current === null) {
    throttleRef.current = createInterimThrottle({
      intervalMs: CAPTIONS.SIGN_INTERIM_THROTTLE_MS,
      send: (text, isFinal) => sendCaption(text, isFinal),
    });
  }

  // Drop anything queued on unmount or when recognition is switched off, so a
  // pending interim cannot fire into a segment that no longer exists.
  useEffect(() => () => throttleRef.current?.reset(), []);

  const emit = useCallback(
    (text, isFinal) => {
      if (isFinal) throttleRef.current.flush(text);
      else throttleRef.current.push(text);
    },
    [],
  );

  const commitToken = useCallback(
    (token, confidence) => {
      if (SIGN.REQUIRE_REST_BEFORE_REPEAT && token === lastCommittedRef.current && !restedSinceCommitRef.current) {
        // Same token, and the hands have not been back to rest since it was
        // committed. This is still the same sign being held, not a new one.
        return false;
      }

      wordsRef.current = [...wordsRef.current, token];
      lastCommittedRef.current = token;
      restedSinceCommitRef.current = false;
      lastActivityRef.current = Date.now();
      countsRef.current.committed += 1;

      // Interim: the FULL current text of this segment, which the receiver
      // replaces its line with. Not a delta.
      emit(wordsRef.current.join(mode === 'dynamic' ? ' ' : ''), false);
      return true;
    },
    [emit, mode],
  );

  const closeSegment = useCallback(() => {
    if (!segmentRef.current || wordsRef.current.length === 0) {
      segmentRef.current = null;
      wordsRef.current = [];
      return;
    }
    emit(wordsRef.current.join(mode === 'dynamic' ? ' ' : ''), true);
    segmentRef.current = null;
    wordsRef.current = [];
    lastCommittedRef.current = null;
  }, [emit, mode]);

  // --- per-frame processing ------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    const motion = measureMotion(landmarks);

    // --- no hands ----------------------------------------------------------
    if (motion === null) {
      absentFramesRef.current += 1;
      if (absentFramesRef.current >= SIGN.ABSENT_FRAMES_TO_CLEAR) {
        inMovementRef.current = false;
        bestRef.current = null;
        stableLabelRef.current = null;
        stableCountRef.current = 0;
        restedSinceCommitRef.current = true;
      }
      setDebug((d) => ({ ...d, motion: 0, phase: 'no hands', ...countsRef.current }));
      return;
    }

    absentFramesRef.current = 0;
    motionRef.current = motion;

    const resting = motion < SIGN.REST_MOTION;
    const moving = motion > SIGN.MOVING_MOTION;

    if (resting) {
      stillFramesRef.current += 1;
      restedSinceCommitRef.current = true;
    } else {
      stillFramesRef.current = 0;
    }

    if (moving) {
      framesSinceMotionRef.current = 0;
    } else {
      framesSinceMotionRef.current += 1;
    }

    // Nothing is committed from a hand that has been parked. This is the gate
    // that makes "hands resting for 30 seconds produces zero captions" true;
    // confidence and stability both fail at it.
    const recentlyMoved = framesSinceMotionRef.current <= SIGN.MOTION_LOOKBACK_FRAMES;

    // --- is this prediction worth considering at all? ----------------------
    const label = prediction?.label;
    const confidence = prediction?.confidence ?? 0;
    const margin = prediction?.margin ?? 0;
    const isRealSign =
      label &&
      label !== 'nothing' &&
      !label.startsWith('__') &&
      confidence >= SIGN.MIN_CONFIDENCE &&
      margin >= SIGN.MIN_MARGIN;

    if (label && !isRealSign) countsRef.current.rejected += 1;

    if (mode === 'dynamic') {
      // --- word signs: one commit per movement segment --------------------
      if (moving) {
        inMovementRef.current = true;
        // Keep the clearest frame of this movement.
        if (isRealSign && (!bestRef.current || confidence > bestRef.current.confidence)) {
          bestRef.current = { label, confidence };
        }
      } else if (
        inMovementRef.current &&
        recentlyMoved &&
        stillFramesRef.current >= SIGN.REST_FRAMES_TO_END_SEGMENT
      ) {
        // The movement is over. Commit its best frame, once.
        inMovementRef.current = false;
        if (bestRef.current) {
          commitToken(bestRef.current.label, bestRef.current.confidence);
        }
        bestRef.current = null;
      }
    } else if (isRealSign && recentlyMoved) {
      // --- letters: commit on stability, but only after movement ----------
      if (label === stableLabelRef.current) {
        stableCountRef.current += 1;
      } else {
        stableLabelRef.current = label;
        stableCountRef.current = 1;
      }

      if (stableCountRef.current === SIGN.LETTER_STABLE_FRAMES) {
        bestRef.current = { label, confidence };
        commitToken(label, confidence);
      }
    } else {
      stableLabelRef.current = null;
      stableCountRef.current = 0;
    }

    setDebug({
      motion: Number(motion.toFixed(4)),
      phase: resting ? 'rest' : moving ? 'moving' : 'transition',
      parked: !recentlyMoved,
      openSegment: segmentRef.current,
      ...countsRef.current,
    });
  }, [enabled, prediction, landmarks, mode, measureMotion, commitToken]);

  // --- close the utterance after a quiet gap ------------------------------
  useEffect(() => {
    if (!enabled) return undefined;

    const timer = setInterval(() => {
      if (!segmentRef.current || wordsRef.current.length === 0) return;
      if (Date.now() - lastActivityRef.current >= SIGN.UTTERANCE_END_MS) {
        closeSegment();
      }
    }, 300);

    return () => clearInterval(timer);
  }, [enabled, closeSegment]);

  // --- finalise whatever is open when recognition is switched off ---------
  useEffect(() => {
    if (enabled) return undefined;
    return () => {
      // Do not silently discard words the signer already produced.
      if (segmentRef.current && wordsRef.current.length) closeSegment();
    };
  }, [enabled, closeSegment]);

  /** Local corrections, before the segment is finalised. */
  const undoLast = useCallback(() => {
    if (!wordsRef.current.length) return;
    wordsRef.current = wordsRef.current.slice(0, -1);
    lastCommittedRef.current = null;
    if (wordsRef.current.length) {
      emit(wordsRef.current.join(mode === 'dynamic' ? ' ' : ''), false);
    } else {
      emit('', false);
    }
  }, [emit, mode]);

  const clearCurrent = useCallback(() => {
    wordsRef.current = [];
    lastCommittedRef.current = null;
    emit('', false);
    segmentRef.current = null;
  }, [emit]);

  return {
    pending: wordsRef.current.join(mode === 'dynamic' ? ' ' : ''),
    debug,
    undoLast,
    clearCurrent,
  };
}
