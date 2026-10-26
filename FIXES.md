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

## Fix 6 — Bug 5: the layout broke in an incognito window

### Reproduced with automated screenshots

`frontend/scripts/compare-profiles.mjs` *(new)* drives Chromium through
Playwright and captures every page twice:

- **warm** — one context visits the page twice, so the second visit has the
  fonts and assets cached, like a profile that has used the app before;
- **cold** — a brand-new context per page, with empty cache and empty storage,
  which is the state an incognito window starts in.

Run with `npm run compare:profiles`, or `npm run compare:profiles:offline` to
block Google's font CDN.

**Two instruments, because the first one alone was useless.** The initial
version compared PNG *encoded bytes* and reported "100.00% different" for two
screenshots that were nearly identical — PNG is compressed, so any size change
reads as total difference. It now reports:

1. a real **pixel** difference, via `pixelmatch` and `pngjs`;
2. a **layout fingerprint** read from the DOM — bounding boxes of the top bar,
   the heading, the first button and every icon, plus whether each webfont has
   loaded, plus whether the document overflows its viewport.

The fingerprint is the better instrument, and it is what the gate uses. "Text
and icons are misaligned" is a *layout* statement, and the fingerprint says
precisely which element moved and by how much — a pixel diff on a page with a
live camera feed is meaningless, because the frame changes between shots.

### What the measurement actually showed

**Waiting for `document.fonts.ready` hid the bug.** With that wait in place,
warm and cold were byte-identical on all 15 page/width combinations — because
the wait is for exactly the thing that causes the problem.

So the CDN was blocked, which is what a restricted or flaky network does.
Probing the real font state then gave the diagnosis:

| | Icon font after 2.5 s | Requests to Google |
|---|---|---|
| **Before, CDN reachable** | `Material Symbols Outlined: loading` — **still not loaded** | 4 |
| **Before, CDN blocked** | never loads | 2 aborted |

So on a cold cache the icon font took **over two seconds** to arrive even on a
good connection, and on a restricted network never arrived.

### Root cause

Of the four candidates the brief listed:

| Candidate | Finding |
|---|---|
| **Fonts loaded from Google's CDN** | **Yes — this is the cause.** Measured above |
| Icons without a fixed-size box | **Already handled.** `components/ui/Icon.jsx` sets explicit `width`, `height` and `fontSize` inline, so a late font cannot resize the box. Measured: the icon box was 20×20 in every condition. This is *why* the layout did not collapse outright — the glyphs were simply absent |
| Missing saved preferences | **No.** `useMeetingPreferences` has a complete `DEFAULT_PREFERENCES` plus a `sanitise()` that discards unknown values, and `devicePreferences` returns `null` safely. Now covered by tests |
| Browser zoom | **No.** Measured at 80%, 100% and 125%: no horizontal overflow on any page |

With the icon boxes already fixed, the visible symptom was **absent icon glyphs**
(`font-display: block` renders nothing until the font loads) together with
**body text falling back to the system sans**, whose metrics differ from
Roboto's — so text wrapped differently and read as misaligned against icons that
were holding their space but showing nothing.

### Fix — self-host both fonts

| Change | Detail |
|---|---|
`@fontsource/roboto@5.1.0` | Roboto 400/500/700, from npm |
`material-symbols@0.27.0` | The outlined variable font, from npm |
`src/index.css` | `@import`s those faces before the Tailwind layers |
`index.html` | **Both `<link>` tags to Google's CDN removed**, along with the two `preconnect`s |

`material-symbols/outlined.css` is imported, **not** `index.css` — the index
pulls in the rounded and sharp variants too, which is **11 MB** of fonts for
three sets the design system never uses. Outlined alone is 3.4 MB, served from
our own origin and cached after first load.

**This also removes the last runtime dependency on a third party**, so the
application now runs entirely offline after setup. That closes issue **K-14**
from the documentation's known-issues list.

### Verified after the fix

The decisive test: with the fonts self-hosted, **blocking Google's CDN must
change nothing**.

| | Requests to Google | Icon font |
|---|---|---|
| **After, CDN reachable** | **0** | `loaded` |
| **After, CDN blocked** | **0** | `loaded` |

Identical. And the full comparison, **run with the CDN blocked**:

```
  page          width   pixels differ   layout same   icon font (cold)   overflow
  home          1024        0.00%       yes           loaded             no
  home          1280        0.00%       yes           loaded             no
  home          1920        0.00%       yes           loaded             no
  history       1024/1280/1920  0.00%   yes           loaded             no
  lobby         1024/1280/1920  0.00%   yes           loaded             no
  meeting       1024/1280/1920  0.00%   yes           loaded             no
  transcript    1024/1280/1920  0.00%   yes           loaded             no

  worst pixel difference : 0.00%
  layouts that differ    : 0 of 15
  icon font not loaded   : 0 of 15 (cold profile)
  horizontal overflow    : 0 of 15
```

All five pages — Home, Lobby, Meeting (with captions showing), History,
Transcript — at **1024, 1280 and 1920 px**, plus a zoom sweep at **80%, 100%
and 125%** with no overflow reported at any of them.

### Tests

`frontend/src/test/speechEngine.test.js` — **4 added**:

1. `DEFAULT_PREFERENCES` has a non-null value for every key
2. `loadDevicePreferences()` returns `null` with empty storage rather than throwing
3. it survives `sessionStorage` **throwing**, as in a locked-down profile
4. a stored preference this build does not understand is discarded, not used

### Two-device development setup

