/**
 * Rate-limits interim caption updates without ever losing the newest text.
 *
 * WHY A THROTTLE AT ALL
 * ---------------------
 * A sign caption is sent as an interim update the moment each word or letter is
 * committed, so the other participant sees text appear while the signer is
 * still going rather than only at the end of the segment. A fast fingerspeller
 * can commit several letters a second, and each one is a WebSocket message
 * broadcast to the room and re-rendered by every client.
 *
 * WHY IT COALESCES INSTEAD OF DROPPING
 * ------------------------------------
 * A plain leading-edge throttle discards everything inside the window. For an
 * interim that carries the FULL current text, discarding the last update before
 * the pause would leave the other side showing text one word short of what was
 * actually signed — and the final would then appear to jump.
 *
 * So this is leading-edge plus a trailing flush: the first update goes
 * immediately, any update inside the window overwrites a single pending slot,
 * and that pending text is sent when the window closes. The newest text is
 * always delivered; only intermediate states are skipped.
 *
 * FINALS ARE NEVER THROTTLED
 * --------------------------
 * `flush()` sends immediately and cancels anything pending, so a final can
 * never be overtaken by a stale interim that was still queued — which would
 * reopen a closed segment with older text.
 */
export function createInterimThrottle({ intervalMs, send, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null;
  let pending = null;
  let lastSentAt = 0;

  function sendPending() {
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    lastSentAt = now();
    send(text, false);
  }

  return {
    /** Offer an interim update. May be sent now, or coalesced and sent later. */
    push(text) {
      const elapsed = now() - lastSentAt;
      if (elapsed >= intervalMs) {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        pending = null;
        lastSentAt = now();
        send(text, false);
        return;
      }
      pending = text;
      if (timer === null) {
        timer = schedule(sendPending, intervalMs - elapsed);
      }
    },

    /** Send text immediately as a final, cancelling anything pending. */
    flush(text) {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      pending = null;
      // Reset, so the next segment's first interim is sent with no delay
      // rather than inheriting this segment's throttle window.
      lastSentAt = 0;
      send(text, true);
    },

    /** Drop anything pending without sending it. For teardown. */
    reset() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      pending = null;
      lastSentAt = 0;
    },

    /** Test and debug visibility. */
    get hasPending() {
      return pending !== null || timer !== null;
    },
  };
}
