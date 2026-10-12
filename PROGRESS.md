# BridgeTalk — PROGRESS

> **Purpose.** A new session must be able to resume from this file alone.
> Status is assigned by **running the code**, not by reading the README.
> Last updated: Phase 0 audit, 2026-10-04.

---

## Detected stack

| Layer | Detected | Version |
|---|---|---|
| Frontend | React + Vite + Tailwind | React 18, Vite 7.3.6 |
| Backend | FastAPI + Uvicorn | Python 3.11 |
| Hand tracking | `@mediapipe/tasks-vision` HandLandmarker (browser, WASM) | — |
| ML | TensorFlow / Keras | TF 2.16.2, numpy 1.26.4 |
| Speech (primary) | Web Speech API | browser |
| Speech (fallback) | faster-whisper `base`, int8, CPU | 1.0.3 / ctranslate2 4.8.1 |
| Audio decode | ffmpeg | 9.0.1 |
| Database | MySQL 8 via SQLAlchemy 2.0.36 | **Unix socket, not TCP 3306** |
| Auth | JWT (python-jose) + passlib/bcrypt | — |
| Ports | backend `:8000`, frontend `:5173` | both verified up |

Repo: 28 commits, branch `client`, remote `origin` → `github.com/swarnaangusamy/BridgeTalk.git`.
Working tree clean. **220 tests pass, 2 skipped** (`pytest backend/tests`).

> **MySQL gotcha:** `mysqladmin ping` and `lsof -iTCP:3306` both return empty
> because MySQL listens on a **Unix socket**. The SQLAlchemy connection the
> backend actually uses was tested and works. Do not read the empty `lsof` as
> "MySQL is down".

---

## Database schema (current)

Five tables in `database/schema.sql`, all present in the live database:

| Table | Key columns |
|---|---|
| `users` | id, name, email (unique), password_hash, role, created_at |
| `meetings` | id, code (unique), title, host_id, **is_interview_mode**, started_at, ended_at, created_at |
| `meeting_participants` | id, meeting_id, user_id, joined_at, left_at — a log, not a set |
| `transcripts` | id, meeting_id, user_id, source (`sign`/`speech`), content, confidence, created_at |
| `focus_events` | id, meeting_id, user_id, event_type (`blur`/`hidden`/`return`), created_at |

**Schema gaps for later phases:** `focus_events` has no `duration_away`
column, and there is no violation-count or removal state.

---

## Trained models on disk

| Model | File | Features | Classes | Measured accuracy | How measured |
|---|---|---|---|---|---|
| **ISL words** (dynamic, BiLSTM) — *the demo model* | `dynamic_model.keras` | `(30, 132)` | 40 + 1 internal | **85.23% top-1**, 94.63% top-3 on 149 held-out clips; **17.5% WER** continuous | `evaluate.py` + `evaluate_continuous.py` on a held-out split |
| ASL letters (static, MLP) — baseline only | `static_model.keras` | `(63,)` | 28 | **90.53% top-1**, 96.91% top-3 on 6,440 held-out samples | `evaluate.py` |
| **ISL fingerspelling** (static, MLP) | — | `(126,)` | — | **NEVER TRAINED** | no dataset was available |
| Whisper | `ml/models/whisper/` (141 MB) | — | — | not an accuracy metric; 1,061 ms for 2.8 s audio | real speech through `/ws/transcribe` |

**Note on the dynamic feature width:** the spec says 126 (2 hands × 63). Our
dynamic model uses **132** = 126 shape + 6 wrist-position values. This was a
measured improvement, not a deviation for its own sake: with 126 the wrist sits
at the origin in every frame, so a hand held still and a hand sweeping across
the body produce an identical vector. Adding position took top-1 from 79.75% to
84.81% and removed every movement-pair confusion (bad/good, big/small,
dry/wet). The **static** ISL model will use 126 exactly as specified.

---

## Status table — Section 4 definition of done