Interview mode and speech recognition cannot be tested honestly with two windows
on one laptop: clicking the other window is a genuine focus change, so every
interaction records a violation, and both windows share one microphone.

`npm run dev:lan` sets `BRIDGETALK_LAN=1`, which turns on three things in
`vite.config.js`:

| | Why |
|---|---|
| `host: true` | Another device on the Wi-Fi can reach it |
| **HTTPS** via `@vitejs/plugin-basic-ssl@2.1.0` | `getUserMedia` requires a secure context and only `localhost` is exempt; over plain `http://192.168.x.x` the camera prompt never appears |
| A **proxy** for `/api`, `/ws` and `/health` | One address, one certificate. Without it the browser must also accept a second self-signed certificate for the backend, which it will not do silently for a WebSocket — the socket fails with no usable error. `ws: true` is what performs the upgrade |

**A gap found when actually running it.** The proxy alone was not enough: the
app read `VITE_API_BASE_URL=http://localhost:8000` from `.env`, and on the
SECOND device `localhost` is that device — so every request failed with a
connection error and the proxy was never used. `services/api.js` now treats an
**empty** `VITE_API_BASE_URL` as "same origin", and `dev:lan` sets both URL
variables empty. An unset variable still falls back to `localhost:8000`, so a
plain `npm run dev` is unchanged.

Verified over the LAN from a second browser context:

| Check | Result |
|---|---|
| `https://192.168.x.x:5173/` | 200 |
| `/health` through the Vite proxy | 200, database connected |
| Login through the real form | Succeeds; requests go to `https://192.168.x.x:5173/api/…`, **not** `localhost:8000` |
| `wss://192.168.x.x:5173/ws/predict/DEMO` | `connected`, all three models loaded |

`.env.example` documents adding the LAN origin to `CORS_ORIGINS`, and the README
has the full steps under **"Testing with two devices"**.

**The production configuration is untouched.** `vite build` is unaffected, and
`npm run dev` still serves plain HTTP on localhost only — verified by loading
the config both ways.

### Suites after this fix

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **276 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend tests | 13 passed | **71 passed** |
| Build | succeeded | **succeeded** |

---

# Round 2 — screen share, sign captions, interview mode

Baseline for this round: `2011645`. Suites before any round-2 change:
**284 backend passed / 2 skipped · 83 frontend · 0 lint errors · build OK.**

---

## Fix 7 — Bug 1: a shared screen never reached the other participant

### What was reported

> when I give present share the screen is not shared to the other user while
> i shows like sharing to the person who's sharing the screen

### Root cause — and it was much worse than the report

Instrumenting `RTCPeerConnection` in both browsers showed that **no media was
flowing at all**, in either direction, before anybody pressed Present. Both
peers sat in `signalingState: have-local-offer`, `connectionState: new`, with
`framesDecoded: 0`:

```
=== HOST ===                          === GUEST ===
 >> setLocalDescription  state=stable  >> setLocalDescription  state=stable
    ok -> have-local-offer                ok -> have-local-offer
 STATE have-local-offer / new          STATE have-local-offer / new
 RECV joined | SEND offer              RECV joined | SEND offer
                                       RECV no-peers x5
                                       RECV offer     <-- ignored
```

The chain:

1. `createPeerConnection()` adds the local camera and microphone tracks, which
   fires `onnegotiationneeded` immediately.
2. The **first** peer into the meeting therefore offered into an **empty
   room**. The server has nobody to relay it to, so it replies `no-peers` —
   but the client had already moved to `have-local-offer`, and stayed there.
3. The second peer joined, was told `should_initiate: true`, and offered
   properly.
4. That real offer reached the first peer, which still held its stale local
   offer. To the perfect-negotiation check this is an offer collision. The
   impolite peer ignores a colliding offer — so **nobody answered**, and the
   call never connected.

A separate defect in the same path: `startCall()` built an offer explicitly
with `createOffer()` + `setLocalDescription(offer)` while `onnegotiationneeded`
was building one too. The two raced, and the loser threw an uncaught

```
InvalidAccessError: Failed to set local offer sdp: The order of m-lines in
subsequent offer doesn't match order from previous offer/answer.
```

### Why the previous round's politeness change exposed it

Round 1 replaced `polite = !should_initiate` with `polite = selfId < otherId`,
because `should_initiate` is recomputed on every reconnect and so was not
stable. That reasoning still holds and the rule is unchanged.

But the old rule happened to make the *waiting* peer — the one holding the
stale offer — always polite, so it rolled back and accepted. That **masked**
this bug. Deriving politeness from ids removed the accident, and the latent
defect became a hard deadlock. The honest summary is that the old rule was
wrong in a way that hid a worse bug.

### Why "let the polite peer absorb it" is not the fix

Tried and measured. On a **first** negotiation Chrome does not restart ICE
gathering after the implicit rollback: the polite peer reaches `stable` having
never emitted a single local candidate, so `iceConnectionState` never leaves
`new` and the call is equally silent.

```
=== HOST (polite, rolled back) ===     === GUEST ===
  pc0 sig->stable                        pc0 gather host x4
  pc0 addCand x5                         pc0 gather srflx
  (never gathered a candidate)           (never added one)
  final: pc0:stable/new                  final: pc0:stable/new
```

A bare two-peer `RTCPeerConnection` loopback in the same browser connects and
moves 8830 bytes, so this is the application's behaviour, not the environment.

**The collision has to be avoided, not resolved.**

### The fix — `frontend/src/hooks/useWebRTC.js`

