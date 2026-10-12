import { SttProvider } from './SttProvider';
import { WebSpeechProvider } from './WebSpeechProvider';
import { WhisperProvider } from './WhisperProvider';

/**
 * Provider selection and browser-support detection.
 *
 * PROBLEM: browser support. The Web Speech API is Chromium-only in practice —
 * Firefox has none and Safari's is partial and unreliable. Rather than letting
 * the caption bar sit silently empty in those browsers, `resolveProvider`
 * falls back to Whisper automatically and reports WHICH provider was chosen so
 * the UI can say so plainly.
 */

export const ENGINE_CHOICES = [
  { id: 'auto', label: 'Auto', note: 'Browser engine where available, Whisper otherwise.' },
  { id: 'webspeech', label: 'Browser', note: 'Word-by-word. Chrome/Edge only. Audio goes to Google.' },
  { id: 'whisper', label: 'Whisper', note: 'Runs on this project’s backend. Captions appear when you pause.' },
];

export const PROVIDERS = {
  webspeech: {
    id: 'webspeech',
    label: 'Web Speech',
    Provider: WebSpeechProvider,
    // Honest about the trade-off, shown in the UI rather than buried here.
    note: 'Fast, word-by-word. Chrome/Edge only. Audio is sent to Google.',
  },
  whisper: {
    id: 'whisper',
    label: 'Whisper',
    Provider: WhisperProvider,
    note: 'Runs on this project’s backend. Any browser. No partial text.',
  },
};

export const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'ta-IN', label: 'Tamil' },
];

export function isProviderSupported(id) {
  return Boolean(PROVIDERS[id]?.Provider.isSupported());
}

/**
 * Pick a provider, honouring a preference where possible.
 *
 * Returns the id actually chosen along with why, so the caller can tell the
 * user "you asked for Web Speech, this browser has none, using Whisper"
 * instead of silently doing something different from what was requested.
 */
/**
 * "Auto" is the default, and it exists because the two engines are not
 * interchangeable from a user's point of view.
 *
 * Web Speech streams interim text word by word, so captions appear while you
 * are still talking. Whisper transcribes finished audio, so nothing appears
 * until you pause — correct, but it reads as a broken feature if you were not
 * told. Auto therefore prefers Web Speech wherever it exists and falls back
 * only when it genuinely cannot run.
 *
 * Whisper must NOT be the default in Chrome or Edge, which is what the
 * reported "spoke and nothing happened" turned out to be: Whisper was
 * selected, it was waiting for an utterance to end, and the status line said
 * "listening" the whole time.
 */
export function resolveAuto() {
  if (isProviderSupported('webspeech')) {
    return {
      id: 'webspeech',
      fellBack: false,
      reason: null,
    };
  }
  if (isProviderSupported('whisper')) {
    return {
      id: 'whisper',
      fellBack: true,
      reason:
        'This browser has no Web Speech API, so Whisper is being used. ' +
        'Captions appear when you pause rather than word by word.',
    };
  }
  return { id: null, fellBack: false, reason: 'No speech engine works in this browser.' };
}

/**
 * Legacy preference values, mapped to the id the registry actually uses.
 *
 * The Settings dialog shipped offering `'browser'` while PROVIDERS has always
 * been keyed `'webspeech'`. That value is persisted in localStorage, so it
 * outlives the fix and has to keep resolving rather than being rejected.
 */
const LEGACY_IDS = { browser: 'webspeech', web_speech: 'webspeech' };

/** Map a stored or requested engine id onto a canonical one. */
export function canonicalEngineId(id) {
  if (!id) return 'auto';
  return LEGACY_IDS[id] ?? id;
}

export function resolveProvider(preferred = 'auto') {
  // Accept a legacy id rather than falling through to the unknown-id path.
  const requested = canonicalEngineId(preferred);

  if (requested === 'auto') return resolveAuto();

  if (isProviderSupported(requested)) {
    return { id: requested, fellBack: false, reason: null };
  }

  const fallback = Object.keys(PROVIDERS).find(
    (id) => id !== requested && isProviderSupported(id),
  );

  if (fallback) {
    // `PROVIDERS[requested]` is read through optional chaining DELIBERATELY.
    //
    // This line used to be `PROVIDERS[preferred].label`, and that was bug K-1.
    // The Settings dialog stored `'browser'`, which is not a registry key, so
    // this dereferenced `undefined` and threw
    // "Cannot read properties of undefined (reading 'label')".
    // resolveProvider is called in the BODY of useSpeechCaptions, so it threw
    // during render and took the meeting room to the error boundary — and
    // because the preference is persisted, reloading did not recover.
    //
    // The id mapping above fixes the specific case. This stays defensive
    // because an unknown engine id must degrade to a working engine, never
    // crash the meeting.
    const label = PROVIDERS[requested]?.label ?? requested;
    return {
      id: fallback,
      fellBack: true,
      reason:
        requested === 'webspeech'
          ? 'This browser has no Web Speech API, so Whisper is being used instead.'
          : `The ${label} provider is unavailable here.`,
    };
  }

  return {
    id: null,
    fellBack: false,
    reason: 'No speech provider works in this browser.',
  };
}

export function createProvider(id, options) {
  const entry = PROVIDERS[id];
  if (!entry) throw new Error(`Unknown speech provider: ${id}`);
  return new entry.Provider(options);
}

export { SttProvider, WebSpeechProvider, WhisperProvider };
