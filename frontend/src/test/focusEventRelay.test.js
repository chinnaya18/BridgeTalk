import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSignSocket } from '../hooks/useSignSocket.js';
import { FakeWebSocket } from './setup.js';

/**
 * Bug 3: the host was never told what the server had decided.
 *
 * The server puts its verdict BESIDE the event, not inside it:
 *
 *   { type: 'focus-event', event: {...}, action: 'removed', departures: 2 }
 *
 * The socket handler passed `message.event` on by itself, so the host's toast
 * read `event.action === undefined` every time and fell through to its bland
 * "left the meeting screen" wording. A removal — the thing the host most needs
 * to know about, because a candidate has just been ejected — was announced in
 * exactly the same words as a first warning.
 *
 * The verdict is the server's to make, so the client must not recompute it
 * from a departure count of its own. It only has to carry it.
 */

const socket = () =>
  FakeWebSocket.instances.filter((item) => item.url.includes('/ws/predict')).at(-1);

async function mountSocket(onFocusEvent) {
  renderHook(() => useSignSocket({ meetingCode: 'ABC-123', onFocusEvent }));
  await waitFor(() => expect(socket()).toBeTruthy());
  await waitFor(() => expect(socket().readyState).toBe(FakeWebSocket.OPEN));
}

describe('focus-event relay to the host', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("carries the server's 'removed' verdict through to the handler", async () => {
    const onFocusEvent = vi.fn();
    await mountSocket(onFocusEvent);

    await act(async () => {
      socket().emit({
        type: 'focus-event',
        meeting_code: 'ABC-123',
        event: { id: 7, user_id: 102, user_name: 'Candidate', event_type: 'blur' },
        action: 'removed',
        departures: 2,
      });
    });

    expect(onFocusEvent).toHaveBeenCalledTimes(1);
    const received = onFocusEvent.mock.calls[0][0];
    expect(received.action, 'without this the host is told nothing happened').toBe('removed');
    expect(received.departures).toBe(2);
    // The event's own fields must survive the merge.
    expect(received.user_name).toBe('Candidate');
    expect(received.event_type).toBe('blur');
  });

  it("carries a 'warned' verdict too", async () => {
    const onFocusEvent = vi.fn();
    await mountSocket(onFocusEvent);

    await act(async () => {
      socket().emit({
        type: 'focus-event',
        event: { id: 8, user_id: 102, user_name: 'Candidate', event_type: 'hidden' },
        action: 'warned',
        departures: 1,
      });
    });

    expect(onFocusEvent.mock.calls[0][0].action).toBe('warned');
    expect(onFocusEvent.mock.calls[0][0].departures).toBe(1);
  });

  it("defaults to 'none' when the server sends no verdict", async () => {
    const onFocusEvent = vi.fn();
    await mountSocket(onFocusEvent);

    await act(async () => {
      socket().emit({
        type: 'focus-event',
        event: { id: 9, user_id: 102, user_name: 'Candidate', event_type: 'return' },
      });
    });

    // A `return` is the recovery, never an offence, so there is no verdict to
    // report and the host's toast must not imply one.
    expect(onFocusEvent.mock.calls[0][0].action).toBe('none');
    expect(onFocusEvent.mock.calls[0][0].departures).toBe(0);
  });
});