1. A new `negotiate()` refuses to offer while the room is empty and records
   that an offer is owed:

   ```js
   if (!hasPeerRef.current) { negotiationPendingRef.current = true; return; }
   ```

2. `onnegotiationneeded` is now the only place that offers, so the race that
   threw `InvalidAccessError` is gone. `startCall()` just makes sure the
   connection exists.

3. On `peer-joined` the deferred offer is **dropped, not sent**: the peer who
   just arrived is the one the server told to initiate, and anything we were
   waiting to negotiate goes out in the **answer** we send it — an answer
   carries all of our tracks.

4. `hasPeerRef` is maintained from `joined`, `peer-joined` and `peer-left`.

Also kept from the first pass at this bug: `useScreenShare` announces
`presentation-start` *before* adding the track, so the receiver can route the
stream by id instead of guessing, and reports a missing peer connection
instead of showing the presenter their own screen in silence.

### Verified

```
peer connection reaches "connected" on both sides      ok
host decodes the guest's camera video                  ok
guest decodes the host's camera video                  ok
host sees that they are presenting                     ok
guest is told the host is presenting                   ok
guest now receives TWO video streams (camera + screen) ok
guest is decoding frames from both                     ok
   guest inbound video streams, frames decoded: [554,197]
```

### Tests added

`frontend/src/test/webrtcNegotiation.test.js` — 4 tests, which mount the hook
and fire the `onnegotiationneeded` that jsdom never fires:

- no offer while the room is empty
- still no offer when the peer arrives — the arriver initiates
- exactly one offer when joining second
- a screen share still renegotiates once the peer is present

Confirmed to **fail** with the gate removed (first two tests) and pass with it.

`src/test/setup.js` gained `FakeRTCPeerConnection.instances`, reset per test,
so a test can reach the connection the hook built.

---

## Fix 8 — Bug 2: sign captions never showed on the hearing user's screen

### What was reported

> the sign language captions are not displayed in the hearing user screen but
> it is visible in the transcript. but if any voice from the deaf user is
> detected it's captions are displayed in the hearing user's screen but the
> sign language captions.

### Root cause

Caption blocks were aged against the **producer's** `timestamp`, which is the
sender's `Date.now()`. Two devices do not share a clock. When the signer's
machine ran even a few seconds behind the viewer's, a sign caption arrived
already older than its TTL and was filtered out before it could be painted.

Speech captions survived because they are produced continuously, so a fresh
one always replaced the expired one before anybody noticed. A sign caption is
a single discrete utterance — there is no follow-up to cover for it.

The transcript was never affected: it is written server-side and read back by
`created_at`, so the caption was always in the record. That is exactly the
asymmetry in the report.

### The fix

- `frontend/src/hooks/useCaptionStore.js` — stamps `receivedAt: Date.now()` on
  arrival, from the **viewer's** clock.
- `frontend/src/utils/captionBlocks.js` — ages blocks from local arrival, not
  from the sender's timestamp.
- `frontend/src/config/recognition.js` — `SIGN_BLOCK_TTL_MS: 20000`, so a
  signed sentence stays readable long enough to be read. Signing a sentence
  takes longer than saying it.

### Verified

```
sign caption appears on the hearing user's screen      ok
sign caption is still readable 11s later               ok   (it vanished at 5s before)
```

### Tests

`frontend/src/test/captionBlocks.test.js` — now 28 tests, including clock-skew
cases where the producer's clock is behind and ahead of the viewer's.

---

## Fix 9 — Bug 3: the interview-mode flow

### What was reported

> once the user clicks interview mode then the other user is put in full screen
> mode. Once that user goes out of the meeting he's taken out of the meeting,
> and the return to meeting option is shown but once that is clicked he's not
> taken back to the meeting.

and the flow that was asked for: one warning, then removal, the host notified
each time, and all of it in the transcript.

### Root cause 1 — "Return to the meeting" did nothing

Leaving fullscreen set `isAway`, but `isAway` was only ever cleared by a
`focus` or `visibilitychange` event — and **exiting fullscreen fires
neither**. The page stays focused and visible throughout. So pressing Return
re-entered fullscreen, `isFullscreen` became true, `isAway` stayed true
forever, `mustBlock` stayed true, and the overlay could not be dismissed.

Fixed in `useInterviewMode.js`: `handleFullscreenChange` now calls
`comeBack()` when fullscreen becomes active again.

### Root cause 2 — the host was never told what the server decided

The server sends its verdict **beside** the event, not inside it:

```json
{ "type": "focus-event", "event": {...}, "action": "removed", "departures": 2 }
```

`useSignSocket` passed `message.event` on by itself, so the host's toast read
`event.action === undefined` every time and fell through to its bland
"left the meeting screen" wording. A removal was announced in exactly the same
words as a first warning. Fixed by folding `action` and `departures` into the
object handed to the handler.

### The rule, decided server-side

`backend/app/api/meetings.py` — the count that removes somebody is the
server's, from rows the server wrote, so a browser cannot talk itself out of it
or into removing someone else:

- `INTERVIEW_MAX_DEPARTURES = 2`
- first departure → `action: "warned"` + a `system` transcript line
- second → `participant.removed_at` stamped **before** the broadcast, so a
  rejoin racing the announcement is already refused, a `system` transcript
  line, and a `participant-removed` broadcast
- `join_meeting` now returns 403 when `removed_at is not None`

