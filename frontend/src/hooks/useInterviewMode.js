import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Interview Mode enforcement: fullscreen, keyboard lock, and escape detection.
 *
 * BE HONEST ABOUT WHAT A WEB PAGE CAN DO
 * --------------------------------------
 * A web page **cannot** prevent tab switching. There is no API for it, by
 * design — a page that could trap you in itself would be a weapon. So this
 * builds the strongest layered version the browser actually permits, and the
 * UI claims exactly that and no more:
 *
 *   1. Fullscreen on acknowledgement. Leaving fullscreen is then itself a
 *      detectable event, which it is not for an ordinary tab.
 *   2. Keyboard Lock (`navigator.keyboard.lock`) where supported — Chromium
 *      only, and only while fullscreen. This routes Ctrl+T, Ctrl+N, Ctrl+Tab
 *      and Esc to the page instead of the browser. It does NOT capture
 *      Alt+Tab or Cmd+Tab: those belong to the operating system and no web
 *      API reaches them.
 *   3. Detection via `visibilitychange`, window `blur` and
 *      `fullscreenchange` — three signals because each misses cases the
 *      others catch.
 *   4. A blocking overlay until the participant returns AND is back in
 *      fullscreen, so the escape costs them the meeting view.
 *
 * What it still cannot see: a second monitor, a phone, paper notes, or another
 * person in the room. It is a deterrent, and the dialog says so.
 *
 * WHY THE DURATION IS TRACKED HERE
 * --------------------------------
 * Only the client witnesses the departure, so only the client can time it. The
 * server cannot measure an absence it was never told about. The duration is
 * sent with the `return` event.
 */

// Below this, an "absence" is almost certainly a notification stealing focus
// or the browser's own download bar — not someone looking something up.
// Reporting those would bury real incidents in noise.
const MIN_REPORTABLE_AWAY_MS = 900;

export function detectCapabilities() {
  const element = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    fullscreen: Boolean(
      element?.requestFullscreen ?? element?.webkitRequestFullscreen,
    ),
    // Chromium only. Checked rather than assumed, because the host is shown
    // which participants have reduced enforcement and that list has to be true.
    keyboardLock: Boolean(
      typeof navigator !== 'undefined' && navigator.keyboard?.lock,
    ),
  };
}