Verified by running, as of the Phase 3a/6/7/8/9/10 work.

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Register and log in | **Working** | both demo accounts HTTP 200 |
| 2 | Home: new meeting, join by code, history | **Working** | `Dashboard.jsx`; join now routes via the lobby |
| 3 | Pre-join lobby, camera preview, device selection | **Working** | `Lobby.jsx` + `useMediaDevices.js`; choices applied with `exact` and carried into the room |
| 4 | Both see and hear each other | **Working** | `useWebRTC.js`, `/ws/signal/{code}`; ICE from env |
| 5 | Signing → live captions, continuous | **Working** | 17.5% WER continuous |
| 6 | Speaking → live captions | **Working** | Web Speech `en-IN`; Whisper verified at 1,134 ms |
| 7 | Captions labelled, both see them | **Working** | 🤟/🎤 badges, broadcast over `/ws/predict` |
| 8 | Transcript saved to MySQL | **Working** | rows confirmed in the live database |
| 9 | History → open → full transcript | **Working** | `/history/:code` with search, participants, duration, TXT + PDF |
| 10 | Interview mode: notify, fullscreen, block, report, log | **Working** | toggle, dialog, Keyboard Lock, overlay, host log; verified live: 42s absence round-tripped |

### Supporting

| Item | Status | Detail |
|---|---|---|
| Tests | **Working** | 231 pass, 2 skipped |
| Live inference path parity | **Working** | `test_inference_path.py` agrees with `evaluate.py` exactly on all three models |
| ICE servers from env | **Working** | `VITE_STUN_URLS`, `VITE_TURN_*` |
| Migrations | **Working** | `database/migrations/001_*.sql`, idempotent, applied and verified |
| PDF + TXT export | **Working** | server-side, shared header builder |
| Meeting timer, copy-link, caption size | **Working** | caption size reaches `SubtitleBar` |
| Dockerfiles + full compose | **Partial** | written and statically validated; **Docker is not installed here, so never built or run** |
| README | **Working** | measured numbers, licences, limits |

---

## Measured accuracy — held-out splits only

| Model | Measured | Split | Notes |
|---|---|---|---|
| ISL words (BiLSTM, `(30,132)`, 40 classes) | **85.23%** top-1, 94.63% top-3; **17.5% WER** continuous | random | INCLUDE records no signer id, so `signer_disjoint: false` |
| ISL fingerspelling (MLP, `(126,)`, 35 classes) | **92.04% macro recall** over 28 judgeable classes | **pose-disjoint** | weighted top-1 is 98.14% but inflated; 7 classes unjudgeable; H and J at 0% |
| ASL fingerspelling (MLP, `(63,)`, 28 classes) | 90.53% top-1, 96.91% top-3 | contiguous | baseline only |

Live-path latency: ASL 0.70 ms, ISL 0.71 ms, words 6.12 ms median.

---

## Decisions made, and why

- **Dataset substitution.** The brief named
  `eraakash/indian-sign-language-hand-landmarks-dataset`; it does not exist
  (0 datasets under that author, control dataset resolved fine). Three other
  ISL candidates on HF contain no data at all. Used
  `Hemg/Indian_sign_language_dataset` — 42,745 images, 35 classes. **No
  licence declared**, recorded as a caveat.
- **Pose-disjoint splitting for ISL fingerspelling.** 41,609 images collapse
  to 1,159 distinct poses (2.8%), scattered rather than adjacent, so no
  index-based split can separate copies. Without this the model reports 99.75%
  and means nothing.
- **Dynamic model keeps 132 features**, not the 126 the brief specifies.
  With 126 the wrist sits at the origin every frame, so a still hand and a
  sweeping hand are identical vectors. Position took top-1 from 79.75% to
  84.81%. The **static** ISL model uses 126 exactly as specified.
- **Vocabulary capped at 40.** Measured: 20 → 84.81%, 40 → 89.93%, 70 →
  78.99%. INCLUDE's clip counts fall off a cliff after ~48 words.
- **Inference is a compiled `tf.function`.** Masking around an LSTM forces a
  per-timestep path: 1,373 ms eager → 18 ms compiled.
- **Violation feed is polled, not pushed.** Adding a third message type to the
  inference socket would couple attention logging to sign recognition, so a
  failure in one would take the other down.