Supporting changes: `TranscriptSource.SYSTEM`, `MeetingParticipant.removed_at`,
`database/migrations/004_interview_removal.sql` (applied and verified),
`FocusEventPublic.action` / `.departures`, and on the client the final-warning
wording, the removal redirect, and `MeetingEnded` withholding Rejoin.

### Verified

```
guest gets the full-screen disclaimer                  ok
guest is put into full screen                          ok
departure 1: host is told it was a WARNING             ok
departure 1: guest is told it is their only warning    ok
Return puts them back in the meeting                   ok
departure 2: host is told it was a REMOVAL             ok
departure 2: guest is taken out of the meeting         ok
departure 2: Rejoin is withheld                        ok
removed participant cannot rejoin                      ok
```

Transcript, read straight out of MySQL:

```
SJH-F2S | system | Demo Hearing User left the meeting screen. Warned:
                   leaving again will remove them from the interview.
SJH-F2S | system | Demo Hearing User left the meeting screen 2 times and was
                   removed from the interview.
```

`meeting_participants.removed_at = 2026-10-22 14:47:05` for that user.

### Tests added

`frontend/src/test/focusEventRelay.test.js` — 3 tests on the verdict relay
(`removed`, `warned`, and defaulting to `none` for a `return`). Confirmed to
fail against the old one-line handler.

`backend/tests/test_focus_events.py` — now 30 tests, covering the warn/remove
boundary, the system transcript lines, and the rejoin refusal.

---

## A note on how these were verified

An earlier run of this round reported four failures that were **not** real:
the script drove departures with `window.dispatchEvent(new Event('blur'))`, a
synthetic event that never fires `fullscreenchange` and so never exercised the
handler the bug lived in. Driving the genuine path — `document.exitFullscreen()`,
and a real click for the gesture that re-enters it — showed the flow working.

Two further "failures" were the harness as well: a wrong transcript URL
(`/api/meetings/{code}/transcript`; the route is `/api/transcripts/{id}`) and a
`MutationObserver` that missed toasts.

Every claim above is from a run against the app on
`https://192.168.200.195:5173` with two browser contexts.

---

# Round 2 — suite results

| Suite | Baseline (`2011645`) | After round 2 |
|---|---|---|
| Backend `pytest` | 284 passed, 2 skipped | **284 passed, 2 skipped** |
| Frontend `npm run lint` | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend `npm test` | 83 passed | **90 passed** |
| Frontend `npx vite build` | succeeded | **succeeded** |
| Two-browser end-to-end | 10 of 14 checks | **19 of 19 checks** |

**Nothing that passed in the baseline fails.** New tests this round: **+7
frontend** (4 negotiation, 3 verdict relay). The backend count is unchanged
because the interview-mode rule's tests landed in the baseline commit.


---

# Round 3 — the deaf user's signs were never captured

Baseline for this round: `7cec029`. Suites before the change:
**284 backend passed / 2 skipped · 90 frontend · 0 lint errors · build OK.**

---

## Fix 10 — sign capture: MediaPipe was reading one frozen frame

### What was reported

> when the deaf user signs the captions are not displyed in the hearing user's
> screen. the signs itself are not being captured

### Root cause

MediaPipe does not read the camera. It reads frames from a dedicated `<video>`
element that the meeting room keeps out of the layout:

```jsx
<video ref={localVideoRef} autoPlay playsInline muted className="hidden" />
```

Tailwind's `hidden` is `display: none`, and **Chrome does not autoplay an
element it is not rendering**. Measured in the running app:

```
video elements on the deaf user's page:
 [0] hidden=true  stream=true readyState=4 640x480 paused=TRUE  t=0  ->0    STALLED
 [1] hidden=false stream=true readyState=4 640x480 paused=false t=7.1->9.6  ADVANCING
```

Element `[0]` is the detection source. It was **paused**, with `currentTime`
frozen at **0** for the entire meeting, while the visible tile played normally.

### Why nothing looked wrong

The guard inside `detect()` is:

```js
if (video.readyState < 2 || video.videoWidth === 0) return null;
```

A paused element with a stream attached still reports `readyState: 4` and
`videoWidth: 640`. So the guard passed, MediaPipe ran at 10 FPS against the
**same first frame** for the whole call, and truthfully reported no hands
whatever the signer did.

Every downstream symptom then pointed somewhere else:

- the landmark socket was busy — 80 frames in 8 s, exactly 10 FPS
- the server answered every one of them, with `prediction label=nothing`
- no error banner, no console error, `isReady` true, the model loaded
- the control bar correctly showed "Turn off sign recognition" — it *was* on

The hearing user's captions were empty because there was never a sign to
caption. The caption transport, which the previous round fixed, was fine.

Instrumented confirmation that the fix is the right one, before changing code:

```
--- as shipped ---
before: paused=true  t=0    framesChangeBetweenSamples=false
--- after calling play() on that element ---
after : paused=false t=8.76 framesChangeBetweenSamples=true
play() error: none
```

Sampling the element onto a canvas twice is the part that matters: it proves
the pixels MediaPipe receives actually change, rather than only that a clock
moved.

### The fix — `frontend/src/pages/MeetingRoom.jsx`

Play the element explicitly instead of relying on the `autoPlay` attribute.
`play()` needs no user gesture because the element is muted.

```js
useEffect(() => {
  const video = localVideoRef.current;
  if (!video || !localStream) return;

  video.srcObject = localStream;
  video.play().catch((cause) => {
    if (cause?.name !== 'AbortError') {
      console.warn('The hand-tracking video would not play', cause);
    }
  });
}, [localStream]);
```

