import { SttProvider } from './SttProvider';

/**
 * Speech recognition via the browser-native Web Speech API.
 *
 * The recognition logic here is carried over unchanged from the hook that
 * previously owned it — every fix below was found by using it, not by reading
 * the spec, and none of it was rewritten during the move.
 *
 * THE HONEST PRIVACY NOTE
 * -----------------------
 * In Chrome this is NOT local. Audio goes to Google's servers for recognition.
 * For an accessibility tool carrying private conversation that is a real cost,
 * and it sits oddly beside BridgeTalk's "video never leaves your machine"
 * claim on the sign side. It is documented rather than glossed over, and the
 * Whisper provider is the answer for anyone who cannot accept it.
 */

const SpeechRecognitionClass =
  typeof window !== 'undefined'
    ? window.SpeechRecognition ?? window.webkitSpeechRecognition
    : undefined;

// Chrome ends recognition on its own after roughly a minute of silence. We
// restart it, but a restart that fails immediately and retries forever would
// spin the CPU and hammer the recognition service, so the loop is bounded and
// backed off. Both numbers are deliberately generous: a real meeting has long
// quiet stretches, and hitting the ceiling should mean something is genuinely
// broken rather than that somebody stopped talking.
const MAX_RESTARTS = 40;
const RESTART_BASE_MS = 300;
const RESTART_MAX_MS = 5_000;

// A restart that survives this long is evidence recognition is healthy again,
// so the failure budget is returned. Without this, forty scattered restarts
// over an hour-long meeting would exhaust the budget even though every one of
// them worked.
const HEALTHY_RUN_MS = 15_000;

export class WebSpeechProvider extends SttProvider {
  constructor({ language = 'en-IN' } = {}) {
    super();
    this.name = 'Web Speech';
    // The whole reason this provider feels responsive: text appears while you
    // are still talking, rather than after you stop.
    this.providesInterim = true;

    this.language = language;
    this._recognition = null;
    this._wantListening = false;
    this._restarts = 0;
    this._restartTimer = null;
    this._startedAt = 0;
    // The last interim text sent for the currently open segment, or '' when
    // there is none outstanding. Used to rescue words if the session ends
    // before delivering its final — see `onend`.
    this._pendingInterim = '';
    this._state = 'idle';
  }

  static isSupported() {
    return Boolean(SpeechRecognitionClass);
  }

  setLanguage(language) {
    this.language = language;
    // A live SpeechRecognition ignores `lang` changes, so switching languages
    // means cycling recognition. Doing it only while listening avoids
    // resurrecting a session the user deliberately stopped.
    if (this._wantListening) {
      this._teardown();
      this.start();
    }
  }

  async start() {
    if (!WebSpeechProvider.isSupported()) {
      this._setState('unsupported');
      this.onError('unsupported', 'This browser has no Web Speech API. Use Chrome or Edge.');
      return;
    }

    this._wantListening = true;
    this._restarts = 0;
    this._begin();
  }

  _begin() {
    if (this._recognition) return;

    const recognition = new SpeechRecognitionClass();
    recognition.lang = this.language;
    // continuous: keep listening through pauses. This is a conversation, not
    // a single voice command.
    recognition.continuous = true;
    // interimResults: emit partial text as it is heard. Captions that appear
    // word by word feel responsive; captions that appear only at the end of a
    // sentence feel broken.
    recognition.interimResults = true;
    // We only ever use alternative 0, so asking for more is wasted work.
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this._startedAt = Date.now();
      this._setState('listening');
    };

    recognition.onresult = (event) => {
      let interim = '';

      // PROBLEM: duplicate text. `event.results` is cumulative for the whole
      // session, so re-reading it from 0 on every event re-emits everything
      // already committed. Starting at `event.resultIndex` — the first result
      // that CHANGED — is what stops captions repeating themselves.
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result[0];

        if (result.isFinal) {
          // Only finals are committed. Interim text is revised word by word as
          // the recogniser hears more, so persisting it would fill the
          // transcript with half-sentences that were never said.
          const text = alternative.transcript.trim();
          if (text) {
            // This utterance is settled, so there is no longer an outstanding
            // interim to rescue if the session ends. See `onend`.
            this._pendingInterim = '';
            this.onFinal(
              text,
              // Chrome reports 0 for confidence on many results; null is
              // honest where 0 would read as "certainly wrong".
              typeof alternative.confidence === 'number' && alternative.confidence > 0
                ? alternative.confidence
                : null,
              Date.now(),
            );
          }
        } else {
          interim += alternative.transcript;
        }
      }

