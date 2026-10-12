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