`AbortError` is swallowed because a replaced `srcObject` or a remount
routinely interrupts a pending `play()`. Anything else is reported: silence is
what hid this bug for three rounds, so the failure path now says something.

`display: none` is left alone — it was not the problem once the element is
played, and the measurement above shows frames flowing through it.

### Not changed, deliberately

- `SignDetection.jsx` already calls `await videoRef.current.play()` and its
  video is visible, so the standalone page was never affected. That is why
  sign detection appeared to work there but not in a meeting.
- The default `recognitionMode` is `dynamic` (word signs). Worth knowing when
  testing — fingerspelled **letters** need the ISL or ASL mode from Settings —
  but it is a setting, not this bug, so it was not touched.

### Verified

```
detection video is playing, not paused                  ok
its clock advances (frames are being decoded)           ok
MediaPipe receives CHANGING frames, not a frozen one    ok
the guard in detect() still passes                      ok
```

And the full regression sweep, so the rest of the meeting room is untouched:

```
peer connection connected both sides   ok     guest gets disclaimer         ok
host decodes guest camera              ok     guest in full screen          ok
guest decodes host camera              ok     departure 1 warns host        ok
detection video is playing             ok     guest sees only-warning       ok
MediaPipe gets changing frames         ok     Return restores meeting       ok
sign caption reaches hearing user      ok     departure 2 tells host REMOVAL ok
still readable 11s later               ok     guest removed from meeting    ok
guest told host is presenting          ok     Rejoin withheld               ok
guest receives TWO video streams       ok
both decoding frames                   ok     18 passed, 0 failed
```

### Tests added

`frontend/src/test/signCaptureSource.test.jsx` — 2 tests: the detection video
is played explicitly, and it keeps the `muted` attribute that lets `play()`
run without a user gesture. Confirmed to **fail** with the `play()` call
removed.

### What still needs a human

No synthetic camera can produce a hand MediaPipe will detect, so the last step
— sign a letter and watch the caption appear on the other screen — cannot be
automated here. `scripts/_sign` style instrumentation showed `hands=0` on every
frame throughout, which is correct for Chrome's fake camera and is exactly why
this bug survived the earlier end-to-end runs: they injected captions onto the
socket and never exercised capture.

---

# Round 3 — suite results

| Suite | Baseline (`7cec029`) | After round 3 |
|---|---|---|
| Backend `pytest` | 284 passed, 2 skipped | **284 passed, 2 skipped** |
| Frontend `npm run lint` | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend `npm test` | 90 passed | **92 passed** |
| Frontend `npx vite build` | succeeded | **succeeded** |
| Two-browser regression sweep | 19 of 19 | **18 of 18** |

**Nothing that passed in the baseline fails.** New tests: **+2 frontend**.

---

# Round 4 — the captions were switched off

Baseline: `e98f775`. Suites before the change:
**284 backend passed / 2 skipped · 92 frontend · 0 lint errors · build OK.**

---

## Fix 11 — one stray keypress removed the translation

### What was reported

> still the captions are not being displyed in the hearing user's screen but
> the signs are recognized and trnaslated and displayed in transcript alone.

### What it was NOT

Round 3 fixed capture, and the transcript proved it: signs were recognised and
written as `SIGN` rows. The obvious next suspect was delivery, so that was
tested four ways against the running app, with two browsers:

| Checked | Result |
|---|---|
| one signed word — interim then final, one segment id | rail shows `Demo Deaf User · Sign · old` |
| a second word a few seconds later | `old location` — appended to the same block |
| the hearing user talking continuously at the same time | sign captions still shown |
| 10 s after the last sign (speech TTL is 5 s) | still on screen |
| the hearing user's caption socket killed mid-meeting | reconnects by itself, captions resume |

The signer's own rail correctly stayed empty throughout — you do not read your
own words back.

So delivery was sound, and the pipeline could not be made to fail. The missing
evidence was the one screen nobody had looked at.

### Root cause

On the hearing user's screen there was **no caption strip at all** — not an
empty one. Captions were switched off on that device.

```jsx
if (!visible) return null;   // CaptionRail
```

Hiding captions removes the strip entirely so the stage can reclaim the 140px.
That is a reasonable choice on its own, but combined with how captions were
switched off it was not:

```js
} else if (!modifier && event.key.toLowerCase() === 'c') {
  setCaptionsVisible((value) => !value);
}
```

A **bare `c`** — no modifier, anywhere outside a text field. The microphone
needs Ctrl/Cmd+D and the camera Ctrl/Cmd+E; captions needed nothing. One
accidental keystroke removed the entire translation channel, left nothing on
screen to say what had happened, and the transcript panel kept filling from
the server behind it, which made it look like a delivery fault.

On a tool whose whole purpose is making one side of a conversation readable to
the other, that is the most expensive thing a stray keypress could do.

### The fix

**`frontend/src/utils/shortcuts.js`** (new) — the rule, as a pure function:

- captions now need **Ctrl/Cmd+Shift+C**
- plain Ctrl/Cmd+C is deliberately *not* used: that is Copy, and this page
  asks people to copy the meeting link. Shift keeps the `c` mnemonic without
  taking Copy away.
- the microphone and camera are untouched

**`frontend/src/pages/MeetingRoom.jsx`** — the handler now asks
`shortcutFor(event)`, and both the shortcut and the control-bar button go
through one `toggleCaptions`, which **says so when captions go off**:

> Captions hidden — press Ctrl/Cmd+Shift+C to show them again

Switching them back on needs no announcement: the captions reappearing is the
feedback. Hiding is the direction that used to be silent.

