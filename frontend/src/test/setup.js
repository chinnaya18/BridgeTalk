import { afterEach, beforeEach, expect, vi } from 'vitest';

/**
 * Browser APIs this app uses that jsdom does not implement.
 *
 * Every stub here is a real gap in jsdom, not a convenience. The rule followed
 * throughout is that a stub resolves or returns the SHAPE the real API returns
 * and nothing more — a stub that returns plausible fake data would let a test
 * pass against code that could never work in a browser.
 */

// --- matchMedia: read by Tailwind-adjacent code and by prefers-reduced-motion
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// --- requestAnimationFrame: the detection loop drives itself with this.
// jsdom has it, but with a 16ms timer that keeps the loop running between
// tests. A microtask-based version lets a test tick it deterministically.
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (handle) => clearTimeout(handle);
}

// --- MediaStream and getUserMedia -----------------------------------------
// jsdom implements neither. The meeting room and the lobby both call
// getUserMedia on mount, and an unhandled rejection there is itself a bug
// worth failing on, so this resolves with a stream-shaped object.
class FakeMediaStreamTrack {
  constructor(kind) {
    this.kind = kind;
    this.id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
    this.enabled = true;
    this.readyState = 'live';
    this.muted = false;
    this.label = `fake ${kind}`;
  }

  stop() {
    this.readyState = 'ended';
  }

  addEventListener() {}
  removeEventListener() {}
  getSettings() {
    return { deviceId: 'fake-device' };
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
    this._tracks = tracks;
  }

  getTracks() {
    return [...this._tracks];
  }

  getAudioTracks() {
    return this._tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this._tracks.filter((track) => track.kind === 'video');
  }

  addTrack(track) {
    this._tracks.push(track);
  }

  removeTrack(track) {
    this._tracks = this._tracks.filter((item) => item !== track);
  }

  addEventListener() {}
  removeEventListener() {}
}

globalThis.MediaStream = FakeMediaStream;
globalThis.MediaStreamTrack = FakeMediaStreamTrack;

function fakeStream({ audio = true, video = true } = {}) {
  const tracks = [];
  if (audio) tracks.push(new FakeMediaStreamTrack('audio'));
  if (video) tracks.push(new FakeMediaStreamTrack('video'));
  return new FakeMediaStream(tracks);
}

Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  writable: true,
  value: {
    getUserMedia: vi.fn(async (constraints = {}) =>
      fakeStream({ audio: Boolean(constraints.audio), video: Boolean(constraints.video) }),
    ),
    getDisplayMedia: vi.fn(async () => fakeStream({ audio: false, video: true })),
    enumerateDevices: vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Microphone', groupId: 'g1' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera', groupId: 'g2' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Built-in Output', groupId: 'g1' },
    ]),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

// --- HTMLMediaElement: jsdom throws "Not implemented" from play() ----------
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: vi.fn(async () => {}),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});
// srcObject does not exist on jsdom's HTMLMediaElement at all, and the tiles
// assign it. A plain data property is enough; nothing reads it back but the
// identity check that avoids re-assigning the same stream.
Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
  configurable: true,
  get() {
    return this._srcObject ?? null;
  },
  set(value) {
    this._srcObject = value;
  },
});

// --- WebSocket ------------------------------------------------------------
// jsdom has one, but it tries to open a real connection. This records what was
// sent and stays CONNECTING, which is the state the UI must tolerate anyway.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);

    // OPEN on the next tick, and for /ws/predict deliver the `connected`
    // message the real server sends.
    //
    // An earlier version of this stub stayed CONNECTING forever, which seemed
    // harmless and was not: with no `connected` message the UI never learns
    // which models exist, so every test ran against the "models unknown" branch
    // and the states that matter — which recognition modes are offered, whether
    // the sign button can be used — were never exercised at all.
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});

      if (this.url.includes('/ws/predict')) {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'connected',
            // Shaped exactly as predictor.describe() returns it.
            model: {
              mode: 'static',
              loaded: true,
              error: null,
              classes: 28,
              language: null,
              val_accuracy: 0.9404,
              signer_disjoint: true,
            },
            isl_model: {
              mode: 'isl',
              loaded: true,
              error: null,
              classes: 35,
              language: null,
              val_accuracy: 0.9919,
              signer_disjoint: false,
            },
            dynamic_model: {
              mode: 'dynamic',
              loaded: true,
              error: null,
              classes: 40,
              language: 'ISL',
              val_accuracy: 0.8571,
              signer_disjoint: false,
            },
          }),
        });
      }
    }, 0);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'test' });
  }

  /** Push a server message into the client, for tests that drive the protocol. */
  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  addEventListener() {}
  removeEventListener() {}
}
FakeWebSocket.instances = [];
globalThis.WebSocket = FakeWebSocket;

