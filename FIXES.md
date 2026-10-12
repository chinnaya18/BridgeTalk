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

## Fix 2 — Bug 1: captions shown line by line instead of flowing

### Reproduced

Read the rendering path. `CaptionRail.jsx` mapped the store's entries directly:

```jsx
recent.map((caption) => (
  <article key={caption.segmentId}>
    <Avatar …/><span>{caption.speakerName}</span><SourceBadge …/>
    <p>{caption.text}</p>
  </article>
))
```

One `<article>` per **segment**, each with its own avatar, name, badge and
paragraph.

### Root cause

A *segment* is an utterance boundary, not a line of display. `useSignCaptions`
closes a segment after `UTTERANCE_END_MS` (1500 ms) at rest, and
`WebSpeechProvider` closes one on every `isFinal` result — so a 1.5-second pause
while signing, or any natural pause while speaking, ends the segment. The
renderer treated each one as a separate caption, so the rail accumulated
one-line entries and read as a list.

Nothing was wrong with the protocol. The segment boundaries are correct and the
transcript needs them. **The display was wrong to show them.**

### Fix

| File | Change |
|---|---|
`utils/captionBlocks.js` *(new)* | `buildCaptionBlocks(captions, {now, …})` — a **pure function** that groups consecutive segments from one speaker into a block with one avatar, one name and one continuous paragraph |
`components/meeting/CaptionRail.jsx` | Renders blocks instead of segments. Settled text and the open interim are `<span>`s inside **one** `<p>`, so the interim continues the sentence rather than starting a line |
`config/recognition.js` | New `CAPTIONS` section holding every display value |

**Grouping rules, all in the pure function:**

- A new block starts when a **different speaker** produces a caption, or when
  the same speaker resumes **after `BLOCK_CONTINUE_WINDOW_MS`**. Any shorter
  pause **appends to the same paragraph**.
- The trailing segment, while still open, is the **interim tail**, rendered in
  `#BDC1C6`; everything before it is settled, rendered white.
- A block is marked `fadingOut` once older than `BLOCK_TTL_MS`, and is dropped
  once the fade has finished.
- At most `MAX_VISIBLE_BLOCKS` are returned, **oldest dropped first**.

**Config values** (`config/recognition.js` → `CAPTIONS`):

| Value | Setting |
|---|---|
| `BLOCK_TTL_MS` | **5000** — as specified |
| `BLOCK_FADE_MS` | 600 |
| `MAX_VISIBLE_BLOCKS` | **2** — as specified |
| `VISIBLE_LINES` | **3** — as specified |
| `BLOCK_CONTINUE_WINDOW_MS` | 5000 |
| `SIGN_INTERIM_THROTTLE_MS` | **200** — 5 updates/second, as specified |

**Three lines, newest in the same place.** The paragraph is wrapped in a
container with `maxHeight = lineHeight × VISIBLE_LINES` and `overflow: hidden`,
scrolled to the bottom on every update. Text grows downward, older lines move up
and out, and the newest words stay put. `scrollTop` is assigned directly, not
`scrollIntoView({behavior:'smooth'})`, which would queue animations faster than
they finish at interim rates.

**A block disappears on its own.** `CaptionRail` ticks a 250 ms interval **only
while captions are on screen**, so an idle meeting does no work.

**This is display-only.** `useCaptionStore`, the socket protocol, the
`segment_id` scheme, `persist_final_caption`, the live transcript panel and the
saved transcript are all untouched.

### Real-time captions while the person is still going

**Sign — already partly there, now rate-limited.** `commitToken` already called
`emit(…, false)` the moment each word or letter was committed, so interim
updates were already being sent before the segment closed. What was missing was
the throttle.

`utils/interimThrottle.js` *(new)* — leading-edge **plus a trailing flush**:

- the first update goes immediately;
- updates inside the window overwrite **one pending slot**;
- the pending text is sent when the window closes.

It **coalesces rather than drops**, which matters because an interim carries the
*full current text*: a plain throttle would discard the last update before a
pause, leaving the other side a word short and making the final appear to jump.
`flush()` sends a final immediately and cancels anything pending, so a stale
interim can never arrive after a segment closed.

**Speech — confirmed, and one genuine loss path closed.** Verified in
`WebSpeechProvider.js`:

| Requirement | Status |
|---|---|
| `lang = 'en-IN'` | Confirmed — the constructor default, line 41 |
| `continuous = true` | Confirmed — line 91 |
| `interimResults = true` | Confirmed — line 95 |
| Echo cancellation, noise suppression, auto gain | Confirmed — requested in both `Lobby.jsx` and `MeetingRoom.jsx`, on the initial stream and on every device change |
| Restarted when Chrome stops it after silence | Confirmed — `onend` restarts with exponential backoff, a 40-restart ceiling, and the budget **refunded** after a healthy run |
| **Without losing words** | **A loss path existed. Fixed.** |

