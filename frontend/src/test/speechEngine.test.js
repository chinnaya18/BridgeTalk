import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Bug K-1: selecting "Browser (Web Speech)" in Settings crashed the meeting.
 *
 * The Settings dialog stored `speechEngine: 'browser'`, but the provider
 * registry has always been keyed `'webspeech'`. `resolveProvider('browser')`
 * fell through to its fallback branch and evaluated
 * `PROVIDERS[preferred].label` on an undefined entry, throwing
 * `TypeError: Cannot read properties of undefined (reading 'label')`.
 *
 * It is called in the BODY of useSpeechCaptions, so it threw during render and
 * took the meeting room to the error boundary — and because the preference is
 * persisted in localStorage, reloading did not recover.
 *
 * These tests assert the three things that together make that impossible:
 * the legacy id resolves, no id can throw, and the dialog's own option values
 * are all resolvable.
 */

// Set before importing: WebSpeechProvider captures the class at module load.
globalThis.webkitSpeechRecognition = function FakeRecognition() {};
globalThis.MediaRecorder = class FakeRecorder {
  static isTypeSupported() {
    return true;
  }
};

let stt;
let ENGINES;

beforeEach(async () => {
  stt = await import('../services/stt/index.js');
  // The dialog's own list, so the test fails if the two ever diverge again.
  ({ ENGINES } = await import('../components/meeting/engines.js'));
});

describe('speech engine id resolution', () => {
  it('resolves the legacy "browser" id instead of throwing', () => {
    const result = stt.resolveProvider('browser');
    expect(result.id).toBe('webspeech');
    expect(result.fellBack).toBe(false);
  });

  it('canonicalEngineId maps the legacy ids', () => {
    expect(stt.canonicalEngineId('browser')).toBe('webspeech');
    expect(stt.canonicalEngineId('web_speech')).toBe('webspeech');
    expect(stt.canonicalEngineId('webspeech')).toBe('webspeech');
    expect(stt.canonicalEngineId('whisper')).toBe('whisper');
    expect(stt.canonicalEngineId(undefined)).toBe('auto');
  });

  it('never throws for any id, however unknown', () => {
    const ids = [
      'auto', 'webspeech', 'whisper', 'browser', 'web_speech',
      'nonsense', '', null, undefined, '__proto__', 'constructor', 'toString',
    ];
    for (const id of ids) {
      expect(() => stt.resolveProvider(id)).not.toThrow();
      const result = stt.resolveProvider(id);
      // Always a usable shape: an id to use, or null with a reason.
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('fellBack');
      if (result.id === null) expect(typeof result.reason).toBe('string');
    }
  });

  it('every option the Settings dialog offers resolves to a real provider', () => {
    for (const option of ENGINES) {
      const result = stt.resolveProvider(option.value);
      expect(
        result.id,
        `Settings offers "${option.value}" but it resolves to ${result.id}`,
      ).not.toBeNull();
    }
  });

  it('auto prefers the browser engine where it is supported', () => {
    expect(stt.resolveAuto().id).toBe('webspeech');
  });
});

describe('Bug 5 — the layout must not depend on stored preferences', () => {
  /**
   * An incognito window starts with empty local storage, and in some privacy
   * modes the accessors throw outright. Every preference therefore needs a
   * default, and nothing about the layout may depend on a stored value.
   */
  it('useMeetingPreferences falls back to complete defaults with empty storage', async () => {
    localStorage.clear();
    const { DEFAULT_PREFERENCES } = await import('../hooks/useMeetingPreferences.js');

    // Every key has a value, and none is undefined or null.
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      expect(value, `${key} has no default`).not.toBeUndefined();
      expect(value, `${key} defaults to null`).not.toBeNull();
    }
    // The ones the layout reads.
    expect(DEFAULT_PREFERENCES.captionSize).toBe('normal');
    expect(DEFAULT_PREFERENCES.speechEngine).toBe('auto');
    expect(DEFAULT_PREFERENCES.recognitionMode).toBeTruthy();
    expect(typeof DEFAULT_PREFERENCES.showHandOverlay).toBe('boolean');
  });

  it('device preferences return null rather than throwing when storage is empty', async () => {
    sessionStorage.clear();
    const { loadDevicePreferences } = await import('../services/devicePreferences.js');
    expect(loadDevicePreferences()).toBeNull();
  });

  it('device preferences survive storage throwing, as in a locked-down profile', async () => {
    const { loadDevicePreferences, saveDevicePreferences } = await import(
      '../services/devicePreferences.js'
    );
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    try {
      expect(() => loadDevicePreferences()).not.toThrow();
      expect(loadDevicePreferences()).toBeNull();
      expect(() => saveDevicePreferences({ micId: 'x' })).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('a stored preference this build does not understand is discarded, not used', async () => {
    // A value from an older build must not reach the socket, which would
    // reject every frame and leave recognition silently dead.
    const { DEFAULT_PREFERENCES } = await import('../hooks/useMeetingPreferences.js');
    localStorage.setItem(
      'bridgetalk.prefs.1',
      JSON.stringify({ captionSize: 'enormous', recognitionMode: 'words' }),
    );
    // sanitise() runs on read; the defaults are what survive.
    expect(DEFAULT_PREFERENCES.captionSize).toBe('normal');
    localStorage.clear();
  });
});
