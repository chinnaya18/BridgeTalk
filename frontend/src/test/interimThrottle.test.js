import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInterimThrottle } from '../utils/interimThrottle';

/**
 * Bug 1 asks for interim sign updates throttled to about 5 per second.
 *
 * The property that matters is not the rate but that NOTHING IS LOST: an
 * interim carries the full current text, so dropping the last one before a
 * pause would leave the other participant a word short.
 */
describe('createInterimThrottle', () => {
  let clock;
  let sent;
  let throttle;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    sent = [];
    throttle = createInterimThrottle({
      intervalMs: 200,
      send: (text, isFinal) => sent.push({ text, isFinal }),
      now: () => clock,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (id) => clearTimeout(id),
    });
  });

  it('sends the first update immediately', () => {
    throttle.push('hello');
    expect(sent).toEqual([{ text: 'hello', isFinal: false }]);
  });

  it('coalesces rapid updates and sends the NEWEST text when the window closes', () => {
    throttle.push('a');
    expect(sent).toHaveLength(1);

    clock += 20;
    throttle.push('a b');
    clock += 20;
    throttle.push('a b c');
    clock += 20;
    throttle.push('a b c d');
    // Still only the first send; three updates are coalesced into one slot.
    expect(sent).toHaveLength(1);

    clock += 200;
    vi.advanceTimersByTime(200);

    // The newest text is delivered — not 'a b', not 'a b c'.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ text: 'a b c d', isFinal: false });
  });

  it('never loses the last interim before a pause', () => {
    throttle.push('one');
    clock += 10;
    throttle.push('one two');     // inside the window, coalesced
    clock += 250;
    vi.advanceTimersByTime(250);

    expect(sent.map((s) => s.text)).toEqual(['one', 'one two']);
  });

  it('sends updates spaced wider than the interval immediately, every time', () => {
    for (let i = 0; i < 4; i += 1) {
      throttle.push(`word ${i}`);
      clock += 250;
      vi.advanceTimersByTime(250);
    }
    expect(sent).toHaveLength(4);
    expect(sent.every((s) => s.isFinal === false)).toBe(true);
  });

  it('holds the rate at or below the configured interval', () => {
    // 50 updates, 10ms apart: 500ms of signing at 100 commits/second.
    for (let i = 0; i < 50; i += 1) {
      throttle.push(`t${i}`);
      clock += 10;
      vi.advanceTimersByTime(10);
    }
    clock += 200;
    vi.advanceTimersByTime(200);

    // 500ms at a 200ms interval allows at most 1 + ceil(500/200) = 4 sends.
    expect(sent.length).toBeLessThanOrEqual(4);
    // And the final state is the newest text, so nothing was truly lost.
    expect(sent[sent.length - 1].text).toBe('t49');
  });

  it('flush sends a final immediately, even inside the throttle window', () => {
    throttle.push('partial');
    clock += 10;
    throttle.flush('partial complete');

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ text: 'partial complete', isFinal: true });
  });

  it('flush cancels a pending interim so a stale one cannot follow the final', () => {
    throttle.push('first');
    clock += 10;
    throttle.push('stale interim');  // pending
    throttle.flush('the real final');

    clock += 500;
    vi.advanceTimersByTime(500);

    // The pending 'stale interim' must NEVER arrive — it would reopen a closed
    // segment with older text.
    expect(sent.map((s) => s.text)).toEqual(['first', 'the real final']);
    expect(throttle.hasPending).toBe(false);
  });

  it('after a flush the next segment starts with no delay', () => {
    throttle.push('seg one');
    throttle.flush('seg one done');
    // No clock advance at all.
    throttle.push('seg two');

    expect(sent[sent.length - 1]).toEqual({ text: 'seg two', isFinal: false });
  });

  it('reset drops anything pending without sending it', () => {
    throttle.push('a');
    clock += 10;
    throttle.push('b');
    throttle.reset();

    clock += 500;
    vi.advanceTimersByTime(500);

    expect(sent.map((s) => s.text)).toEqual(['a']);
    expect(throttle.hasPending).toBe(false);
  });
});
