/**
 * The option lists the Settings dialog offers.
 *
 * WHY THESE LIVE OUTSIDE SettingsDialog.jsx
 * -----------------------------------------
 * `ENGINES[].value` must match a key in `PROVIDERS` in
 * `services/stt/index.js`. It did not: the dialog offered `'browser'` while the
 * registry was keyed `'webspeech'`, and selecting that option crashed the
 * meeting room (bug K-1).
 *
 * Nothing could have caught that, because the list was a module-private
 * constant inside a component file. Exporting it from here lets
 * `src/test/speechEngine.test.js` assert that every option the dialog offers
 * actually resolves to a real provider — so the two cannot diverge again
 * without a test failing.
 */

export const ENGINES = [
  { value: 'auto', label: 'Auto (recommended)' },
  // 'webspeech', not 'browser': this must match the PROVIDERS key in
  // services/stt/index.js. The mismatch was bug K-1.
  { value: 'webspeech', label: 'Browser (Web Speech)' },
  { value: 'whisper', label: 'Whisper (on the server)' },
];

export const CAPTION_SIZES = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
];

export const LANGUAGES = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'hi-IN', label: 'Hindi (India)' },
  { value: 'ta-IN', label: 'Tamil (India)' },
];