### Verified in a real browser

```
caption strip present on join              ok    the control-bar button still hides them  ok
a bare "c" no longer hides captions        ok    the button explains too                  ok
Ctrl+C (Copy) does not hide captions       ok    and brings them back                     ok
Ctrl+Shift+C hides them                    ok    Ctrl+D still toggles the microphone      ok
and says so, naming the way back           ok    Ctrl+E still toggles the camera          ok
Ctrl+Shift+C brings them back              ok
                                                 11 passed, 0 failed
```

### Tests added

`frontend/src/test/shortcuts.test.js` — 7 tests on the rule: a bare `c` is
ignored, Ctrl/Cmd+Shift+C toggles captions, Ctrl/Cmd+C is left to Copy, the
microphone and camera are unchanged, no unmodified key is ever a command,
keystrokes aimed at a text field are ignored, and a malformed event is
survived. Three of them fail if the old bare-`c` rule is put back.

### Why the rule was extracted rather than tested through the page

A page-level test was written first and **discarded for being flaky**. Under
jsdom the meeting room navigates away on its own about 1.2 seconds after
mounting — measured, with no keys pressed at all — so any multi-step
interaction test races that teardown and fails for a reason that has nothing
to do with captions. A test that passes and fails at random is worse than no
test, so the rule moved into a pure function where it is decided by one call,
and the full interaction is covered against a real browser instead.

---

# Round 4 — suite results

| Suite | Baseline (`e98f775`) | After round 4 |
|---|---|---|
| Backend `pytest` | 284 passed, 2 skipped | **284 passed, 2 skipped** |
| Frontend `npm run lint` | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend `npm test` | 92 passed | **99 passed** |
| Frontend `npx vite build` | succeeded | **succeeded** |
| Browser check of the shortcuts | did not exist | **11 of 11** |

**Nothing that passed in the baseline fails.** New tests: **+7 frontend**.

---

# Round 5 — the video was painted over the captions

Baseline: `5541c03`. Suites before the change:
**284 backend passed / 2 skipped · 99 frontend · 0 lint errors · build OK.**

---

## Fix 12 — captions appeared only while somebody shared their screen

### What was reported

> the caption strip is not visible when we are normally speaking or signing.
> The captions are not visible on both the user's screen. only when one user
> shares the screen the caption strip is visible.

With screenshots from both devices, which is what made this solvable.

### Root cause

Nothing was wrong with the captions. They were produced, delivered, correct,
and sitting in the DOM at the right coordinates. **The video was painted on
top of them.**

`MeetingTile` had no height of its own:

```jsx
<div className="group relative overflow-hidden rounded-tile bg-dark-surface">
  <video className="h-full w-full object-cover" />
```

`h-full` is `height: 100%`, and a percentage height against an **auto-height**
parent does not resolve — so the video fell back to the stream's intrinsic
aspect ratio, and the tile grew to match it. Measured in a real browser, with
the hit test below:

```
=== two participants, nobody presenting ===
   stage bottom=640  rail top=640
   stage videos (w x h, bottom): [{"w":1480,"h":1110,"bottom":1126}, ...]
   what is painted at the rail's centre: VIDEO.h-full w-full object-cover
   => caption strip COVERED by the video
```

A 4:3 camera rendered **1480x1110** inside a **640px** stage: 486px of
overflow, straight over the caption strip. The stage had no `overflow-hidden`
to clip it.

### Why sharing a screen "fixed" it

By accident. The presenting branch puts both cameras in fixed boxes:

```jsx
<div className="aspect-video shrink-0">{localTile}</div>
```

`aspect-video` gives the tile a real height, so `h-full` resolves, nothing
overflows, and the captions become visible:

```
=== deaf user presents ===
   stage videos (w x h, bottom): [{"w":1264,"h":608,"bottom":624}, ...]
   what is painted at the rail's centre: DIV.mx-auto flex h-full max-w-caption
   => caption strip VISIBLE
```

That is the whole of the reported difference.

### Why four rounds of tests missed it

Every earlier check asked whether the caption was **in the rail** — the DOM
text, the block grouping, the TTL, the socket. All of those were true the
whole time. None of them asked whether the rail could be **seen**.

Geometry was not enough either: the rail measured `[640..780]`, height 140,
"fully on screen", in every viewport tried — while being completely obscured.
The test that finds this is `document.elementFromPoint` at the centre of the
strip, asking what is actually painted there.

### The fix

**`frontend/src/components/meeting/MeetingTile.jsx`** — the tile now fills its
container instead of growing to the stream:

```jsx
className={`group relative h-full w-full overflow-hidden rounded-tile ...`}
```

Both call sites already render into height-constrained containers (the stage
itself, or an `aspect-video` box), so filling is always the right behaviour.

**`frontend/src/components/meeting/Stage.jsx`** — the stage now clips:

```jsx
className="relative min-h-0 flex-1 overflow-hidden p-4"
```

Belt to the tile's braces. A mis-sized tile must be clipped rather than
allowed to cover the captions, because that failure mode is silent.

### Verified, both directions

```
=== ordinary call, nobody presenting ===
no video overflows the stage any more (deaf)         ok
no video overflows the stage any more (hearing)      ok
caption strip is visible on the deaf screen          ok
caption strip is visible on the hearing screen       ok

=== deaf user SIGNS -> hearing user must read it ===
hearing user SEES the deaf user's sign caption       ok
deaf user does NOT see their own words               ok
   hearing rail: "Demo Deaf User · Sign · healthy"

=== hearing user SPEAKS -> deaf user must read it ===
deaf user SEES the hearing user's speech caption     ok
hearing user does NOT see their own words            ok
   deaf rail: "Demo Hearing User · Speech · good evening everyone"

=== and still works while presenting ===
rail hit-test VISIBLE, overflow false, text "Demo Deaf User · Sign · location"
```