- **Tailwind advisories not fixed.** `npm audit --omit=dev` reports zero; they
  are dev-only. The only fix is a breaking Tailwind 4 migration.

---

## Known issues

1. **Docker stack never run.** Docker is not installed on this machine. YAML
   parses, all paths resolve, images unbuilt. The one genuinely unverified
   deliverable.
2. **No HTTPS.** Required for camera/mic/Web Speech from any device other than
   localhost. Documented, not provided.
3. **`useFocusMonitor.js` is now dead code**, superseded by
   `useInterviewMode.js`. Left in place rather than deleted; safe to remove.
4. **H and J fingerspelling at 0% recall**, and 7 letters unjudgeable — a
   property of the source data, not the training.
5. **Section 4 journey not walked in two browser windows.** Every layer below
   the browser is verified; the two-window click-through needs a human.

---

## Final verification run (end of session)

Both services restarted from cold, then the whole journey driven through the
API. Every step passed.

```
/health   status ok | db connected | dialect mysql
          ASL letters  loaded=True  28 classes
          ISL letters  loaded=True  35 classes   <- did not exist at session start
          ISL WORDS    loaded=True  40 classes  lang=ISL
          Whisper      loaded=True  base

OK  host + guest login                 200
OK  create meeting                     201
OK  host joins / guest joins           200
OK  host switches interview mode ON    200  (start time stamped)
OK  guest BLOCKED from toggling        403
OK  host sees violation                1x, longest 37000ms
OK  guest BLOCKED from the host log    403
OK  sign caption saved                 201
OK  speech caption saved               201
OK  transcript returns both lines      200
OK  history lists 25 meetings          200
OK  TXT export    376 bytes            200
OK  PDF export   2006 bytes            200  magic=%PDF
OK  non-member blocked                 404
OK  meeting ended                      200
```

Not covered by this run, and needing a human in a browser: the two-window
click-through, the camera preview in the lobby, fullscreen and Keyboard Lock
actually engaging, and a real microphone producing captions. Every layer
beneath those is verified above.

---

## Measured recognition gates (Part A4)

Thresholds live in `frontend/src/config/recognition.js` and were chosen by
measuring, not guessing. Reproduce with `python ml/scripts/measure_gates.py`.

Gates: **confidence ≥ 0.7**, **margin over runner-up ≥ 0.15**.

### Accuracy on held-out data

| | ISL words | ISL letters |
|---|---|---|
| Held-out samples | 149 clips | 6343 |
| Rejected by the gates | 8 (5.4%) | 16 (0.2%) |
| **Accuracy of accepted** | **88.65%** | **98.37%** |
| Accuracy overall | 83.89% | 98.12% |

A rejection is a *missed* caption, not a wrong one. The two matter differently:
a miss is recoverable by signing again, a wrong caption is not.

### Idle false-positive rate — the number that matters more

Fed input containing no sign at all, how often do the gates let something
through? Target is zero.

| Input | ISL words | ISL letters |
|---|---|---|
| No hands (all zeros) | **0.0%** | **100.0%** |
| One pose held perfectly still | **56.8%** | n/a (no motion concept) |
| Random landmark noise | 52.2% | 81.8% |

**These are worst-case numbers with motion gating removed, and they are the
honest reason the motion gate exists.**

Two things the confidence and margin gates genuinely cannot do:

1. **The letter model passes all-zeros 100% of the time.** It learned that an
   empty hand slot looks like something, because ~31% of its training hand
   slots were legitimately empty — ISL has one-handed letters. In production
   this cannot fire: the backend returns the neutral state without calling the
   model when no hands are present. But it means the probability output carries
   no information about whether a hand is there.

2. **A pose held still passes 57% of the time.** A resting hand IS a valid
   handshape, so the model is not *wrong* to be confident about it, and no
   probability threshold separates "resting in this shape" from "signing this
   letter". Stability gating cannot help either — a parked hand is perfectly
   stable. This is what produced the reported "detecting M at 71% while not
   signing".

Movement is the only signal that distinguishes them, which is why
`MOTION_LOOKBACK_FRAMES` exists: nothing is committed unless real movement
occurred within the last 20 frames (2 s at 10 FPS). A hand left in frame stops
producing captions about two seconds after it stops moving.

