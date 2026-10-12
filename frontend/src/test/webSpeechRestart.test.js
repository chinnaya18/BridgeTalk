import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bug 1 asks for confirmation that recognition restarts when Chrome stops it
 * after silence, "without losing words".
 *
 * It restarted correctly, but there was a loss path. Chrome usually delivers a
 * final result before `onend`; when it does not, the outstanding interim had
 * been sent as a non-final update of an OPEN segment, so the next session's
 * interims replaced it and the words heard just before the restart vanished
 * from both screens and from the transcript.
 */

// A minimal stand-in for the browser's SpeechRecognition, capturing the
// handlers the provider attaches so a test can fire them.
class FakeRecognition {
  static instances = [];

  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 0;
    this.started = false;
    FakeRecognition.instances.push(this);
  }

  start() {
    this.started = true;
    this.onstart?.();
  }

  abort() {
    this.started = false;
  }

  /** Deliver one result set, as Chrome's cumulative `results` array. */
  emitResult(entries, resultIndex = 0) {
    const results = entries.map((e) => {
      const alt = { transcript: e.text, confidence: e.confidence ?? 0 };
      return Object.assign([alt], { isFinal: Boolean(e.isFinal), length: 1 });
    });
    this.onresult?.({ resultIndex, results: Object.assign(results, { length: results.length }) });
  }

  endSession() {
    this.onend?.();
  }
}

let WebSpeechProvider;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  globalThis.webkitSpeechRecognition = FakeRecognition;
  globalThis.SpeechRecognition = undefined;
  vi.resetModules();
  ({ WebSpeechProvider } = await import('../services/stt/WebSpeechProvider.js'));
});

function startProvider() {
  const provider = new WebSpeechProvider({ language: 'en-IN' });
  const interims = [];
  const finals = [];
  provider.onInterim = (text) => interims.push(text);
  provider.onFinal = (text, confidence) => finals.push({ text, confidence });
  provider.onError = () => {};
  provider.onStateChange = () => {};
  provider.start();
  return { provider, interims, finals };
}

describe('WebSpeechProvider settings', () => {
  it('sets continuous, interimResults and the language', () => {
    startProvider();
    const recognition = FakeRecognition.instances[0];
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.lang).toBe('en-IN');
  });

  it('defaults the language to en-IN', () => {
    const provider = new WebSpeechProvider();
    expect(provider.language).toBe('en-IN');
  });
});

describe('WebSpeechProvider restart after silence', () => {
  it('restarts automatically when the session ends while still wanted', () => {
    startProvider();
    expect(FakeRecognition.instances).toHaveLength(1);

    FakeRecognition.instances[0].endSession();
    vi.advanceTimersByTime(1000);

    expect(FakeRecognition.instances.length).toBeGreaterThan(1);
    expect(FakeRecognition.instances[1].started).toBe(true);
  });

  it('does NOT restart after a deliberate stop', async () => {
    const { provider } = startProvider();
    await provider.stop();
    vi.advanceTimersByTime(5000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('commits an outstanding interim as a final rather than losing it', () => {
    const { interims, finals } = startProvider();
    const recognition = FakeRecognition.instances[0];

    // Words are heard, but no final arrives before the session ends.
    recognition.emitResult([{ text: 'the dataset is ready', isFinal: false }]);
    expect(interims).toEqual(['the dataset is ready']);
    expect(finals).toEqual([]);

    recognition.endSession();

    // THE ASSERTION THAT MATTERS: the words survive the restart.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('the dataset is ready');
    // No confidence was reported for an interim; null is honest where 0 would
    // read as "certainly wrong".
    expect(finals[0].confidence).toBeNull();
  });

  it('does not double-commit when a final did arrive before the session ended', () => {
    const { finals } = startProvider();
    const recognition = FakeRecognition.instances[0];

    recognition.emitResult([{ text: 'good morning', isFinal: false }]);
    recognition.emitResult([{ text: 'good morning', isFinal: true, confidence: 0.9 }]);
    expect(finals).toHaveLength(1);

    recognition.endSession();

    // Still one. The rescue must not fire for an utterance already settled.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('good morning');
  });

  it('does not rescue anything when nothing was heard', () => {
    const { finals } = startProvider();
    FakeRecognition.instances[0].endSession();
    expect(finals).toEqual([]);
  });

  it('reads results from resultIndex, so text is never re-emitted', () => {
    const { finals } = startProvider();
    const recognition = FakeRecognition.instances[0];

    // Chrome's results array is cumulative for the whole session. Re-reading
    // it from 0 would re-emit everything already committed.
    recognition.emitResult([{ text: 'first', isFinal: true, confidence: 0.8 }], 0);
    recognition.emitResult(
      [{ text: 'first', isFinal: true, confidence: 0.8 }, { text: 'second', isFinal: true, confidence: 0.8 }],
      1,
    );

    expect(finals.map((f) => f.text)).toEqual(['first', 'second']);
  });
});