Run at two different window sizes (1512x860 and 1792x760), which is what the
reported screenshots showed.

### Tests added

`frontend/src/test/captionRailNotCovered.test.jsx` — 3 tests: every camera
tile sizes to its container, the stage clips, and the tiles stay sized while
presenting. All three fail if either half of the fix is reverted.

Their limit is stated in the file: jsdom has no layout engine, so it cannot
catch the overflow itself. It pins the two properties whose absence caused it;
the occlusion itself is checked against a real browser by hit-testing the
centre of the strip.

---

# Round 5 — suite results

| Suite | Baseline (`5541c03`) | After round 5 |
|---|---|---|
| Backend `pytest` | 284 passed, 2 skipped | **284 passed, 2 skipped** |
| Frontend `npm run lint` | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend `npm test` | 99 passed | **102 passed** |
| Frontend `npx vite build` | succeeded | **succeeded** |
| Browser hit-test, both directions | did not exist | **9 of 9** |

**Nothing that passed in the baseline fails.** New tests: **+3 frontend**.

---

# Manual test script — two devices

Everything below needs a camera, a voice, or two devices. **None of it has been
verified by me**, and the automated suites cannot cover any of it.

## Setup

```bash
# Terminal 1
./scripts/run_backend.sh

# Terminal 2 — LAN mode: HTTPS, and /api + /ws proxied through Vite
cd frontend && npm run dev:lan
```

Take the **Network** address Vite prints, add it to `CORS_ORIGINS` in the
repository-root `.env`, and restart the backend. On the second device open that
address and accept the certificate warning (**Advanced → Proceed**).

Sign in as a **different user on each device**. Add `?debug=1` to the meeting
URL on either device for the diagnostic overlay.

> For Bug 1, Bug 2 and Bug 4 two windows on one laptop is sufficient and
> quicker. Bug 3 and the speech half of Bug 1 **need two devices** — clicking
> the other window on one laptop is a genuine focus change, so every
> interaction records a violation, and two windows share one microphone.

## B1 — captions flow continuously

| # | Do this | Expect |
|---|---|---|
| **B1-1** | Hearing user says *"good morning"*, pauses ~2 s, then *"shall we start"* | **One block**: one avatar, one name, and **one paragraph** reading "good morning shall we start". **Not two lines.** This is the bug |
| **B1-2** | Keep talking for four or five sentences | The paragraph grows to **three lines**, then older lines scroll up and out. The newest words stay in the **same place** on screen |
| **B1-3** | Watch a sentence being spoken | Text appears **word by word**, in **grey**, and turns **white** when you pause. It must never jump or reorder |
| **B1-4** | Stop talking and wait ~5 s | The block **fades out** |
| **B1-5** | Both people talk in turn | At most **two** blocks on screen; the older one disappears first |
| **B1-6** | Deaf user fingerspells several letters without pausing | Each letter appears on the other screen **as it is committed**, not only at the end of the segment |
| **B1-7** | Settings → Captions → **"Browser (Web Speech)"** | **The meeting must NOT crash.** This was K-1. Captions continue word by word |
| **B1-8** | Stop talking for ~15 s, then speak again | Captions resume by themselves. **No words lost** across Chrome's silent restart |

## B2 — each screen shows only the other person

| # | Do this | Expect |
|---|---|---|
| **B2-1** | Hearing user speaks | Caption appears **on the deaf user's screen only**. The speaker's own caption area stays empty |
| **B2-2** | Deaf user signs | Caption appears **on the hearing user's screen only** |
| **B2-3** | Open the **Transcript** panel on either device | **Both** sides of the conversation, in time order. This is the record and is unaffected |
| **B2-4** | Deaf user watches their own tile while signing | The detection **pill** still shows what is being recognised, with **undo** and **clear** |
| **B2-5** | Download the TXT after the call | Contains **both** sides |

## B3 — interview mode

Needs **two devices**.

| # | Do this | Expect |
|---|---|---|
| **B3-1** | Participant looks for the interview control | **Not present.** Host only |
| **B3-2** | Host: More → **Turn on interview mode** | Host sees *"Interview mode is on for everyone"* |
| **B3-3** | **Look at the participant's device** | A **blocking dialog** appears **within a second**, reading *"The host has turned on interview mode…"*, with one button: **Continue in full screen**. **This is the bug — before the fix nothing happened here at all** |
| **B3-4** | Check the call behind the dialog | Audio and video **keep running** |
| **B3-5** | Participant presses **Continue in full screen** | The meeting goes **fullscreen** |
| **B3-6** | Participant tries **Ctrl+T**, **Ctrl+N**, **Ctrl+W**, **Esc** (Chrome/Edge) | **Captured by the page.** In Firefox/Safari Esc exits fullscreen — expected, and the host is told enforcement is reduced |
| **B3-7** | Participant tries **right-click** | No context menu |
| **B3-8** | Participant tries to **reload** | A browser confirmation appears. It can still be dismissed — `beforeunload` only asks |
| **B3-9** | Participant looks at **Leave** | **Disabled**, tooltip *"Only the host can end this interview"* |
| **B3-10** | Participant switches to another app, waits ~5 s, comes back | Overlay *"Return to full screen to continue"*; **host gets a toast** within a second; a red **count** appears beside the name in the host's **People** panel |
| **B3-11** | Host: More menu again | **"Interview mode is on"**, disabled. It cannot be switched off |
| **B3-12** | Host presses Leave | **No "just leave"** option — only **End meeting for everyone**, warning that it ends the interview |
| **B3-13** | Host ends the meeting | Participant's keyboard lock **releases**, fullscreen **exits**, and they land on the **meeting-ended** page |
| **B3-14** | Host opens the transcript afterwards | **"Interview mode log"** lists each event with participant, time and a **real duration** — not an em dash. That was K-3 |
| **B3-15** | Participant **reloads** during the interview, before B3-13 | The dialog comes **straight back**. Reloading is not an escape |
| **B3-16** | Participant presses **Present** and cancels the picker | **No violation recorded.** The app's own dialog must not count |

