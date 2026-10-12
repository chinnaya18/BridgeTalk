import { useCallback, useEffect, useState } from 'react';

import { canonicalEngineId } from '../services/stt';

/**
 * Settings the user changes in the meeting, remembered per user.
 *
 * WHY PER USER, AND WHY localStorage RATHER THAN sessionStorage
 * ------------------------------------------------------------
 * The specification says "preferences are remembered per user". These are
 * durable choices about how the product behaves — caption size, which
 * recognition model, which speech engine — not per-meeting choices, so unlike
 * device selection (sessionStorage, deliberately, see devicePreferences.js)
 * they should survive closing the tab.
 *
 * The key is namespaced by user id so two people sharing a laptop, which is
 * exactly what happens when this is demonstrated, do not inherit each other's
 * caption size. A null id falls back to a shared key rather than throwing,
 * because preferences must not be what breaks a page.
 *
 * WHY IT IS NOT ON THE SERVER
 * ---------------------------
 * It could be, and a `user_preferences` table would survive a change of
 * machine. It is not, because every one of these settings is about THIS
 * browser's rendering and THIS browser's engine support — a Whisper preference
 * means nothing on a device whose browser has Web Speech — and because adding a
 * table and two endpoints to remember a font size is not a trade worth making
 * here. The cost is honest and small: preferences do not follow you to another
 * computer.
 *
 * Every access is wrapped. localStorage throws in a private window with site
 * data blocked, and a remembered caption size must never stop a meeting
 * loading.
 */

export const DEFAULT_PREFERENCES = {
  captionSize: 'normal', // normal | large | xlarge
  speechEngine: 'auto', // auto | webspeech | whisper
  // en-IN, not en-US: the demo is in India and the Indian English acoustic
  // model recognises local accents markedly better.
  speechLanguage: 'en-IN',
  recognitionMode: 'dynamic', // dynamic (words) | isl (ISL letters) | static (ASL letters)
  showHandOverlay: true,
};

const VALID = {
  captionSize: ['normal', 'large', 'xlarge'],
  speechEngine: ['auto', 'webspeech', 'whisper'],
  recognitionMode: ['dynamic', 'isl', 'static'],
};

function keyFor(userId) {
  return `bridgetalk.prefs.${userId ?? 'anon'}`;
}

/**
 * Discard anything that is not a value this build understands.
 *
 * A stored preference outlives the code that wrote it. `recognitionMode:
 * 'words'` from an older build would otherwise be handed to the socket, which
 * would reject every frame — a meeting broken by a stale localStorage entry,
 * with nothing on screen to explain it.
 */
function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCES;

  const clean = { ...DEFAULT_PREFERENCES };
  Object.keys(DEFAULT_PREFERENCES).forEach((name) => {
    let value = raw[name];
    if (value === undefined) return;

    // Migrate a stored engine id from before the K-1 fix. Without this, a user
    // who had selected "Browser" keeps the old 'browser' value in
    // localStorage, it fails validation, and they are silently moved to
    // 'auto' — which works, but loses a choice they deliberately made.
    if (name === 'speechEngine') value = canonicalEngineId(value);

    if (VALID[name]) {
      if (VALID[name].includes(value)) clean[name] = value;
      return;
    }
    if (typeof DEFAULT_PREFERENCES[name] === 'boolean') {
      if (typeof value === 'boolean') clean[name] = value;
      return;
    }
    if (typeof value === 'string' && value.length <= 20) clean[name] = value;
  });
  return clean;
}

export function useMeetingPreferences(userId) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return sanitise(JSON.parse(localStorage.getItem(keyFor(userId)) ?? 'null'));
    } catch {
      return DEFAULT_PREFERENCES;
    }
  });

  // Re-read when the user changes. On first render `userId` is often undefined
  // because /api/auth/me has not answered yet, so without this the session runs
  // on the shared "anon" preferences for its whole duration.
  useEffect(() => {
    try {
      setPreferences(sanitise(JSON.parse(localStorage.getItem(keyFor(userId)) ?? 'null')));
    } catch {
      setPreferences(DEFAULT_PREFERENCES);
    }
  }, [userId]);

  const update = useCallback(
    (patch) => {
      setPreferences((current) => {
        const next = sanitise({ ...current, ...patch });
        try {
          localStorage.setItem(keyFor(userId), JSON.stringify(next));
        } catch {
          // Preferences stay in memory for this session. Not worth telling the
          // user about: nothing they can do, and nothing is lost until reload.
        }
        return next;
      });
    },
    [userId],
  );

  return { preferences, update };
}