**Not yet measured:** the end-to-end false-positive rate *with* motion gating
active, because the motion gate runs in the browser against live landmark
velocity and there is no recorded idle-webcam fixture to replay through it.
Acceptance check A6.4 — hands resting for 30 seconds — is the manual test that
covers it, and it needs a human at a camera.

---

## Parts A and B complete — Part C (interface rebuild) NOT started

### The seven reported problems: root cause and fix

| # | Root cause | Fix |
|---|---|---|
| 1 | Whisper decoded each MediaRecorder fragment independently. Only the first carries the WebM init segment, so fragments 2+ decoded to **zero samples**. The server got 250 ms of audio then silence forever; the VAD discarded it as too short. Nothing logged, because "no audio in this chunk" looks identical to "quiet chunk" | `StreamDecoder` keeps the stream and decodes it whole, feeding forward only new samples. Also: engine default is now **Auto** (browser engine first) — Whisper was defaulting in Chrome and only emits on pause |
| 2 | The socket broadcast `result.sentence` — the **accumulated** sentence — as caption text, and a 2.5 s cooldown was the only repeat guard, so a held pose re-committed every time it lapsed | One caption event carrying only that segment's text; `useSignCaptions` commits once per **movement** segment and refuses to repeat until hands return to rest |
| 3 | Same accumulated-sentence broadcast, persisted once per emitted word → rows reading "a", "a b", "a b c" | One row per `segment_id`, written on the final event, with a **UNIQUE** DB constraint so a retry collides instead of duplicating |
| 4 | `track.enabled = false` keeps the camera open; the detection loop early-returned on `!cameraOn` **without clearing `landmarks`**, so the last skeleton stayed in React state over a black tile | Camera off now **stops** the track and releases the device; `replaceTrack` keeps the peer in sync; the overlay is cleared with it |
| 5 | `signDetectionOn` defaulted to **true** for every participant | Opt-in, defaults off, and gated on the camera being on |
| 6 | The lobby put `deviceId` in the join URL — a stable hardware identifier in a link users are told to share, plus history and Referer | `sessionStorage`, which also survives the reload the URL was for, and expires with the tab |
| 7 | Recognition was gated on display toggles inside panel components | Producing is automatic (mic unmuted / camera on). The captions button controls display only. Recognition moved to meeting-level hooks |

### Status

| Part | State |
|---|---|
| A — caption pipeline | **Done**, transport verified live |
| B — screen sharing | **Done**, signalling verified live; media path needs two browsers |
| C — interface rebuild | **Done** — see below |
| D — final verification | **Automated checks done. The checks that need a camera, a voice and two participants are listed below and are yours to run.** |

---

## Part C — interface rebuild: done

### The crash that started this, and why nothing caught it

The reported error was `Cannot access 'applyAndRecord' before initialization`.
It was not one mistake, it was **eleven**. `const` bindings are hoisted but sit
in the temporal dead zone until their initialiser runs, and MeetingRoom.jsx read
eight different bindings above the line that defined them:

| Binding | Used at | Declared at |
|---|---|---|
| `applyAndRecord` | 232 | 246 |
| `addScreenTrack`, `removeScreenSender`, `sendSignal` | 351–353 | 466 |
| `remotePresenter` | 363, 365, 375 | 466 |
| `interview` | 373, 375 | 423 |
| `remoteScreenStream` | 377 | 466 |
| `toggleCamera` | 393, 401 | 516 |

A hook **dependency array** is what makes this easy to miss. The callback body
is deferred and reads fine, but `[screenShare, remotePresenter, interview]` is
evaluated during render, so it throws before anything calls the callback.

Nothing caught it because nothing was looking. `package.json` had carried a
`lint` script and four pinned ESLint packages since Phase 0 **with no config
file**, so `npm run lint` exited with "couldn't find a configuration file".
`vite build` does not help: it transforms modules and performs no scope
analysis, so the bundle built cleanly while the page was broken.

Two things now cover it:

* `frontend/.eslintrc.cjs`, with `no-use-before-define` as an **error**.
* `frontend/src/test/` — vitest + jsdom mount all eight routes and fail if
  anything throws. `setup.js` also fails a test when React logs a render error,
  so a crash swallowed by an error boundary cannot pass silently.

### What was built

| Page | File | Notes |
|---|---|---|
| Login / Register | `pages/Login.jsx` | 400px card, floating labels, two routes one component |
| Home | `pages/Home.jsx` | New-meeting menu, code-or-link join, 5 recent meetings |
| Lobby | `pages/Lobby.jsx` | Mirrored preview, live mic level, 3 device pickers, "I will be signing" |
| Meeting room | `pages/MeetingRoom.jsx` | Stage / caption rail / control bar, 3 slide-in panels, Settings |
| Meeting ended | `pages/MeetingEnded.jsx` | Rejoin withheld once the meeting is over |
| History | `pages/History.jsx` | Server-side search over titles **and** caption text |
| Transcript | `pages/Transcript.jsx` | Chips, participant filter, highlighted search, TXT + PDF |
| Sign recognition check | `pages/SignDetection.jsx` | The extra page the spec's C8 asks to be listed |

Design system in `components/ui/` (Icon, Avatar, IconButton, Dialog, Menu,
TextField, Select, ToastHost, States, TopBar, Logo); meeting-specific pieces in
`components/meeting/` (Stage, MeetingTile, CaptionRail, ControlBar, SidePanel,
DetailsPanel, PeoplePanel, LiveTranscriptPanel, SettingsDialog).

Ten superseded files were deleted: `CaptionArea`, `MeetingHeaderControls`,
`ModeSwitch`, `SpeechControls`, `SubtitleBar`, `TranscriptPanel`,
`TranscriptDownloadButton`, `VideoTile`, `useFocusMonitor`, `useSpeechToText`,
plus `Dashboard` and `MeetingDetail` which Home and Transcript replace.

### Bugs found and fixed while building it

1. **The lobby's device picker did nothing.** Problem 6 was a raw `deviceId` in
   the join URL. The lobby was moved to `sessionStorage`, but MeetingRoom was
   never updated — it still read `searchParams.get('camera')`, which is now
   always `null`. Every meeting silently used the system default camera and
   microphone. A test now asserts the chosen ids reach `getUserMedia`.

2. **A lost canvas context destroyed the whole meeting.** `HandOverlayCanvas`
   used `canvas.getContext('2d')` without a null check. That is null in a real
   browser when the GPU context is lost — a driver reset, or a backgrounded tab
   reclaimed under memory pressure. The throw lands in React's commit phase and
   escalates to the nearest error boundary, so losing a decorative skeleton
   overlay took down the camera, the captions and the call. Guarded.

3. **`DEMO-01` became unjoinable.** `formatMeetingCode` re-grouped codes into
   the generator's `ABC-DEF` shape. The seeded demo meeting's code is four
   characters then two, so regrouping produced `DEM-O01` and joining failed with
   "meeting not found". Codes are opaque strings compared for equality;
   reformatting one is never safe.

4. **52 class names silently rendered as nothing.** Removing `ink-*`,
   `bridge-*` and `signal-*` from `tailwind.config.js` left 52 references across
   6 files. Tailwind drops classes it cannot resolve, with no error anywhere, so
   those components would have appeared completely unstyled. All remapped.

5. **The transcript search could be crashed by typing a bracket.** The
   highlighter built a `RegExp` from the raw query, so `(` threw
   "Unterminated group" and took the page down. The needle is escaped.

6. **The interview log would have shown only em dashes.** It read
   `event.duration_ms`; `FocusEventPublic` calls it `duration_away_ms`.

7. **The sign button lied for a moment.** It said "No sign recognition model is
   loaded" during the fraction of a second before the socket reported. "Not
   loaded" and "not yet known" are now distinct states.

### Two backend changes the interface needed

`GET /api/meetings/history` previously returned `MeetingPublic`, which carries
neither participants nor a caption count — both of which the Home cards and
History rows draw. The alternative was the frontend fetching each meeting
individually, which is an N+1 moved onto the network.

