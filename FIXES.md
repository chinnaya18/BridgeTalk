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

## Fix 3 — Bug 2: each user must see only the other person's captions

### Root cause

Not a defect so much as an unimplemented rule. The server broadcasts every
caption to **everyone including the sender** — deliberately, because that is
what makes both screens render from one source of truth rather than each side
assembling its own words from local state. `CaptionRail` then rendered
everything it was given, so each participant saw their own captions echoed back.

### Fix

One rule, applied in the display layer only: **the caption area shows captions
produced by other participants, never your own.**

| File | Change |
|---|---|
`utils/captionBlocks.js` | `excludeSpeakerId` option; a caption whose `speakerId` matches is filtered out before grouping |
`pages/MeetingRoom.jsx` | Passes `excludeSpeakerId={user?.id ?? null}` to `CaptionRail` |

Filtering happens **before** grouping, which matters: with your own interjection
removed, the two surrounding segments from the other speaker become adjacent and
**merge into one paragraph** rather than staying split by a gap that is no longer
there. There is a test for exactly that.

**What this covers.** On the hearing user's screen the only captions left are
the deaf user's sign captions; on the deaf user's screen, the hearing user's
speech captions. One rule produces both, and it still holds if a participant
uses the other mode — it filters by **speaker**, not by source.

**What is deliberately unchanged:**

- The server still broadcasts every caption to everyone.
- The **live transcript panel** still shows both sides — it reads the persisted
  rows, not this list.
- The **saved transcript** and both downloads still contain both sides.
- The signer still sees their own recognition live on their own tile's detection
  pill, with undo and clear.

### Tests

`src/test/captionBlocks.test.js` — **6 added** (22 total in the file): the
excluded speaker is dropped; the hearing user's screen shows only sign; the deaf
user's screen shows only speech; filtering is by speaker not source (a hearing
user who also signs still has their own signs hidden); nothing is filtered when
no speaker is excluded; **and removing your own segment merges the two speakers
around it**.

`src/test/pages.test.jsx` — **2 added**, both end-to-end through the real path:
a caption event is pushed into the fake WebSocket, parsed by `useSignSocket`,
applied by `useCaptionStore` and rendered by `CaptionRail`, with nothing stubbed
between the wire and the DOM.

1. the other participant's caption appears; your own does **not**
2. consecutive captions from one speaker render as **one** `<article>`

The second test initially failed for a reason worth recording: my helper derived
each `segment_id` from the text length, and two different phrases were both ten
characters, so they collided and the store **correctly replaced** one with the
other. The protocol was right and the test was wrong.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **258 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **59 passed** (+46) |
| Build | succeeded | **succeeded** |

---

## Fix 4 — Bug 3: interview mode did not work

### Diagnosis — each cause the brief named, checked

| # | Checked | Finding |
|---|---|---|
| 1 | Is the toggle shown to, or accepted from, non-hosts? | **No, correctly.** `ControlBar.jsx:150` wraps the menu item in `{isHost ? … : null}`, and `set_interview_mode` returns **403** to a non-host (`meetings.py:339`). Not a cause |
| 2 | Does the state change reach the other participant? | **NO. This is the central cause.** See below |
| 3 | Does someone who joins or reconnects after it was switched on receive it? | **Joining: yes** — `POST /join` returns the meeting record with `is_interview_mode: true`. **Reconnecting: no** — the meeting record is fetched once on mount and never re-read |
| 4 | Is fullscreen requested without a user click? | **No, correctly.** `enterEnforcement` runs from the dialog's acknowledge click, and the comment at `useInterviewMode.js:99` records that this is why. Not a cause |
| 5 | Is `navigator.keyboard.lock()` called outside fullscreen? | **No, correctly.** It is called after `await requestFullscreen()` resolves, so it is inside fullscreen. Not a cause |
| 6 | Do the listeners live in a component that unmounts? | **No.** `useInterviewMode` is called from `MeetingRoom`, which stays mounted for the whole meeting. Not a cause |

### The central cause

`MeetingRoom.jsx` fetches the meeting record **once**, on mount
(lines 159 and 167). `toggleInterviewMode` calls the PATCH endpoint and then
`setMeeting(updated)` — **updating only the host's own copy of the state**.

There was no broadcast, no polling, and no re-fetch. So:

- the host toggles it → **the host's** UI updates;
- the other participant's `meeting.is_interview_mode` stays `false`;
- `interviewOn` stays `false` on their client, so no dialog, no fullscreen, no
  keyboard lock and no detection.

**Interview mode worked only for the host — the one person it does not apply
to.** Everything downstream of `interviewOn` was correct and simply never ran.