      if (interim.trim()) {
        // Retained so a session that ends before delivering its final can
        // still commit what was heard. See `onend`.
        this._pendingInterim = interim.trim();
        this.onInterim(this._pendingInterim);
      }
    };

    recognition.onerror = (event) => {
      // PROBLEM: routine errors. `no-speech` fires whenever somebody stops
      // talking for a moment and `aborted` fires whenever we stop recognition
      // ourselves. Both are completely normal in a meeting, and surfacing them
      // would have the UI crying wolf every few seconds.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Permission is not going to un-deny itself; stop trying.
        this._wantListening = false;
        this._setState('error');
        this.onError(
          'not-allowed',
          'Microphone permission denied. Allow it in your browser, then turn captions on again.',
        );
      } else if (event.error === 'network') {
        this.onError(
          'network',
          'Speech recognition needs a network connection and could not reach it.',
        );
      } else if (event.error === 'language-not-supported') {
        this._wantListening = false;
        this._setState('error');
        this.onError(
          'language-not-supported',
          `This browser cannot recognise ${this.language}. Try another language.`,
        );
      } else {
        this.onError(event.error, `Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      this._recognition = null;

      if (!this._wantListening) {
        this._setState('idle');
        return;
      }

      // PROBLEM: words lost across a restart.
      //
      // Chrome usually delivers a final result before `onend`, but not always —
      // a network blip or a service hiccup can end the session with an interim
      // still outstanding. That interim had been sent as a non-final update of
      // an OPEN segment, so the next session's interims would REPLACE it, and
      // the words heard just before the restart would vanish from both screens
      // and from the transcript.
      //
      // Committing it as a final here closes that segment properly: the text is
      // kept, one transcript row is written, and the next session starts a new
      // segment id. Confidence is null because none was reported for an
      // interim, and null is honest where 0 would read as "certainly wrong".
      if (this._pendingInterim) {
        const rescued = this._pendingInterim;
        this._pendingInterim = '';
        this.onFinal(rescued, null, Date.now());
      }

      // PROBLEM: auto-stop after silence. Chrome fires `onend` after a pause
      // even with continuous=true, so without restarting, captions die after
      // the first quiet stretch and the user has no idea why.
      //
      // A session that ran healthily for a while proves recognition works, so
      // its restart budget is refunded — otherwise a long meeting with many
      // legitimate restarts would eventually hit the ceiling and stop.
      if (Date.now() - this._startedAt > HEALTHY_RUN_MS) this._restarts = 0;

      if (this._restarts >= MAX_RESTARTS) {
        this._wantListening = false;
        this._setState('error');
        this.onError(
          'restart-limit',
          'Speech recognition kept stopping and could not be restarted. ' +
            'Reload the page, or switch to the Whisper provider.',
        );
        return;
      }

      // Exponential backoff, so a provider that is failing instantly does not
      // become a busy loop.
      const delay = Math.min(RESTART_BASE_MS * 2 ** this._restarts, RESTART_MAX_MS);
      this._restarts += 1;
      this._setState('idle');
      this._restartTimer = setTimeout(() => this._begin(), delay);
    };

    this._recognition = recognition;

    try {
      recognition.start();
    } catch {
      // start() throws if a session is somehow already running. onend will
      // fire and the restart path takes over, so there is nothing to do here.
    }
  }

  _teardown() {
    clearTimeout(this._restartTimer);
    // A deliberate stop detaches onend below, so the interim rescue there will
    // not run. Clear it so a stale value cannot leak into a later session.
    this._pendingInterim = '';
    const recognition = this._recognition;
    this._recognition = null;

    if (recognition) {
      // Detach onend BEFORE aborting, or our own teardown triggers the
      // auto-restart we just asked it to stop doing.
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        // Already dead.
      }
    }
  }

  async stop() {
    this._wantListening = false;
    this._teardown();
    this._setState('idle');
  }

  async pause() {
    // Web Speech owns its own microphone handle, so there is no cheaper pause
    // than a full stop. resume() rebuilds it.
    return this.stop();
  }

  async resume() {
    return this.start();
  }
}