// --- RTCPeerConnection ----------------------------------------------------
class FakeRTCPeerConnection {
  constructor() {
    FakeRTCPeerConnection.instances.push(this);
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this._senders = [];
  }

  addTrack(track) {
    const sender = { track, replaceTrack: vi.fn(async () => {}) };
    this._senders.push(sender);
    return sender;
  }

  removeTrack(sender) {
    this._senders = this._senders.filter((item) => item !== sender);
  }

  getSenders() {
    return [...this._senders];
  }

  getReceivers() {
    return [];
  }

  async createOffer() {
    return { type: 'offer', sdp: 'fake' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'fake' };
  }

  async setLocalDescription(description) {
    this.localDescription = description ?? { type: 'offer', sdp: 'fake' };
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate() {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.connectionState = 'closed';
  }
}
// Recorded so a test can reach the connection the hook built and fire the
// events jsdom never will — `onnegotiationneeded` above all, which is what
// decides whether an offer is sent.
FakeRTCPeerConnection.instances = [];
globalThis.RTCPeerConnection = FakeRTCPeerConnection;
globalThis.RTCSessionDescription = function RTCSessionDescription(init) {
  return { ...init };
};
globalThis.RTCIceCandidate = function RTCIceCandidate(init) {
  return { ...init };
};

// --- AudioContext, for the lobby's microphone level meter -----------------
class FakeAnalyser {
  constructor() {
    this.fftSize = 1024;
  }
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(array) {
    array.fill(0);
  }
  getByteFrequencyData(array) {
    array.fill(0);
  }
}
class FakeAudioContext {
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  async close() {}
}
globalThis.AudioContext = FakeAudioContext;
globalThis.webkitAudioContext = FakeAudioContext;

// --- clipboard, fullscreen ------------------------------------------------
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  writable: true,
  value: { writeText: vi.fn(async () => {}) },
});
document.documentElement.requestFullscreen = vi.fn(async () => {});
document.exitFullscreen = vi.fn(async () => {});

// --- fail the test on an unexpected console.error -------------------------
// React reports a thrown render error through console.error before an error
// boundary swallows it, so without this a page that crashes into its boundary
// would still "pass".
let consoleErrors = [];
const realConsoleError = console.error;

beforeEach(() => {
  consoleErrors = [];
  FakeWebSocket.instances = [];
  FakeRTCPeerConnection.instances = [];
  localStorage.clear();
  sessionStorage.clear();

  // These vi.fn()s are created ONCE when this module loads, so without a clear
  // their `mock.calls` accumulate across every test in the run. A test asserting
  // on `calls[0]` then reads whatever the first test in the file happened to do
  // — which is exactly how the device-preference assertion failed while the code
  // under test was correct.
  navigator.mediaDevices.getUserMedia.mockClear();
  navigator.mediaDevices.getDisplayMedia.mockClear();
  navigator.mediaDevices.enumerateDevices.mockClear();
  navigator.clipboard.writeText.mockClear();
  HTMLMediaElement.prototype.play.mockClear();
  document.documentElement.requestFullscreen.mockClear();
  document.exitFullscreen.mockClear();
  console.error = (...args) => {
    consoleErrors.push(args.map(String).join(' '));
    realConsoleError(...args);
  };
});

afterEach(() => {
  console.error = realConsoleError;
  const fatal = consoleErrors.filter(
    (message) =>
      // These are the shapes React uses when a render threw.
      /Cannot access|is not a function|is not defined|Cannot read propert|The above error occurred/.test(
        message,
      ),
  );
  expect(fatal, `console.error reported a render failure:\n${fatal.join('\n---\n')}`).toEqual([]);
});

export {
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
  FakeWebSocket,
  fakeStream,
};
