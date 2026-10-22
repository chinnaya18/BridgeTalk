import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWebRTC } from '../hooks/useWebRTC.js';
import { FakeRTCPeerConnection, FakeWebSocket, fakeStream } from './setup.js';

/**
 * Bug 1: the shared screen never reached the other participant — and, it
 * turned out, neither did the camera.
 *
 * `onnegotiationneeded` fires the moment the local tracks are added, which is
 * before the other participant has necessarily joined. The first peer into a
 * meeting therefore offered into an EMPTY room. The server drops that offer
 * (it replies `no-peers`), but the connection stays in `have-local-offer` for
 * the rest of the meeting.
 *
 * When the second peer finally joined and offered properly, that stale local
 * offer looked like an offer collision. The impolite peer ignores a colliding
 * offer, so nobody answered: both peers sat in `have-local-offer` with
 * connectionState `new` and no media flowed in either direction. The call
 * looked negotiated and was silent.
 *
 * Making the polite peer absorb it is not a fix either. Chrome does not
 * restart ICE gathering after the implicit rollback on a FIRST negotiation, so
 * the polite peer reaches `stable` having never produced a single local
 * candidate — equally silent. The collision has to be avoided, not resolved.
 *
 * So these tests pin the sequencing: no offer while the room is empty, and no
 * second offer when somebody arrives, because the arriver is the one the
 * server told to initiate.
 */

const sentTypes = (socket) => socket.sent.map((raw) => JSON.parse(raw).type);

/** The signalling socket, which is the only one this hook opens. */
const signalSocket = () =>
  FakeWebSocket.instances.filter((socket) => socket.url.includes('/ws/signal')).at(-1);

async function mountWebRTC() {
  // ONE stream for the whole mount. Building it inside the render callback
  // handed the hook a new object on every render, which re-ran the signalling
  // effect: the socket under test was closed and replaced each time.
  const stream = fakeStream();
  const view = renderHook(() =>
    useWebRTC({ enabled: true, meetingCode: 'ABC-123', localStream: stream }),
  );
  await waitFor(() => expect(signalSocket()).toBeTruthy());
  // Wait for OPEN, not merely for the socket to exist. `send` is a no-op while
  // it is CONNECTING, which would make every "no offer was sent" assertion
  // below pass for the wrong reason.
  await waitFor(() => expect(signalSocket().readyState).toBe(FakeWebSocket.OPEN));
  return view;
}

/** Fire the event jsdom never fires, on the connection the hook built. */
async function fireNegotiationNeeded() {
  const connection = FakeRTCPeerConnection.instances.at(-1);
  expect(connection, 'the hook should have built a peer connection').toBeTruthy();
  await act(async () => {
    await connection.onnegotiationneeded?.();
  });
}

describe('WebRTC initial negotiation', () => {
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
  });

  it('sends NO offer while the room is still empty', async () => {
    await mountWebRTC();
    const socket = signalSocket();

    // Alone: this is what the server sends the first peer in.
    await act(async () => {
      socket.emit({ type: 'joined', self: { id: 10 }, peers: [], should_initiate: false });
    });
    await fireNegotiationNeeded();

    expect(
      sentTypes(socket),
      'an offer into an empty room is dropped by the server and strands this peer in have-local-offer',
    ).not.toContain('offer');
  });

  it('still sends no offer when the other peer arrives — the arriver initiates', async () => {
    await mountWebRTC();
    const socket = signalSocket();

    await act(async () => {
      socket.emit({ type: 'joined', self: { id: 10 }, peers: [], should_initiate: false });
    });
    await fireNegotiationNeeded();

    await act(async () => {
      socket.emit({ type: 'peer-joined', peer: { id: 20, name: 'Other' } });
    });

    expect(
      sentTypes(socket),
      'offering here too is a genuine collision, and the rollback that resolves it kills ICE gathering on a first negotiation',
    ).not.toContain('offer');
  });

  it('offers exactly once when it joins SECOND, with a peer already there', async () => {
    await mountWebRTC();
    const socket = signalSocket();

    await act(async () => {
      socket.emit({
        type: 'joined',
        self: { id: 20 },
        peers: [{ id: 10, name: 'First' }],
        should_initiate: true,
      });
    });
    await fireNegotiationNeeded();

    expect(sentTypes(socket).filter((type) => type === 'offer')).toHaveLength(1);
  });

  it('renegotiates for a screen share once the peer is present', async () => {
    const view = await mountWebRTC();
    const socket = signalSocket();

    await act(async () => {
      socket.emit({
        type: 'joined',
        self: { id: 20 },
        peers: [{ id: 10, name: 'First' }],
        should_initiate: true,
      });
    });
    await fireNegotiationNeeded();
    const before = sentTypes(socket).filter((type) => type === 'offer').length;

    // Adding the screen track is what a screen share does, and it must offer
    // again — that renegotiation is the whole mechanism Bug 1 was about.
    await act(async () => {
      view.result.current.addScreenTrack({ kind: 'video' }, { id: 'screen-1' });
    });
    await fireNegotiationNeeded();

    expect(sentTypes(socket).filter((type) => type === 'offer').length).toBe(before + 1);
  });
});