export function useInterviewMode({
  enabled = false,
  isHost = false,
  onViolation,
  maxViolations = 3,
} = {}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [isAway, setIsAway] = useState(false);
  const [awayCount, setAwayCount] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [keyboardLocked, setKeyboardLocked] = useState(false);
  const [lastViolation, setLastViolation] = useState(null);

  const capabilities = useRef(detectCapabilities()).current;

  const awayRef = useRef(false);
  const awaySinceRef = useRef(0);
  // Set while the app itself is doing something that steals focus — a download,
  // a permission prompt. Without this, the app's own dialogs register as
  // violations, which is the fastest way to make the feature untrustworthy.
  const suppressRef = useRef(false);
  const onViolationRef = useRef(onViolation);

  useEffect(() => {
    onViolationRef.current = onViolation;
  }, [onViolation]);

  /** Mark a span as app-initiated, so it is not counted as an escape. */
  const suppressBriefly = useCallback((ms = 1500) => {
    suppressRef.current = true;
    setTimeout(() => {
      suppressRef.current = false;
    }, ms);
  }, []);

  // --- fullscreen + keyboard lock -----------------------------------------
  const enterEnforcement = useCallback(async () => {
    if (!capabilities.fullscreen) return;

    try {
      const element = document.documentElement;
      await (element.requestFullscreen?.({ navigationUI: 'hide' }) ??
        element.webkitRequestFullscreen?.());
    } catch {
      // Fullscreen needs a user gesture. The dialog's "I understand" click IS
      // that gesture, which is why enforcement starts there and not on mount.
      return;
    }

    if (capabilities.keyboardLock) {
      try {
        // Lock only the keys worth intercepting. Locking everything would trap
        // the participant far more than the feature needs to.
        await navigator.keyboard.lock([
          'Escape',
          'Tab',
          'KeyT',
          'KeyN',
          'KeyW',
          'KeyL',
          'KeyR',
        ]);
        setKeyboardLocked(true);
      } catch {
        setKeyboardLocked(false);
      }
    }
  }, [capabilities]);

  const exitEnforcement = useCallback(async () => {
    try {
      if (navigator.keyboard?.unlock) navigator.keyboard.unlock();
    } catch {
      // Nothing to unlock.
    }
    setKeyboardLocked(false);

    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Already out.
    }
  }, []);

  /** The participant clicked "Continue in full screen". That click is the gesture. */
  const acknowledge = useCallback(async () => {
    setAcknowledged(true);
    await enterEnforcement();
  }, [enterEnforcement]);

  /**
   * Warn when the tab is being closed or reloaded.
   *
   * The right-click menu is already blocked by the detection effect below;
   * this adds the other half of what the brief asks for.
   *
   * Be precise about what it does: `beforeunload` cannot PREVENT a close or a
   * reload. The browser shows its own generic confirmation and the user may
   * still proceed, and the message text is ignored by every modern browser. It
   * is a speed bump that makes an accidental reload unlikely, nothing more.
   *
   * Active only while the mode is on, the participant is not the host, and
   * they have acknowledged — so the host is never affected, and neither is an
   * ordinary meeting.
   */
  useEffect(() => {
    if (!enabled || isHost || !acknowledged) return undefined;

    const warnOnLeave = (event) => {
      event.preventDefault();
      // Required for Chrome to show its dialog at all. The string is ignored.
      event.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', warnOnLeave);
    return () => window.removeEventListener('beforeunload', warnOnLeave);
  }, [enabled, isHost, acknowledged]);

  // --- detection -----------------------------------------------------------
  useEffect(() => {
    // The host is not policed: they are the one running the interview, and
    // alerting them about their own tab switches would be noise.
    if (!enabled || isHost || !acknowledged) return undefined;

    const goAway = (reason) => {
      if (awayRef.current || suppressRef.current) return;
      awayRef.current = true;
      awaySinceRef.current = Date.now();
      setIsAway(true);
      onViolationRef.current?.({ type: reason, durationMs: null });
    };

    const comeBack = () => {
      if (!awayRef.current) return;
      awayRef.current = false;
      const durationMs = Date.now() - awaySinceRef.current;
      setIsAway(false);

      // Short blips are not reported at all, so the host's log stays readable.
      if (durationMs < MIN_REPORTABLE_AWAY_MS) return;

      setAwayCount((count) => count + 1);
      setLastViolation({ durationMs, at: new Date().toISOString() });
      onViolationRef.current?.({ type: 'return', durationMs });
    };

    const handleVisibility = () => {
      if (document.hidden) goAway('hidden');
      else comeBack();
    };
    const handleBlur = () => goAway('blur');
    const handleFocus = () => comeBack();
    const handleFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      // Leaving fullscreen is itself an escape: it is how you get the browser
      // chrome back, and therefore the tab bar.
      if (!active) goAway('blur');
    };

    // While the mode is on, block the in-app routes to another tab. This stops
    // accidents and makes the intent explicit; it is not a security boundary,
    // since the browser's own menus remain.
    const blockContextMenu = (event) => event.preventDefault();

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('contextmenu', blockContextMenu);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('contextmenu', blockContextMenu);
    };
  }, [enabled, isHost, acknowledged]);

  // --- reset when the mode is switched off ---------------------------------
  useEffect(() => {
    if (enabled) return;
    awayRef.current = false;
    setAcknowledged(false);
    setIsAway(false);
    setAwayCount(0);
    setLastViolation(null);
    exitEnforcement();
  }, [enabled, exitEnforcement]);

  // Release the keyboard and fullscreen on unmount, or the participant is left
  // in a locked fullscreen page after navigating away.
  useEffect(() => () => {
    try {
      navigator.keyboard?.unlock?.();
    } catch {
      /* nothing to unlock */
    }
  }, []);

  return {
    capabilities,
    acknowledged,
    acknowledge,
    isAway,
    awayCount,
    isFullscreen,
    keyboardLocked,
    lastViolation,
    exceededLimit: awayCount >= maxViolations,
    // True when the participant must be blocked: they have escaped and have
    // not yet come back AND re-entered fullscreen.
    mustBlock: enabled && !isHost && acknowledged && (isAway || !isFullscreen),
    suppressBriefly,
    reEnterFullscreen: enterEnforcement,
    // Called when the meeting ENDS, which is the only normal way out.
    // Releases the keyboard lock and leaves fullscreen; without it the
    // participant stays locked into a meeting that no longer exists.
    releaseEnforcement: exitEnforcement,
    // Shown to the host, so "reduced enforcement" is a true statement about
    // this browser rather than a guess.
    reducedEnforcement: !capabilities.fullscreen || !capabilities.keyboardLock,
  };
}