A second, quieter cause: the record is never re-read, so a participant whose
socket drops and reconnects also never learns the state changed while they were
away.

### Requirements that were not implemented at all

Beyond the propagation bug, the brief specifies behaviour that did not exist:

| Requirement | Before |
|---|---|
| 3 — stays on until the meeting ends; cannot be switched off | `toggleInterviewMode` toggled **both ways**, and the server accepted `enabled: false` |
| 4 — the exact blocking dialog wording, with one button | Different wording, and the dialog was not driven by a live state change |
| 5 — block the right-click menu; warn on `beforeunload` | Neither |
| 6 — the participant's Leave button disabled | Not disabled |
| 7 — alert the host in real time with a toast, and a violation count beside the name in the People panel | The host polled every 5 s; no toast, no count in the panel |
| 8 — on the host ending, the server broadcasts the end and the participant's client releases the lock, exits fullscreen and goes to the ended page | No end broadcast |

---

### Fix

**The propagation fix — two halves, because one alone is not enough.**

| Half | Covers | Where |
|---|---|---|
| **Live broadcast** | Everyone *currently* connected | `set_interview_mode` is now `async` and calls `_announce_to_room`, pushing `{type: "interview-mode", …}` to every socket in the room |
| **Handshake state** | Everyone who connects *next* — a join, a reload, or a reconnect | `/ws/predict`'s `connected` message now carries a `meeting` block with the live interview state, read fresh from the database on every connection |

`_announce_to_room` notifies **both** connection managers, because a participant
may have one socket open and not the other: the inference socket is the
meeting's text channel and is always connected, while the signalling socket can
be absent if the call never established. A broadcast failure is logged and
**never fails the request** — the database is the source of truth and any client
that reconnects reads it from the handshake.

**The other requirements:**

| # | Requirement | Implementation |
|---|---|---|
| 1 | Host only; server rejects others with 403 | Already correct. Covered by `test_a_participant_cannot_switch_interview_mode` |
| 2 | Saved on the meeting and broadcast immediately | `_announce_to_room`, above |
| 3 | **Cannot be switched off** | Server returns **409** for `enabled: false`. The menu item is disabled once on and reads "Interview mode is on". The host's "Just leave the meeting" option is **hidden** during an interview — a host leaving without ending it would strand the candidate in fullscreen with no way out |
| 4 | The exact dialog wording, one button | `InterviewModeDialog` leads with the specified sentence; the button is **"Continue in full screen"**. The call keeps running behind it — the dialog is an overlay, and the camera and microphone are already live |
| 5 | Fullscreen then keyboard lock on that click; block right-click; `beforeunload` | Fullscreen and lock were already correct and in the right order. Right-click was already blocked. **`beforeunload` added** |
| 6 | Participant's Leave disabled with a tooltip | `canLeave={!interviewOn \|\| isHost}`; disabled with the tooltip *"Only the host can end this interview"* |
| 7 | Alert the host in real time; count beside the name in People | `log_focus_event` is now `async` and uses a **new `send_to_user`** on the connection manager to notify **only the host's** sockets. The host's client raises a toast and keeps a per-participant tally, shown as a red badge beside the name in the People panel |
| 8 | On ending, the server broadcasts; the client releases the lock, exits fullscreen, leaves | `end_meeting` is now `async` and broadcasts `{type: "meeting-ended", …}`. `useInterviewMode` exposes **`releaseEnforcement`**; `MeetingRoom` awaits it, hangs up, and navigates to `/ended/{code}` |
| 9 | Reduced support still shows, detects and reports | Already correct — `capabilities` and `reducedEnforcement` |
| 10 | No false violations from the app's own dialogs | Already correct — `suppressBriefly(4000)` around the screen picker |

**Why the violation alert is pushed, not polled.** The host acts on it by
talking to the candidate, so a five-second poll is five seconds of a
conversation already going wrong. And it is **targeted, not broadcast**: a
violation is a record *about* a participant, so sending it to the room would
show one candidate another's lapses — exactly why `GET /focus-events` is
host-only.

### Two further defects found and fixed while here

**A meeting created with interview mode on never stamped its start time.**
`create_meeting` set `is_interview_mode` but left `interview_mode_started_at`
NULL. The violation rollup filters on that timestamp, so such a meeting filtered
**nothing** and every focus event ever recorded counted as a violation. Found by
a pre-existing test whose premise depended on the broken state.
`create_meeting` now stamps it, and `set_interview_mode` backfills a missing one.

**Issue K-3, from the documentation's known-issues list.**
`get_focus_events` built each `FocusEventPublic` **without** `duration_away_ms`,
so it defaulted to `None` and the host's interview log showed an em dash for
every duration — although the database held the value and the `by_participant`
rollup read it correctly from the same rows. Now passed through.