**What it cannot do, and must not claim to:** Alt+Tab, Cmd+Tab, Cmd+Space,
Mission Control, the Windows key, force-quitting the browser, a second monitor,
a phone, paper notes, a second computer, screen recording, or a window placed
beside the meeting that is never clicked. For all of these it **detects, blocks
the view, and reports** — it does not prevent.

## B4 — the participant count

| # | Do this | Expect |
|---|---|---|
| **B4-1** | Host creates a meeting and joins; guest joins. Both leave | Home card and History row both say **"2 participants"**, with **two** avatars |
| **B4-2** | Guest rejoins and leaves **three** times, then both leave | Still **2** — not 5 |
| **B4-3** | Host's laptop sleeps and reconnects mid-meeting | Still **2** |
| **B4-4** | Open the **transcript page** for that meeting | Header shows the **same** number |
| **B4-5** | Look at the **meeting-ended** page | Shows the **same** number |
| **B4-6** | Open the **People** panel during a meeting | Headed **"Currently in this meeting"** — a different, live number, and labelled as such |
| **B4-7** | Create a meeting and never enter it | **"No one joined"** — creating is not attending |

## B5 — the layout in a private window

| # | Do this | Expect |
|---|---|---|
| **B5-1** | Open the app in a **fresh private/incognito window** | Icons render **immediately**; nothing is blank, and no ligature names ("mic", "videocam") ever appear as text |
| **B5-2** | Compare side by side with your normal window at the same size | **Identical** layout |
| **B5-3** | Turn **Wi-Fi off** and reload the private window | Still correct. Fonts are served from our own origin |
| **B5-4** | Zoom to **80%**, then **125%** | No overlapping text, no horizontal scrollbar |
| **B5-5** | Resize from **1024** to **1920 px** | No overlap, no bad wrapping |
| **B5-6** | Repeat B5-1 on Home, Lobby, Meeting, History and Transcript | All five correct |

Automated equivalent, which **has** been run:

```bash
cd frontend && npm run compare:profiles:offline
```

---

## B6 — the call itself, and the screen share (round 2)

| # | Do this | Expect |
|---|---|---|
| **B6-1** | Join from both devices and wait ~10 s | **Each of you can see the other's camera**, not a frozen tile |
| **B6-2** | On device A press **Present** and pick a window | A shows "You are presenting" |
| **B6-3** | Look at **device B** | B shows "A is presenting" **and the shared window itself**, moving |
| **B6-4** | Move a window around on A | B's view updates |
| **B6-5** | Press **Stop presenting** on A | B returns to A's camera; the call stays up |

## B7 — sign captions reach the hearing user (round 2)

| # | Do this | Expect |
|---|---|---|
| **B7-1** | On the deaf user's device, sign so a caption is produced | The caption appears on the **hearing user's** screen |
| **B7-2** | Wait ~15 s without signing | It is **still readable**, then fades |
| **B7-3** | Open the transcript afterwards | The same line is there, marked `sign` |

Worth doing deliberately: set the two devices' clocks a minute apart. That is
the condition the bug needed, and B7-1 must still pass.

## B8 — interview mode (round 2)

| # | Do this | Expect |
|---|---|---|
| **B8-1** | Host: **More options → Turn on interview mode** | The other device shows the disclaimer |
| **B8-2** | Other device: **Continue in full screen** | It goes full screen |
| **B8-3** | Leave full screen (Esc) | Overlay: "**This is your only warning**". Host gets a toast saying **warned** |
| **B8-4** | Click **Return to the meeting** | Back in full screen, overlay gone, **still in the meeting** |
| **B8-5** | Leave full screen a second time | Taken **out** of the meeting; host gets a toast saying **removed** |
| **B8-6** | On the ended screen | A reason is shown and there is **no Rejoin button** |
| **B8-7** | Try to rejoin from the lobby link | **Refused** — you stay in the lobby |
| **B8-8** | Host: open the transcript | Both the **warning** and the **removal** appear as system lines |

---

# Summary of suite results

| Suite | Baseline (`c59fcad`) | After all five fixes |
|---|---|---|
| Backend `pytest` | 258 passed, 2 skipped | **276 passed, 2 skipped** |
| Frontend `npm run lint` | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend `npm test` | 13 passed | **71 passed** |
| Frontend `npx vite build` | succeeded | **succeeded** |
| Profile comparison | did not exist | **0 of 15 layouts differ, CDN blocked** |

**Nothing that passed in the baseline fails.** Three baseline tests were
*intentionally* rewritten because the brief changes the behaviour they encoded;
each is named and explained in its fix section above.

New tests: **+18 backend**, **+58 frontend**.