New `MeetingSummary` adds both. This reverses a caution in `MeetingDetail`'s own
docstring about history "dragging every participant row along", so the cost is
handled rather than ignored: `selectinload` for participants and their users,
and **one grouped COUNT** for the captions. Four queries regardless of how many
meetings. `test_history_does_not_issue_a_query_per_meeting` fails if the eager
loading is ever removed.

The endpoint also takes `?q=`, searching titles **and** caption text, because
"the meeting where we talked about the dataset" is how people actually look for
a transcript. Caption text is matched with a **subquery, not a JOIN** — a join
returns one row per matching caption, so a meeting containing the word five
times would appear five times.
`test_history_search_returns_each_meeting_once` guards exactly that.

### Automated verification — what I ran, and what it proves

```
cd frontend && npm run lint      0 errors, 6 warnings
cd frontend && npm test          13 passed
cd frontend && npx vite build    built in 2.6s
pytest backend/tests -q          258 passed, 2 skipped
```

The 6 remaining lint warnings are 5 × `react-refresh/only-export-components`
(files that deliberately export a hook beside a component) and 1 pre-existing
`exhaustive-deps` in `SignDetection.jsx`. None affects correctness.

Live, against the running backend on MySQL:

```
GET  /health                     all three models loaded, MySQL connected,
                                 Whisper base ready
POST /api/auth/login/json        200
GET  /api/meetings/history       200, 32 meetings, caption_count and
                                 participants present on every row
GET  /api/meetings/history?q=…   200, filters correctly
GET  /api/meetings/DEMO-01       200 — confirms fix 3 above
```

Model status as actually reported by `/health`:

| Model | Loaded | Classes | val_accuracy |
|---|---|---|---|
| ASL letters (`static`) | yes | 28 | 0.9404 |
| ISL letters (`isl`) | yes | 35 | 0.9919 |
| ISL words (`dynamic`) | yes | 40 | 0.8571 |

**These are validation figures, not test figures.** The validation split is what
early stopping and threshold choices were made against, so it is optimistic by
construction. The honest held-out numbers are the ones already recorded earlier
in this file: **90.5%** test accuracy for Model A, and **92.04% macro recall**
for the ISL letters model under pose-disjoint splitting, with 7 unjudgeable
classes and H and J at 0%. The Settings dialog labels its number "validation
accuracy" for this reason, and prints "No accuracy recorded" rather than leaving
a blank where there is no figure.

---

## Part D — what still needs a human

Everything below needs a camera, a voice, or two participants, so none of it can
be verified from a terminal. **I have not seen any of it work.**

Start both servers, then open **two different browser profiles** (not two tabs —
each needs its own camera permission and its own login):

```bash
./scripts/run_backend.sh      # :8000
./scripts/run_frontend.sh     # :5173
```

Sign in as a different account in each. Add `?debug=1` to the meeting URL to get
the diagnostic overlay.

### D1 — the outcome that matters most

| # | Do this | Expect |
|---|---|---|
| 1 | Hearing user says a full sentence | Grey interim text appears on **both** screens within ~1s, and turns **white** when they pause |
| 2 | Deaf user signs a word | The word appears on **both** screens, once |
| 3 | Open the Transcript panel | Exactly one entry per utterance. No entry contains an earlier entry's text |
| 4 | Rest hands in frame, 30 seconds | **Zero** captions appear |
| 5 | Hold one sign for 5 seconds | It appears **once**, not repeatedly |
| 6 | Mute, speak, unmute, speak | Captions stop, then resume with no further click |
| 7 | One user presses CC off | The other still receives everything; the transcript stays complete |

If 1 or 2 fails, read the `?debug=1` overlay and tell me which line is wrong —
mic track state, engine, last caption sent, last caption received. That
distinguishes "not recognised" from "recognised but not delivered", which have
completely different causes.

### D2 — screen sharing

| # | Do this | Expect |
|---|---|---|
| 1 | Press Present, choose a window | Screen fills the stage; **both camera tiles stay visible** in the right-hand strip |
| 2 | Watch from the other browser | The same screen appears, letterboxed, never cropped |
| 3 | Press Stop presenting | Layout returns to normal for both |
| 4 | Present again, then use the **browser's own** "Stop sharing" bar | Layout returns to normal for both |
| 5 | Press Present, then cancel the picker | Nothing happens, and **no error appears** |
| 6 | While A presents, B presses Present | B is asked "Take over presenting?" |
| 7 | Sign while presenting | Captions keep working, read from the camera and not the screen |

