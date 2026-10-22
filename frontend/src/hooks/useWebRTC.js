import { useCallback, useEffect, useRef, useState } from 'react';

import { getToken, WS_BASE_URL } from '../services/api';

/**
 * Establishes a 1:1 WebRTC call, using our backend purely as a signalling relay.
 *
 * THE SEQUENCE
 * ------------
 *   1. Both peers open /ws/signal/{code}.
 *   2. The server tells the *second* arrival `should_initiate: true`. Exactly
 *      one side must offer — if both do, the negotiations collide ("glare")
 *      and both have to back off and retry.
 *   3. Initiator: createOffer -> setLocalDescription -> send through the relay.
 *   4. Responder: setRemoteDescription -> createAnswer -> send back.
 *   5. Both: trickle ICE candidates to each other as they are discovered.
 *   6. The peers connect directly. Audio and video never touch our server.
 *
 * WHAT CAN GO WRONG, HONESTLY
 * ---------------------------
 * We configure STUN but no TURN. STUN lets a browser discover its own public
 * address; TURN relays the media when a direct path is impossible, which
 * happens behind symmetric NAT or a restrictive corporate firewall. Without
 * TURN those calls simply fail to connect. Two tabs on one laptop, or two
 * laptops on one Wi-Fi network, connect fine — and that is what the demo uses.
 */

/**
 * ICE servers, configured from the environment so a TURN server can be added
 * at deployment without touching this file.
 *
 *   VITE_STUN_URLS   comma-separated, e.g. "stun:stun.l.google.com:19302,stun:..."
 *   VITE_TURN_URLS   comma-separated, e.g. "turn:turn.example.org:3478"
 *   VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL
 *
 * WHY TURN MATTERS AND STUN IS NOT ENOUGH
 * ---------------------------------------
 * STUN only tells each peer what its own public address looks like. That is
 * sufficient when the two peers can reach each other directly, which is the
 * case for two laptops on one Wi-Fi network — the demo setup. It fails on
 * symmetric NAT and on many corporate and mobile networks, where the only way
 * through is to relay the media through a TURN server.
 *
 * No TURN server is configured by default because running one costs bandwidth
 * and this is a locally-demonstrated project. The hooks are here so that
 * deploying behind a TURN server is a .env change rather than a code change.
 */