### Two baseline tests intentionally changed

Both encoded behaviour the brief explicitly changes. Recorded here because
"nothing that passed may fail" otherwise hides it:

| Test | Why it changed |
|---|---|
| `test_host_can_switch_interview_mode_on_and_off` | Asserted two-way toggling. **Split** into `test_host_can_switch_interview_mode_on` and `test_interview_mode_cannot_be_switched_off` (409) |
| `test_rollup_ignores_events_from_before_the_mode_was_switched_on` | Its setup relied on `interview_mode_started_at` being NULL while the flag was on — which was itself the bug above. Rewritten to move the start time directly in the database, because the API can no longer produce that state (and correctly so: `log_focus_event` 409s when the mode is off, and the mode never re-stamps its start) |

### Tests

| File | Added | Covers |
|---|---|---|
`backend/tests/test_websockets.py` | **5** | **The host switching it on reaches the other participant** (the regression test); ending reaches them; the handshake carries the state on join/reconnect; the handshake reports it off when off; `DEMO` has no room state |
`backend/tests/test_focus_events.py` | **5** | Switching on stamps the start time; **cannot be switched off (409)**; switching on twice keeps the original start time; a meeting created with the mode on stamps its start; **every event carries its duration** (K-3) |
`frontend/src/test/pages.test.jsx` | **4** | **The dialog appears when the broadcast arrives**; it appears from the handshake so reloading is not an escape; the participant's Leave is disabled; the host can still leave and is not shown the dialog |

**Verified to bite.** Removing the broadcast makes
`test_switching_interview_mode_on_reaches_the_other_participant` fail with
*"no 'interview-mode' broadcast arrived — the ping sentinel came back first"*.

That sentinel is itself a fix: the first version of the test **hung** instead of
failing, because `receive_json()` blocks on a message that never comes. A
`ping`/`pong` sentinel after the action gives a deterministic end marker, since
a WebSocket delivers in order.

### What interview mode can and cannot prevent — stated precisely

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Detect tab switch (`visibilitychange`) | Yes | Yes | Yes |
| Detect switching application (`blur`) | Yes | Yes | Yes |
| Detect leaving fullscreen (`fullscreenchange`) | Yes | Yes | Yes |
| Record the event with its duration | Yes | Yes | Yes |
| Blocking overlay until they return | Yes | Yes | Yes |
| Fullscreen enforcement | Yes | Yes | Yes |
| **Capture Ctrl+T / Ctrl+N / Ctrl+W / Ctrl+Tab / Esc** | **Yes** (Keyboard Lock) | **No** | **No** |
| Block the right-click menu | Yes | Yes | Yes |
| Warn on close or reload (`beforeunload`) | Yes — a confirmation the user may still dismiss | Yes | Yes |
| Host told enforcement is reduced | Yes (reports false) | Yes (reports **true**) | Yes (reports **true**) |

**No browser, and no website, can:**

- block **operating-system** shortcuts — **Alt+Tab, Cmd+Tab, Cmd+Space,
  Mission Control, the Windows key**;
- stop someone **force-quitting** the browser or putting the machine to sleep;
- prevent a **close or reload** — `beforeunload` only asks, and the user may
  proceed;
- see a **second monitor**, a **phone**, **paper notes**, a **second computer**,
  **screen recording**, or **another person in the room**;
- detect a window placed **beside** the meeting that is never clicked, because
  `blur` fires only on a focus change.

**For all of those, interview mode detects, blocks the meeting view, and
reports. It does not prevent.** That is what the dialog says and what the code
comments say.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **267 passed, 2 skipped** (+10 new, 1 split into 2) |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **63 passed** (+50) |
| Build | succeeded | **succeeded** |

---

## Fix 5 — Bug 4: the participant count on Home and History was wrong

### Reproduced, against the live database

```sql
SELECT COUNT(*), COUNT(DISTINCT meeting_id, user_id) FROM meeting_participants;
-- 207 rows, 72 distinct (meeting, user) pairs  ->  135 duplicates
```

| Meeting | Rows | Distinct users |
|---|---|---|
| 134 | **17** | **1** |
| 114 | 14 | 2 |
| 143 | 8 | 2 |
| 110 | 8 | 2 |

Eight meetings affected. One reported **seventeen participants for a single
user**.

### Root cause

Of the four candidates the brief listed, exactly one applied:

| Candidate | Finding |
|---|---|
| **Counts rows instead of distinct users** | **Yes — this is the cause** |
| Includes duplicates from rejoining | Yes, the same cause: that is where the duplicate rows came from |
| Leaves out the host | **No.** The host joins through the lobby like everyone else and appeared in the rows (`host_rows=3` on recent meetings) |
| Counts only people still present | **No.** `left_at` was never filtered |