### D3 — every page, at desktop width and below 900px

Login → Register → Home → lobby → meeting → leave → meeting-ended →
transcript → History → transcript → `/detect`. In the meeting, open each of
the three right-hand panels (the stage should shrink, only one open at a time),
open Settings and walk all three tabs, and try `Ctrl/Cmd+D`, `Ctrl/Cmd+E` and
`C`.

### D4 — interview mode

Host turns it on from the More menu. The other participant should get the
acknowledgement dialog, an "Interview mode" chip at the top-left of the stage,
and a blocking overlay if they switch tab. Opening the screen picker must **not**
be recorded as a violation. Afterwards, the host opens the transcript and
expands "Interview mode log".

### Known limitations, stated plainly

* **Untrained-model honesty.** All three models load here, but only Model A has
  a held-out test figure measured under a disjoint split. No claim is made for
  the others beyond what `/health` reports.
* **Continuous signing.** A signer who moves from one sign to the next without
  pausing is still the hard case; measured word error rate was 17.5% on a
  continuous stream built from held-out clips, and 34.2% with pauses.
* **Idle false positives.** The ISL letters model fires on empty landmark slots
  (measured 100% on zero-input frames), because ~31% of its training slots were
  legitimately empty. `MOTION_LOOKBACK_FRAMES` exists to gate that, and D1
  check 4 is the test that it works in practice.
* **Speaker selection.** `setSinkId` is Chromium-only, so the speaker dropdown
  is hidden in Firefox and Safari rather than shown doing nothing.
* **Preferences do not follow you to another computer.** Caption size, engine
  and recognition mode live in `localStorage` per user id, not on the server.
* **Icons need the network on first load.** Material Symbols comes from Google
  Fonts, with `display=block` so the control bar never shows the literal
  ligature names. Offline on a cold cache, the icons are blank; every button
  still has its tooltip and accessible label.



---

## Technical documentation — complete

`docs/BridgeTalk_Project_Documentation.md` — 21 sections plus a verification
appendix, 5,538 lines, 10 Mermaid diagrams, 174 tables.

A **read-only** exercise over the application code: `git diff` confirms nothing
outside `docs/` and this file changed. Facts come from the source, the live MySQL
schema, the saved model artefacts, and commands run while writing.

### Completeness, audited programmatically against the code

| Item | In code | In document |
|---|---|---|
| HTTP route entries | 22 (18 ours + 4 FastAPI) | 22 |
| WebSocket endpoints | 3 | 3 |
| Route handler functions | 21 | 21 |
| Pydantic schemas | 20 ours (+3 generated) | 20 |
| Database tables | 5 | 5 |
| Database columns | 34 | 34 |
| Frontend routes | 10 `<Route>` (9 pages) | 10 |
| Page components | 8 | 8 |
| Custom hooks | 12 | 12 |
| Backend test files | 15 | 15 |
| Environment variables | all from `.env.example` | all |
| WebSocket message types | 11 / 13 / 6 per socket | 11 / 13 / 6 |

A script checked every one of these appears by name in the document. It found
three gaps (the WebSocket handler names) which were then added. Final run: no
gaps. 43 internal links all resolve.

### Defects found while documenting — recorded, not fixed

| ID | Severity | Issue |
|---|---|---|
| **K-1** | **Critical** | **Settings → Captions → "Browser (Web Speech)" crashes the meeting room, and the crash survives a reload.** The dialog stores `speechEngine: 'browser'`, but the registry in `services/stt/index.js` is keyed `webspeech`. `resolveProvider('browser')` reaches its fallback branch and dereferences `PROVIDERS['browser'].label` on `undefined`, throwing `TypeError`. It is called in the body of `useSpeechCaptions`, so it throws during render. The preference persists in `localStorage`. **Confirmed by running the real module under Vitest.** Workaround: keep the engine on "Auto" or "Whisper" |
| **K-2** | Major | `POST /api/transcripts` accepts `segment_id` and silently discards it, so rows created that way are not protected by `UNIQUE (meeting_id, segment_id)`. No frontend page calls this endpoint. **Confirmed against the live API** |
| **K-3** | Major | `GET /api/meetings/{code}/focus-events` omits `duration_away_ms` from every event, so the host's interview log shows an em dash for every duration. The `by_participant` aggregates are correct. **Confirmed against the live API and the database** |
| **K-4** | Minor | Model C has 0.0000 recall on ISL letters `H` and `J` |

