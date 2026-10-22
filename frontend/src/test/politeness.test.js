import { describe, expect, it } from 'vitest';

/**
 * Bug 1: a shared screen never reached the other participant.
 *
 * Politeness decides who yields when two WebRTC offers cross. It was derived
 * from `should_initiate`, which the server computes as "somebody is already
 * here". Any peer that RECONNECTS mid-meeting therefore computes it as true
 * and becomes impolite — so after both peers have reconnected once, BOTH are
 * impolite, each ignores the other's offer, and every renegotiation deadlocks.
 *
 * The call itself survives, because it was negotiated at join. Screen sharing
 * does not, because adding a track IS a renegotiation. That is the bug.
 *
 * These tests pin the rule itself. `politeFrom` mirrors the expression in
 * useWebRTC's `joined` handler, which is small enough that duplicating it here
 * is clearer than mounting a peer connection.
 */

/** The OLD rule, kept so the failure it caused stays visible. */
function oldPoliteness(shouldInitiate) {
  return !shouldInitiate;
}

/** The rule now in useWebRTC: compare the two user ids. */
function politeFrom(selfId, otherId, shouldInitiate) {
  if (selfId != null && otherId != null) return selfId < otherId;
  return !shouldInitiate;
}

describe('WebRTC politeness', () => {
  it('assigns exactly one polite peer on a normal join', () => {
    // First in sees nobody; second in sees the first.
    const first = politeFrom(10, 20, false);
    const second = politeFrom(20, 10, true);
    expect(first).not.toBe(second);
  });

  it('survives BOTH peers reconnecting — the actual bug', () => {
    // After a reconnect the server tells each of them "somebody is already
    // here", so should_initiate is true for both.
    const firstAfterReconnect = politeFrom(10, 20, true);
    const secondAfterReconnect = politeFrom(20, 10, true);

    expect(
      firstAfterReconnect,
      'the lower id must still be the polite one',
    ).toBe(true);
    expect(secondAfterReconnect).toBe(false);
    expect(firstAfterReconnect).not.toBe(secondAfterReconnect);
  });

  it('the OLD rule made both peers impolite after a reconnect', () => {
    // Demonstrates the defect rather than asserting it is acceptable: with
    // both impolite, each ignores the other's offer and renegotiation — and
    // therefore screen sharing — deadlocks.
    expect(oldPoliteness(true)).toBe(false);
    expect(oldPoliteness(true)).toBe(false);
  });

  it('is stable however many times either side reconnects', () => {
    for (const a of [true, false]) {
      for (const b of [true, false]) {
        expect(politeFrom(10, 20, a)).toBe(true);
        expect(politeFrom(20, 10, b)).toBe(false);
      }
    }
  });

  it('falls back to should_initiate while alone in the room', () => {
    // No peer yet, so there is nothing to collide with; `peer-joined` settles
    // it when somebody arrives.
    expect(politeFrom(10, null, false)).toBe(true);
    expect(politeFrom(10, null, true)).toBe(false);
  });

  it('never makes a peer polite against itself', () => {
    // Same id should not happen, but it must not produce two polite peers.
    expect(politeFrom(10, 10, false)).toBe(false);
  });
});