**The loss path.** Chrome usually delivers a final before `onend`, but not
always — a network blip can end a session with an interim still outstanding.
That interim had been sent as a non-final update of an **open** segment, so the
next session's interims **replaced** it, and the words heard just before the
restart vanished from both screens *and from the transcript*.

The provider now retains `_pendingInterim` and, on a restart with one
outstanding, commits it as a final before the new session begins — closing the
segment properly, keeping the text, and writing one transcript row.

Whisper remains the fallback for browsers without Web Speech, as specified;
`resolveAuto()` prefers the browser engine wherever it exists.

### Measured accuracy and idle false positives

Re-measured now, not quoted from an earlier run.

`python ml/scripts/test_inference_path.py` — held-out samples through the **live**
inference path:

| Model | Held-out samples | Top-1 | Median latency | p95 |
|---|---|---|---|---|
| ASL letters | 6,440 | **0.9053** | 0.68 ms | 0.76 ms |
| ISL fingerspelling | 6,343 | **0.9814** | 0.70 ms | 0.81 ms |
| ISL words | 149 clips | **0.8523** | 7.83 ms | 10.48 ms |

`python ml/scripts/measure_gates.py` — with the live gates applied
(confidence ≥ 0.70, margin ≥ 0.15):

| Model | Accepted | Rejected | Accuracy of accepted | Accuracy overall |
|---|---|---|---|---|
| ISL words | 141/149 | 8 (5.4 %) | **0.8865** | 0.8389 |
| ISL fingerspelling | 6,327/6,343 | 16 (0.2 %) | **0.9837** | 0.9812 |

**Idle false-positive rate** — 400 trials per condition, input containing no
sign at all:

| Model | Idle input | Passed the gates | Rate |
|---|---|---|---|
| ISL words | all-zero frames | 0/400 | **0.0 %** |
| ISL words | a frozen pose | 227/400 | **56.8 %** |
| ISL words | random landmarks | 209/400 | 52.2 % |
| ISL fingerspelling | all-zero frames | 400/400 | **100.0 %** |
| ISL fingerspelling | random landmarks | 327/400 | 81.8 % |

**These are the worst case, with motion gating removed.** A resting hand *is* a
valid handshape, so the model answers it confidently and **no confidence or
margin threshold can reject it**. Only the motion gate can, and it lives in the
browser. Confirmed present in `useSignCaptions`:

| Gate | Config value | Confirmed |
|---|---|---|
| Confidence floor | `MIN_CONFIDENCE` 0.70 | Yes |
| Margin over second-best | `MIN_MARGIN` 0.15 | Yes |
| Letter stability window | `LETTER_STABLE_FRAMES` 6 | Yes |
| No-repeat until rest | `REQUIRE_REST_BEFORE_REPEAT` true | Yes |
| **Parked-hand / motion gate** | `MOTION_LOOKBACK_FRAMES` 20 | Yes — this is what makes a resting hand produce nothing |

**No accuracy is claimed beyond these numbers.** In particular, no model has
been evaluated on an unseen signer, because no dataset in use records signer
identity.

### Tests

| File | Tests | Covers |
|---|---|---|
`src/test/captionBlocks.test.js` | **16** | Merging consecutive segments; a short pause appends; a long gap starts a new block; a different speaker starts a new block; interleaved speakers; interim replaced in place; interim → settled on final; fade and expiry; the 2-block cap dropping oldest first; empty/null/malformed input; whitespace collapsing; an unparseable timestamp |
`src/test/interimThrottle.test.js` | **9** | First update immediate; rapid updates coalesced to the **newest** text; the last interim before a pause never lost; rate held at or below the interval over 50 updates; `flush` immediate even inside the window; **`flush` cancels a pending interim** so a stale one cannot follow a final; a new segment starts with no delay; `reset` drops without sending |
`src/test/webSpeechRestart.test.js` | **8** | `continuous`/`interimResults`/`lang` actually set; default `en-IN`; auto-restart while wanted; **no** restart after a deliberate stop; **an outstanding interim committed rather than lost**; no double-commit when a final did arrive; nothing rescued when nothing was heard; results read from `resultIndex` so text is never re-emitted |

Two were **verified to bite**: removing the interim rescue fails
`commits an outstanding interim as a final rather than losing it`; two of the
caption-block tests failed during development and found two real defects in the
first implementation — an unparseable timestamp fell back to `Date.now()` instead
of the injected clock, making expiry depend on wall-clock time.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **258 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **51 passed** (+38) |
| Build | succeeded | **succeeded** |

Nothing regressed.

### Needs a human

Bug 1's visual result cannot be verified from a terminal. See the two-device
script at the end of this file: steps **B1-1** to **B1-6**.

---