Plus discrepancies K-5 to K-10 (notably: the ISL letters dataset's name, source
and licence are **not recorded anywhere**, and `isl_dataset_manifest.json`
carries the ASL dataset's details) and operational limits K-11 to K-20.

### Verification side effects

Exercising the live API created rows in the development database, left in place
rather than deleted: `meetings` id 139 (`4T9-7M2`), `meeting_participants`
id 157, `focus_events` ids 25–26, `transcripts` id 51. That meeting also has
Interview Mode switched on.


---

## Reported bugs 1–5 — fixed

Five bugs from two-participant testing, fixed in order. Full detail, root causes
and the manual test script are in **`FIXES.md`**.

| Bug | What was wrong | Root cause | Status |
|---|---|---|---|
| **1** | Captions shown one line per segment, so a pause started a new line | A *segment* is an utterance boundary, not a line of display. `CaptionRail` mapped store entries one-to-one onto elements | **Fixed.** `utils/captionBlocks.js` groups consecutive segments from one speaker into one continuous paragraph. Display-only |
| **2** | Each user saw their own captions echoed back | The server broadcasts to everyone including the sender — deliberately — and the rail rendered all of it | **Fixed.** One rule in the display layer: show captions from other participants, never your own. Filtered by speaker, not source |
| **3** | **Interview mode did not work** | The state reached only the **host**. `MeetingRoom` fetched the meeting once on mount; there was no broadcast and no re-read, so `interviewOn` stayed false on the participant's screen and no enforcement ever ran | **Fixed.** Live broadcast plus room state in the socket handshake. Also made one-way, with a locked Leave, host violation alerts, and a proper teardown on end |
| **4** | Participant count wrong on Home and History | `meeting_participants` was append-only, so the count was a **row** count. The live database held 207 rows for 72 distinct pairs | **Fixed.** Migration 003 merges duplicates and adds a UNIQUE key; `join_meeting` upserts; `COUNT(DISTINCT user_id)` is computed server-side and read by all four surfaces |
| **5** | Layout broke in an incognito window | Fonts came from Google's CDN. Measured: the icon font was still loading after **2.5 s** on a warm network and never loaded on a blocked one | **Fixed.** Roboto and Material Symbols self-hosted from npm. Blocking the CDN now changes nothing |

Also fixed on the way: **K-1** (selecting "Browser" as the speech engine crashed
the meeting), **K-3** (the host's interview log showed an em dash for every
duration), **K-14** (icons needed the network), a meeting created with interview
mode on never stamping its start time, and a word-loss path when Chrome restarts
speech recognition without delivering a final.

### Suites

| Suite | Baseline | Now |
|---|---|---|
| Backend | 258 passed, 2 skipped | **276 passed, 2 skipped** |
| Lint | 0 errors, 6 warnings | **0 errors, 6 warnings** |
| Frontend | 13 passed | **71 passed** |
| Build | succeeded | **succeeded** |
| Profile comparison | — | **0 of 15 layouts differ**, with the font CDN blocked |

Three baseline tests were intentionally rewritten because the brief changes the
behaviour they encoded — the two-way interview toggle, the rollup's
before-and-after setup, and the append-only attendance row. Each is named and
explained in `FIXES.md`.

### Still needing a human

`FIXES.md` holds a two-device script covering every bug, step by step, with what
to expect. Interview mode and the speech half of Bug 1 **need two devices**:
`npm run dev:lan` serves the frontend over HTTPS on the local network with
`/api` and `/ws` proxied through it, so the second device needs one address and
one certificate.
