# BridgeTalk — bug-fix log

Five reported bugs, fixed in order. For each: how it was reproduced, the root
cause in the code, the fix, and the test that would have caught it.

**Rule followed throughout:** nothing that passed in the baseline may fail. The
suites are re-run after every fix and the result recorded here.

---

## Baseline — before any change

Commit at baseline: **`c59fcad`**, branch `client`, working tree clean.
Recorded 2026-10-12.

| Suite | Command | Result |
|---|---|---|
| Backend | `pytest backend/tests -q` | **258 passed, 2 skipped**, 1 warning (74.88 s) |
| Frontend lint | `npm run lint` | **0 errors, 6 warnings** |
| Frontend tests | `npx vitest run` | **13 passed** (1 file) |
| Frontend build | `npx vite build` | **succeeded** (4.05 s) |

The 2 skipped backend tests are conditional by design — both skip because
faster-whisper **is** installed on this machine, so the Whisper-absent failure
paths cannot run. The 6 lint warnings are 5 × `react-refresh/only-export-components`
(files that deliberately export a hook beside a component) and 1 pre-existing
`react-hooks/exhaustive-deps` in `SignDetection.jsx`.

### Protected behaviour — must not change

Per the brief, these are left exactly as they are and re-checked after each fix:

login · registration · meeting creation and joining · the lobby · the video
call · screen sharing · the caption protocol (`segment_id`, interim and final
events) · one transcript row per final segment · transcript download · the
settings dialog · keyboard shortcuts · the signer's own detection pill with
undo and clear · the `?debug=1` overlay

---

## Fix 1 — K-1: selecting "Browser (Web Speech)" crashed the meeting room

Prerequisite of Bug 1, so done first.

### Reproduced

Ran the real `services/stt/index.js` under Vitest with
`webkitSpeechRecognition` and `MediaRecorder` stubbed **before** import (the
provider captures the recognition class at module load, so stubbing after the
import does nothing):

| Stored value | `resolveProvider` result |
|---|---|
| `'auto'` | `{id: 'webspeech', fellBack: false}` |
| **`'browser'`** | **`TypeError: Cannot read properties of undefined (reading 'label')`** |
| `'webspeech'` | `{id: 'webspeech', fellBack: false}` |
| `'whisper'` | `{id: 'whisper', fellBack: false}` |

### Root cause

Three files disagreed about the engine's id.

- `services/stt/index.js` keys its `PROVIDERS` registry **`webspeech`**.
- `components/meeting/SettingsDialog.jsx` offered **`'browser'`**.
- `hooks/useMeetingPreferences.js` accepted `['auto', 'browser', 'whisper']`,
  so the wrong value passed validation and was persisted.

Selecting the option stored `'browser'`, which reached
`resolveProvider('browser')`. There is no `PROVIDERS['browser']`, so the
supported-check failed, the fallback branch ran, and the reason string was
built as:

```js
preferred === 'webspeech'
  ? '…'
  : `The ${PROVIDERS[preferred].label} provider is unavailable here.`
```

`preferred` was `'browser'`, so the else branch dereferenced `.label` on
`undefined` and threw.

**Why it took the whole page down:** `resolveProvider` is called in the *body*
of `useSpeechCaptions`, not inside a callback, so it threw **during render** and
React escalated it to the nearest error boundary. **Why reloading did not
recover:** the preference is persisted in `localStorage`, so the meeting room
stayed unopenable for that user until browser storage was cleared.

### Fix

Three layers, because any one alone would leave the class of bug possible.

| File | Change |
|---|---|
| `services/stt/index.js` | New `canonicalEngineId()` maps legacy ids (`browser`, `web_speech`) onto `webspeech`, so a value already in someone's `localStorage` keeps working. `resolveProvider` now reads `PROVIDERS[requested]?.label ?? requested` — **defensive on purpose**, so an unknown id can never crash the meeting again |
| `components/meeting/engines.js` *(new)* | `ENGINES`, `CAPTION_SIZES` and `LANGUAGES` extracted out of the component file. They were module-private constants, which is exactly why nothing could test that the dialog's values matched the registry |
| `SettingsDialog.jsx` | Imports those lists; its engine value is now `'webspeech'` |
| `useMeetingPreferences.js` | Accepts `['auto', 'webspeech', 'whisper']`, and `sanitise()` runs a stored `speechEngine` through `canonicalEngineId` so an old `'browser'` value is **migrated** rather than silently reset to `'auto'` — which would have worked but lost a choice the user deliberately made |

### Test

`frontend/src/test/speechEngine.test.js` — 5 tests:

1. the legacy `'browser'` id resolves to `webspeech` instead of throwing
2. `canonicalEngineId` maps every legacy id
3. **`resolveProvider` never throws for any id** — including `''`, `null`,
   `undefined`, `'__proto__'`, `'constructor'`, `'toString'`
4. **every option the Settings dialog offers resolves to a real provider** —
   this is the test that makes the divergence impossible to reintroduce
5. `auto` prefers the browser engine where supported

**Verified to bite.** Reintroducing the exact original fault (removing the id
mapping and the optional chaining, and putting `'browser'` back in `ENGINES`)
makes **3 of the 5 fail** with the original
`TypeError: Cannot read properties of undefined (reading 'label')`. Restoring
the fix makes them pass again.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **258 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **18 passed** (+5 new) |
| Build | succeeded | **succeeded** |

Nothing regressed.

---