`meeting_participants` was deliberately an **append-only log** — the schema
comment said so — so `POST /join` inserted a new row every time. The frontend
then drew the number from `participants.length`, a **row** count. A participant
who reconnected three times was three participants.

The intent behind the log was to keep the history of disconnections. **Nothing
ever displayed that history, while the wrong count was displayed in four
places.**

### Fix

**Definition applied:** the participant count is the number of **distinct users
who joined, including the host**, however many times each one rejoined.

| Layer | Change |
|---|---|
`database/migrations/003_unique_participant.sql` *(new)* | Merges existing duplicates, then adds `UNIQUE KEY uq_participant_meeting_user (meeting_id, user_id)` |
`database/schema.sql` | The same UNIQUE key, so a fresh install needs no migration |
`backend/app/models/meeting.py` | `UniqueConstraint` on the ORM model |
`backend/app/api/meetings.py` → `join_meeting` | **Upserts**: an existing row has its `left_at` cleared and keeps its original `joined_at`. `IntegrityError` is caught and the winning row reused, for two simultaneous joins from the same user |
`backend/app/schemas/meeting.py` | `MeetingDetail.participant_count` — so `MeetingSummary` inherits it too |
`backend/app/api/meetings.py` | `_participant_count()` using **`COUNT(DISTINCT user_id)`**, and `_detail_with_count()` — **one builder used by every endpoint returning a `MeetingDetail`**, so no surface can forget it |
History endpoint | One **grouped** `COUNT(DISTINCT user_id)` for the whole page, keeping the query count flat at five regardless of how many meetings |

**The migration's merge rule**, stated so nothing is lost silently:

- the surviving row is the one with the lowest `id`;
- `joined_at` becomes the **earliest** across the group — when the person
  actually arrived;
- `left_at` becomes **NULL if any row was still open** (they are present),
  otherwise the **latest** departure;
- everything else is deleted.

It is idempotent: re-running merges nothing, and the index is guarded through
`information_schema` because MySQL has no `ADD UNIQUE KEY IF NOT EXISTS`.

**What is lost, stated plainly:** how many times somebody reconnected is no
longer recorded. That is the trade, and it was never shown anywhere.

**Applied to the live database:**

```
207 rows -> 72 rows, 0 duplicates, unique index present
```

### The same number on all four surfaces

Each one previously derived it from `participants.length`. All four now read
`participant_count`, with a fallback to the array length if an older backend
sends no field:

| Surface | File |
|---|---|
| Home — recent meeting cards | `pages/Home.jsx` |
| History — rows | `pages/History.jsx` |
| Transcript — header | `pages/Transcript.jsx` |
| Meeting-ended page | `pages/MeetingEnded.jsx` |

**Avatars match the count.** Home caps the faces at 4, History at 5, the
transcript header at 6, and each shows the overflow explicitly as `+N` beside
the total — so the number and the faces can never silently disagree.

### The People panel

Left as it is, per the brief: it shows who is **currently** in the meeting, which
is a different number. It now carries the label **"Currently in this meeting"**
so it cannot be mistaken for the total.

### Tests

`backend/tests/test_meetings.py` — **10 added**, covering every scenario the
brief names:

| Scenario | Test |
|---|---|
| Host alone | `test_participant_count_host_alone` |
| Host plus one guest | `test_participant_count_host_plus_one_guest` |
| Guest leaving and rejoining twice | `test_participant_count_with_a_guest_leaving_and_rejoining_twice` |
| Host reconnecting | `test_participant_count_with_the_host_reconnecting` |
| A meeting the caller only attended | `test_participant_count_for_a_meeting_the_caller_only_attended` |
| — plus | a meeting the host never entered counts **0**; the count is identical on every surface; **the UNIQUE constraint prevents duplicate rows**; rejoining reuses the row and keeps the original `joined_at`; rejoining five times still counts one |

`frontend/src/test/pages.test.jsx` — **4 added**. Each stubs a `participants`
array **shorter** than `participant_count`, so a surface that still derived the
number from the array would show the wrong one. History, Home and the
meeting-ended page are checked, plus the fallback when no count is sent.

### One baseline test intentionally changed

`test_rejoining_writes_a_new_attendance_row` asserted the **opposite** —
that rejoining wrote a new row. Rewritten as
`test_rejoining_reuses_the_attendance_row`, which also asserts the original
`joined_at` survives the merge.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **276 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **67 passed** |
| Build | succeeded | **succeeded** |

---