function parseUrls(value) {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

const STUN_URLS = parseUrls(
  import.meta.env.VITE_STUN_URLS ??
    'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
);
const TURN_URLS = parseUrls(import.meta.env.VITE_TURN_URLS);

const ICE_SERVERS = [
  // Several STUN servers are listed because any one of them may be
  // unreachable from a given network, and ICE uses whichever responds.
  ...(STUN_URLS.length ? [{ urls: STUN_URLS }] : []),
  ...(TURN_URLS.length
    ? [
        {
          urls: TURN_URLS,
          username: import.meta.env.VITE_TURN_USERNAME,
          credential: import.meta.env.VITE_TURN_CREDENTIAL,
        },
      ]
    : []),
];

export function useWebRTC({ meetingCode, localStream, enabled = true }) {
  const peerRef = useRef(null);
  // --- perfect negotiation state -------------------------------------------
  // Needed because adding the screen-share track AFTER the call is up requires
  // a second offer/answer round. Without renegotiation the local peer happily
  // adds the track and the remote side never receives it.
  //
  // Whoever adds a track must offer, and that is not necessarily the peer that
  // made the first offer — so both sides can now offer, and the standard
  // polite/impolite roles resolve the collision. The POLITE peer rolls back
  // its own offer and accepts the other's; the impolite peer ignores the
  // incoming one. Without this, two simultaneous offers deadlock the
  // connection in have-local-offer.
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const politeRef = useRef(true);
  // The stream id the remote peer announced as its screen share, so an
  // inbound track can be routed to the right tile.
  const screenStreamIdRef = useRef(null);
  // Whether the other participant is currently in the signalling room, and
  // whether we owe them an offer that was deferred because they were not.
  const hasPeerRef = useRef(false);
  const negotiationPendingRef = useRef(false);

  /**
   * Swap the outgoing video track without renegotiating.
   *
   * Needed because turning the camera off now genuinely STOPS the track
   * rather than just disabling it — `enabled = false` keeps the hardware open
   * and the indicator light on, which is not "off" in any sense a user means.
   *
   * replaceTrack is the right tool: it changes what the existing sender
   * transmits, so there is no new offer/answer round trip and the remote peer
   * sees the stream continue rather than drop and restart.
   *
   * Passing null makes the sender transmit nothing, which is what the remote
   * side should see while the camera is released.
   */
  /**
   * Add the screen track to the live connection, as an ADDITIONAL track.
   *
   * Deliberately not replaceTrack on the camera sender: the signer must stay
   * visible while they present, which is the whole point for this audience.
   * addTrack triggers onnegotiationneeded, which offers again.
   */
  const addScreenTrack = useCallback((track, stream) => {
    const connection = peerRef.current;
    if (!connection || !track) return null;
    try {
      const sender = connection.addTrack(track, stream);
      return sender;
    } catch {
      return null;
    }
  }, []);

  const removeScreenSender = useCallback((sender) => {
    const connection = peerRef.current;
    if (!connection || !sender) return;
    try {
      connection.removeTrack(sender);
    } catch {
      // Connection already closed.
    }
  }, []);

  /**
   * Swap the track a sender is transmitting, without renegotiating.
   *
   * `replaceTrack` is the whole reason toggling the camera or changing a device
   * mid-call is instant. Removing the track and adding a new one would fire
   * `onnegotiationneeded` and cost a full offer/answer round trip, during which
   * the other side sees the video freeze.
   *
   * The `track === null` fallback finds a sender whose track has already been
   * cleared — which is the state after the camera was turned off. Without it,
   * turning the camera back on would find no video sender and silently fail to
   * reach the peer: locally correct, remotely still black.
   */
  const replaceTrackOfKind = useCallback(async (kind, track) => {
    const connection = peerRef.current;
    if (!connection) return false;

    const senders = connection.getSenders();
    const sender =
      senders.find((s) => s.track?.kind === kind) ?? senders.find((s) => s.track === null);
    if (!sender) return false;

    try {
      await sender.replaceTrack(track ?? null);
      return true;
    } catch {
      // Older browsers, or a sender in a state that refuses the swap. The
      // local state is still correct; only the remote view is stale.
      return false;
    }
  }, []);

  const replaceVideoTrack = useCallback(
    (track) => replaceTrackOfKind('video', track),
    [replaceTrackOfKind],
  );

  /**
   * Used when the microphone is changed in Settings.
   *
   * Without this, choosing a different microphone mid-call would change which
   * device feeds speech recognition — which runs locally — while the other
   * participant kept hearing the old one. Captions and audio would come from
   * two different microphones, which is a genuinely confusing failure.
   */
  const replaceAudioTrack = useCallback(
    (track) => replaceTrackOfKind('audio', track),
    [replaceTrackOfKind],
  );
  const socketRef = useRef(null);
  // ICE candidates can arrive before the remote description is set, and
  // addIceCandidate throws if it does. They are queued here and flushed once
  // the description lands.
  const pendingCandidatesRef = useRef([]);
  const intentionalCloseRef = useRef(false);
  // Our own user id, kept so politeness can be settled when a peer arrives.
  const selfIdRef = useRef(null);

  const [remoteStream, setRemoteStream] = useState(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState(null);
  const [remotePresenter, setRemotePresenter] = useState(null);
  const [connectionState, setConnectionState] = useState('new');
  const [peer, setPeer] = useState(null);
  const [signalStatus, setSignalStatus] = useState('idle');
  const [error, setError] = useState(null);

  const send = useCallback((message) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /**
   * Create and send an offer — but only once there is somebody to send it to.
   *
   * `onnegotiationneeded` fires as soon as the local tracks are added, which
   * is before the other participant has necessarily joined. Offering into an
   * empty room is NOT harmless: the server drops the offer (it replies
   * `no-peers`), but this connection stays in `have-local-offer` for good.
   * When the other side finally joins and offers properly, that stale local
   * offer looks like an offer collision — and if this peer is the impolite
   * one, it ignores the real offer. Nobody answers, and the call never
   * connects at all: both peers sit in `have-local-offer`, connectionState
   * `new`, with no video either way and no screen share possible.
   *
   * So the offer is deferred until a peer is actually present, and replayed
   * from `peer-joined`.
   */
  const negotiate = useCallback(async () => {
    const connection = peerRef.current;
    if (!connection) return;
    if (!hasPeerRef.current) {
      negotiationPendingRef.current = true;
      return;
    }
    negotiationPendingRef.current = false;
    try {
      makingOfferRef.current = true;
      // No argument: setLocalDescription() with no description creates the
      // right kind (offer or answer) for the current signalling state. Doing
      // it manually is where renegotiation bugs come from.
      await connection.setLocalDescription();
      send({ type: 'offer', payload: connection.localDescription });
    } catch {
      // A failed renegotiation leaves the existing call intact; the new track
      // simply is not received.
    } finally {
      makingOfferRef.current = false;
    }
  }, [send]);

  /** Build the RTCPeerConnection and wire up its events. */
  const createPeerConnection = useCallback(() => {
    if (peerRef.current) return peerRef.current;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Publish our own audio/video tracks onto the connection.
    if (localStream) {
      for (const track of localStream.getTracks()) {
        connection.addTrack(track, localStream);
      }
    }

    connection.ontrack = (event) => {
      // Two inbound video streams are now possible: the camera and, while
      // someone is presenting, their screen. They are distinguished by stream
      // id rather than by arrival order, because order is not guaranteed and
      // mixing them up would put the screen in the camera tile.
      const stream = event.streams[0] ?? null;
      if (!stream) return;

      if (screenStreamIdRef.current && stream.id === screenStreamIdRef.current) {
        setRemoteScreenStream(stream);
        // When the presenter stops, the track ends rather than the stream
        // disappearing, so the end has to be watched for explicitly.
        event.track.addEventListener('ended', () => setRemoteScreenStream(null));
        return;
      }
      setRemoteStream(stream);
    };

    // Fires whenever the set of tracks changes — which is exactly what
    // starting and stopping a screen share does.
    connection.onnegotiationneeded = () => {
      void negotiate();
    };

    connection.onicecandidate = (event) => {
      // A null candidate means gathering has finished — nothing to relay.
      if (event.candidate) {
        send({ type: 'ice-candidate', payload: event.candidate.toJSON() });
      }
    };

    connection.onconnectionstatechange = () => {
      setConnectionState(connection.connectionState);
      if (connection.connectionState === 'failed') {
        setError(
          'Could not establish a direct connection. This usually means both ' +
            'peers are behind restrictive NATs, which needs a TURN server we ' +
            'do not run. Try two tabs on one machine, or two devices on the ' +
            'same Wi-Fi network.',
        );
      }
    };

    peerRef.current = connection;
    return connection;
  }, [localStream, send, negotiate]);

  const flushPendingCandidates = useCallback(async (connection) => {
    for (const candidate of pendingCandidatesRef.current) {
      try {
        await connection.addIceCandidate(candidate);
      } catch (cause) {
        console.warn('Failed to add a queued ICE candidate', cause);
      }
    }
    pendingCandidatesRef.current = [];
  }, []);

  const startCall = useCallback(async () => {
    // Only make sure the connection exists. Adding the local tracks fires
    // `onnegotiationneeded`, which creates the offer; building a second one
    // here raced that handler and threw InvalidAccessError ("the order of
    // m-lines in subsequent offer doesn't match order from previous
    // offer/answer"), leaving an uncaught rejection in the page.
    createPeerConnection();
    if (negotiationPendingRef.current) await negotiate();
  }, [createPeerConnection, negotiate]);

  // --- signalling socket ---------------------------------------------------
  useEffect(() => {
    if (!enabled || !meetingCode || !localStream) return undefined;

    intentionalCloseRef.current = false;
    const url = `${WS_BASE_URL}/ws/signal/${encodeURIComponent(meetingCode)}?token=${encodeURIComponent(getToken() ?? '')}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;
    setSignalStatus('connecting');

    socket.onopen = () => setSignalStatus('open');

    socket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const connection = peerRef.current ?? createPeerConnection();

      switch (message.type) {
        case 'joined': {
          setPeer(message.peers?.[0] ?? null);
          // The second arrival initiates — it is the one that knows somebody
          // is already waiting.
          // POLITENESS IS DERIVED FROM THE USER IDS, NOT FROM should_initiate.
          //
          // It used to be `!message.should_initiate`, and that breaks on a
          // reconnect. `should_initiate` means "somebody is already here", so
          // ANY peer that reconnects mid-meeting computes it as true and
          // becomes impolite. If both peers reconnect at some point — ordinary
          // on a phone hotspot — both are impolite, and on an offer collision
          // each ignores the other's offer. The call carries on, because it was
          // negotiated at join, but every later RENEGOTIATION deadlocks.
          //
          // Screen sharing is renegotiation. That is this bug: the presenter
          // sees their own screen, and the other side never receives the track.
          //
          // Comparing user ids is stable, needs no extra message, and both
          // sides independently reach opposite answers — which is the whole
          // requirement. It survives any number of reconnects.
          const selfId = message.self?.id ?? null;
          selfIdRef.current = selfId;
          const otherId = message.peers?.[0]?.id ?? null;
          hasPeerRef.current = otherId != null;
          if (selfId != null && otherId != null) {
            politeRef.current = selfId < otherId;
          } else {
            // Alone in the room, so there is nobody to collide with yet. The
            // next `peer-joined` settles it.
            politeRef.current = !message.should_initiate;
          }
          if (message.should_initiate) await startCall();
          break;
        }

        case 'peer-joined':
          setPeer(message.peer);
          // Settle politeness now that there is somebody to collide with. The
          // peer who joined computes the same comparison from their `joined`
          // message and reaches the opposite answer.
          if (selfIdRef.current != null && message.peer?.id != null) {
            politeRef.current = selfIdRef.current < message.peer.id;
          }
          hasPeerRef.current = true;
          // Drop the offer that was held back while the room was empty rather
          // than sending it now. The peer who just joined is the one the
          // server told to initiate, so its offer is already on its way, and
          // anything we were waiting to negotiate goes out in the ANSWER we
          // send to it — an answer carries all of our tracks.
          //
          // Offering here as well would be a genuine offer collision, and the
          // polite peer resolves those by letting setRemoteDescription roll
          // its own offer back. That is correct per the spec and fine for a
          // later renegotiation, but on the FIRST negotiation Chrome does not
          // restart ICE gathering after the rollback: the polite peer ends up
          // in `stable` having never produced a single local candidate, so
          // iceConnectionState never leaves `new` and no media flows in
          // either direction. The call looks negotiated and stays silent.
          negotiationPendingRef.current = false;
          break;

        case 'peer-left':
          setPeer(null);
          setRemoteStream(null);
          hasPeerRef.current = false;
          break;

        case 'offer': {
          // --- offer collision handling ---------------------------------
          // Both sides can now offer, because whoever adds a screen-share
          // track must renegotiate. So two offers can cross in flight.
          //
          // The IMPOLITE peer ignores an incoming offer while it has one of
          // its own outstanding; the POLITE peer rolls its own back and
          // accepts. Without this the connection sticks in have-local-offer
          // and the call freezes — and it freezes for the whole call, not just
          // the screen share.
          const offerCollision =
            makingOfferRef.current || connection.signalingState !== 'stable';

          ignoreOfferRef.current = !politeRef.current && offerCollision;
          if (ignoreOfferRef.current) break;

          await connection.setRemoteDescription(new RTCSessionDescription(message.payload));
          await flushPendingCandidates(connection);
          // No argument: the browser creates the correct description type for
          // the current state, which is what makes rollback-then-answer work.
          await connection.setLocalDescription();
          send({ type: 'answer', payload: connection.localDescription });
          break;
        }

        case 'answer':
          // Only meaningful while we are waiting for one. An answer that
          // arrives in any other state — a duplicate, or one for an offer we
          // rolled back — throws InvalidStateError from
          // setRemoteDescription, and that exception would abort this handler
          // and leave later messages unprocessed.
          if (connection.signalingState !== 'have-local-offer') break;
          await connection.setRemoteDescription(new RTCSessionDescription(message.payload));
          await flushPendingCandidates(connection);
          break;

        case 'presentation-start': {
          // The presenter announces the stream id before the track arrives,
          // so ontrack can route it to the screen tile rather than guessing.
          const screenId = message.payload?.stream_id ?? null;
          screenStreamIdRef.current = screenId;
          setRemotePresenter(message.from ?? null);

          // If the track beat the announcement, ontrack will already have
          // filed it as the camera — which puts the shared screen in the
          // camera tile and leaves the stage with nothing to present. Move it
          // across rather than waiting for a track that has already arrived.
          if (screenId) {
            setRemoteStream((current) => {
              if (current && current.id === screenId) {
                setRemoteScreenStream(current);
                return null;
              }
              return current;
            });
          }
          break;
        }

        case 'presentation-stop':
          screenStreamIdRef.current = null;
          setRemoteScreenStream(null);
          setRemotePresenter(null);
          break;

        case 'ice-candidate': {
          const candidate = new RTCIceCandidate(message.payload);
          if (connection.remoteDescription) {
            try {
              await connection.addIceCandidate(candidate);
            } catch (cause) {
              console.warn('addIceCandidate failed', cause);
            }
          } else {
            // Trickle ICE means candidates routinely arrive before the
            // description. Queue rather than drop them — a dropped candidate
            // can be the one viable network path.
            pendingCandidatesRef.current.push(candidate);
          }
          break;
        }

        case 'hangup':
          setPeer(null);
          setRemoteStream(null);
          peerRef.current?.close();
          peerRef.current = null;
          break;

        case 'error':
          setError(message.message);
          break;

        default:
          break;
      }
    };

    socket.onclose = () => {
      setSignalStatus(intentionalCloseRef.current ? 'closed' : 'disconnected');
    };

    return () => {
      intentionalCloseRef.current = true;
      socket.close();
      socketRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidatesRef.current = [];
      setRemoteStream(null);
      setPeer(null);
    };
  }, [
    enabled,
    meetingCode,
    localStream,
    createPeerConnection,
    startCall,
    negotiate,
    flushPendingCandidates,
    send,
  ]);

  const hangUp = useCallback(() => {
    send({ type: 'hangup', payload: null });
    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
    setPeer(null);
  }, [send]);

  return {
    remoteStream,
    connectionState,
    peer,
    signalStatus,
    error,
    hangUp,
    isConnected: connectionState === 'connected',
    replaceVideoTrack,
    replaceAudioTrack,
    addScreenTrack,
    removeScreenSender,
    remoteScreenStream,
    remotePresenter,
    sendSignal: send,
  };
}
