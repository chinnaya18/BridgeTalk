# BridgeTalk

**AI-Assisted Real-Time Communication Platform for Deaf and Hearing Individuals**

Sign language → text, in real time, inside a video call.

| | |
|---|---|
| **Course** | MCA Mini Project |
| **Institution** | PSG College of Technology, Department of Computer Applications |
| **Team** | Swarna Rathna A · Thamizhthilaga S D S |
| **Guide** | Dr. R. Manavalan |

---

## Contents

1. [Summary](#1-summary)
2. [Problem statement](#2-problem-statement)
3. [What this MVP does and does not do](#3-what-this-mvp-does-and-does-not-do)
4. [Glossary](#4-glossary)
5. [System architecture](#5-system-architecture)
6. [End-to-end data flow](#6-end-to-end-data-flow)
7. [Module-by-module deep dive](#7-module-by-module-deep-dive)
8. [The machine learning, explained from zero](#8-the-machine-learning-explained-from-zero)
9. [Dataset documentation](#9-dataset-documentation)
10. [Model results](#10-model-results)
11. [API reference](#11-api-reference)
12. [Database schema](#12-database-schema)
13. [Setup guide](#13-setup-guide)
14. [How to run](#14-how-to-run)
15. [Project structure](#15-project-structure)
16. [Troubleshooting](#16-troubleshooting)
17. [Testing](#17-testing)
18. [Limitations and known issues](#18-limitations-and-known-issues)
19. [Future enhancements](#19-future-enhancements)
20. [References](#20-references)

---

## 1. Summary

BridgeTalk is a browser-based video-calling platform that translates **sign
language into text in real time**, so a deaf participant and a hearing
participant can hold a conversation without a human interpreter present.

Hand tracking runs **in the browser** using Google's MediaPipe. Only the 21
hand-landmark coordinates — a few hundred bytes per frame — travel to the
server, where a TensorFlow model classifies the handshape and streams the
recognised text back over a WebSocket. **Raw video never leaves the
participant's machine.**

The reverse direction (speech → captions) uses the browser's native Web Speech
API, and the 1:1 video call itself is peer-to-peer WebRTC, with our backend
acting only as an introduction service.

**Current results:** 90.5% top-1 accuracy on a held-out test split of 6,440
samples, 96.9% top-3, with a median server round-trip of **6.2 ms**. The model
trains from a public dataset in **62 seconds on a CPU**.

---

## 2. Problem statement

Zoom, Google Meet and Microsoft Teams all provide speech-to-text captions. A
deaf participant can therefore *read* what a hearing participant says.

There is no reverse channel. A hearing participant cannot understand sign
language, so the conversation stays one-directional unless a human interpreter
joins the call. Interpreters are expensive, must be booked in advance, and are
simply unavailable for an unplanned five-minute conversation.

```
Hearing user speaks  ──▶ Web Speech API ──▶ caption on deaf user's screen   ✅ exists today
Deaf user signs      ──▶       ???       ──▶ text on hearing user's screen  ❌ the gap
                              ▲
                       this is what BridgeTalk builds
```

BridgeTalk closes that loop, and keeps both directions in one meeting room.

---

## 3. What this MVP does and does not do

**It does:**

- Recognise **static ASL fingerspelling handshapes** — A–Z plus `space` and
  `del` — from a standard laptop webcam, with no GPU.
- Assemble recognised letters into words with temporal smoothing, so output
  does not flicker or repeat.
- Run a 1:1 WebRTC video call with live captions in both directions.
- Persist transcripts to MySQL and export them as a text file.
- Log tab-focus changes in Interview Mode.

**It does not:**

- Translate sign-language *grammar*. ASL has its own syntax, word order and
  non-manual markers. This is gesture-to-text recognition, not linguistic
  translation.
- Recognise word-level signs *yet*. Model B's pipeline is complete — extraction,
  signer-disjoint splitting, the LSTM, live sequence buffering, WebSocket
  routing and a UI toggle, all tested — but it has **not been trained**, because
  the WLASL dataset is a multi-gigabyte download that has not been fetched. No
  accuracy is claimed for it anywhere. See [ml/README.md](ml/README.md).
- Support Indian Sign Language. See [Future enhancements](#19-future-enhancements).
- Work reliably in poor lighting, at extreme camera angles, or with the hand
  partly out of frame — MediaPipe must see the hand to landmark it.
- Reach 90% accuracy on *your* webcam. See
  [Limitations](#18-limitations-and-known-issues) — the domain gap is real and
  measured.

---

## 4. Glossary

Read this first if any term below is unfamiliar; the rest of the document
assumes them.

| Term | Plain-language meaning |
|---|---|
| **Landmark** | One tracked point on the hand — a knuckle, a fingertip, the wrist. MediaPipe finds 21 of them per hand, each with an (x, y, z) position. |
| **Normalisation** | Rescaling numbers so irrelevant differences disappear. Here: moving the hand so the wrist sits at zero, and resizing so the hand always spans the same distance — so *where* and *how far away* the hand is stop mattering. |
| **MLP** (multi-layer perceptron) | The simplest kind of neural network: layers of numbers, each fully connected to the next. Good when the input is already a short list of meaningful values, which 63 landmark coordinates are. |
| **LSTM** | A network that reads a *sequence* and remembers what came earlier. Needed for signs defined by movement rather than a single pose. |
| **Softmax** | The final step that turns raw network outputs into probabilities adding up to 1, so "70% sure it's an A" is meaningful. |
| **Confidence threshold** | The minimum probability we accept. Below it, the prediction is discarded rather than shown. |
| **Inference** | Using a trained model to make a prediction. (Training is the opposite: adjusting the model using known answers.) |
| **Epoch** | One complete pass over the training data. |
| **Overfitting** | When a model memorises the training examples instead of learning the pattern — high training accuracy, poor real-world accuracy. |
| **WebSocket** | A network connection that stays open, letting both sides send messages whenever they like. Ordinary HTTP is one request, one response. |
| **WebRTC** | The browser technology that sends audio and video **directly** between two browsers, without passing through a server. |
| **Signalling** | The introduction step before WebRTC works: two browsers exchange network details through a server they can both already reach. |
| **STUN** | A server that tells a browser its own public internet address, which it cannot discover on its own from behind a home router. |
| **JWT** (JSON Web Token) | A signed ticket proving who you are, sent with each request so you do not resend your password. Signed, **not** encrypted — anyone can read its contents. |

---

## 5. System architecture

```mermaid
graph TB
    subgraph Browser1["Browser — deaf participant"]
        CAM[Webcam] --> MP["MediaPipe HandLandmarker<br/>(WASM, in the browser)"]
        MP --> NORM["landmarkUtils.js<br/>21×3 → 63 normalised floats"]
        MP --> OVL["HandOverlayCanvas<br/>draws the skeleton"]
        NORM --> WS1["useSignSocket<br/>throttled to 10 FPS"]
        RTC1["useWebRTC"]
    end

    subgraph Backend["FastAPI backend"]
        WSI["/ws/predict/{code}<br/>inference.py"]
        WSS["/ws/signal/{code}<br/>signaling.py"]
        PRED["predictor.py<br/>model loaded once at startup"]
        SMOOTH["smoothing.py<br/>gate → vote → debounce → reset"]
        API["REST: auth · meetings · transcripts · focus"]
        WSI --> PRED --> SMOOTH --> WSI
    end

    subgraph Browser2["Browser — hearing participant"]
        SUB["CaptionRail + LiveTranscriptPanel"]
        STT["useSpeechCaptions<br/>Web Speech API or Whisper"]
        RTC2["useWebRTC"]
    end

    DB[("MySQL 8+<br/>users · meetings · participants<br/>transcripts · focus_events")]

    WS1 -- "landmark JSON<br/>~5 KB/s" --> WSI
    WSI -- "prediction JSON" --> WS1
    WSI -- "subtitle broadcast" --> SUB
    STT -- "speech text" --> WSI
    RTC1 <-. "offer / answer / ICE" .-> WSS
    RTC2 <-. "offer / answer / ICE" .-> WSS
    RTC1 <== "audio + video, peer-to-peer<br/>never touches our server" ==> RTC2
    API --> DB
    SMOOTH --> API

    style MP fill:#1e3a5f,color:#fff
    style PRED fill:#1e3a5f,color:#fff
    style DB fill:#3f2b56,color:#fff
```

### The decision that shapes everything

**Hand tracking runs in the browser. Only coordinates cross the network.**

| | Landmarks in the browser (chosen) | Video to the server (rejected) |
|---|---|---|
| Bandwidth | ~5 KB/s | ~500 KB/s – 2 MB/s |
| Privacy | Video never leaves the user's machine | Every frame of a private conversation on our server |
| Server cost | One small matrix multiply per frame | Full MediaPipe pipeline per user per frame |
| Scaling | Tracking cost scales with clients, for free | Server is the bottleneck at a handful of users |
| **Trade-off** | **Requires a browser with WASM + WebGL** | Works on any client |

The trade-off is real: a browser without WebAssembly cannot run BridgeTalk at
all. For a conferencing tool used on laptops that is an easy trade, and it is a
genuine design strength rather than an implementation detail.

**Two separate WebSockets**, not one. The inference socket and the signalling
socket have different lifetimes and different failure modes. Multiplexing them
would mean a dropped video call also kills sign recognition — precisely
backwards, since recognition is the part a deaf user cannot do without.

---

## 6. End-to-end data flow

Tracing one letter from hand to screen. File and function named at each step.

1. **Camera frame** arrives in the `<video>` element.
   [`MeetingRoom.jsx`](frontend/src/pages/MeetingRoom.jsx) — `startMedia()` called `getUserMedia` once and shares the stream.

2. **Hand detection.** A `requestAnimationFrame` loop calls
   [`useHandLandmarker.js`](frontend/src/hooks/useHandLandmarker.js) → `detect(video)`,
   which runs `HandLandmarker.detectForVideo`. This is WebAssembly, on the
   user's own CPU/GPU. Output: 21 points, each `{x, y, z}` in 0–1 image space.

3. **Skeleton drawn.** [`HandOverlayCanvas.jsx`](frontend/src/components/HandOverlayCanvas.jsx)
   paints the 21 points and their connections over the video. Purely local.

4. **Wire format.** [`landmarkUtils.js`](frontend/src/utils/landmarkUtils.js) →
   `toWireFormat(result)` converts to `[{handedness, landmarks: [[x,y,z], …]}]`.
   **Coordinates only — there is no pixel data in this object.**

5. **Throttled send.** The loop runs at ~60 Hz but sends at 10 Hz.
   [`useSignSocket.js`](frontend/src/hooks/useSignSocket.js) → `sendLandmarks()`
   writes JSON to `/ws/predict/{code}`. It drops frames if `bufferedAmount`
   grows, rather than building a backlog.

6. **Server receives.** [`ws/inference.py`](backend/app/ws/inference.py) →
   `predict_socket()` reads the message. If `hands` is empty it emits the
   neutral state **without calling the model** and skips to step 9.

7. **Normalisation.** [`ml/normalization.py`](backend/app/ml/normalization.py) →
   `normalize_primary_hand(hands)` translates the wrist to the origin, scales so
   the furthest landmark sits at distance 1, and flattens to 63 floats. This is
   the same arithmetic the training data went through.

8. **Prediction.** [`ml/predictor.py`](backend/app/ml/predictor.py) →
   `predictor.predict(features)` calls the Keras model directly (not
   `.predict()`, which costs ~50 ms of batching machinery per call). Returns a
   label and a softmax probability.

9. **Smoothing.** [`ml/smoothing.py`](backend/app/ml/smoothing.py) →
   `smoother.push(label, confidence)` applies the four filters (confidence
   gate, majority vote, debounce, neutral reset) and updates the sentence.

10. **Reply.** The server sends `{type: "prediction", label, confidence,
    stable, sentence, latency_ms}` back to the signer. Median 6.2 ms.

11. **Broadcast.** If a letter was *accepted*, `inference_manager.broadcast()`
    sends a `caption` message to EVERY participant including the sender —
    accepted tokens only, never per-frame flicker. One protocol serves both
    directions; see section 7.9.

12. **Display.** Every participant's
    [`CaptionRail.jsx`](frontend/src/components/meeting/CaptionRail.jsx) shows
    the text in an `aria-live` region, replacing the line with that
    `segment_id` rather than appending — which is what stops a caption growing
    into "warm warm warm". The running record is in
    [`LiveTranscriptPanel.jsx`](frontend/src/components/meeting/LiveTranscriptPanel.jsx),
    which reads the persisted rows from the database rather than this list, so
    it agrees with the exported file.

13. **Persistence.** At a word boundary (`space`), `MeetingRoom.jsx` posts the
    completed word to `POST /api/transcripts`, which writes it to MySQL.

---

## 7. Module-by-module deep dive

### 7.1 Authentication

*What it does:* registration, login, and protecting every other endpoint.

*Why JWT:* the alternative is server-side sessions, which need shared storage
the moment you run more than one process. A signed token needs no storage — the
server verifies the signature and trusts the contents.

*Key files:* [`core/security.py`](backend/app/core/security.py) (hashing, token
create/verify), [`core/deps.py`](backend/app/core/deps.py) (`get_current_user`),
[`api/auth.py`](backend/app/api/auth.py).

*How data moves:* password → bcrypt hash → `users.password_hash`. Login
verifies and returns a HS256 JWT whose `sub` claim is the user id. Every
protected request re-reads the user row, so a deleted account stops working
immediately rather than at token expiry.

*How to extend:* add refresh tokens, or swap bcrypt for argon2 — `pwd_context`
already has `deprecated="auto"`, so old hashes upgrade on next login.

### 7.2 Meetings

*What it does:* create, join, leave, end, and list meetings.

*Why short codes:* a meeting code gets read aloud and typed by someone watching
a video call rather than their keyboard. Codes are drawn from
`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — **0, 1, I, L and O are excluded** because
they are the characters that cause failed joins. `secrets.choice`, not
`random`, because the code is the only thing between a stranger and a private
conversation.

*Key files:* [`api/meetings.py`](backend/app/api/meetings.py),
[`models/meeting.py`](backend/app/models/meeting.py).

*How to extend:* group meetings need the participant cap lifted and the WebRTC
layer changed from one peer connection to a mesh (or an SFU).

### 7.3 Hand tracking

*What it does:* turns camera frames into 21 landmarks, in the browser.

*Why MediaPipe over a custom CNN:* MediaPipe's hand model was trained by Google
on far more data than we could gather, it runs in real time on a CPU, and it
gives us a representation that is invariant to lighting and skin tone in a way
raw pixels are not. Training our own detector would be a project in itself and
would be worse.

*Key files:* [`useHandLandmarker.js`](frontend/src/hooks/useHandLandmarker.js).

*Note:* assets are served from `public/models/`, **not a CDN**. A college
network that blocks CDNs would otherwise break hand tracking with a 404.

### 7.4 Normalisation

*What it does:* removes hand position and camera distance from the features.

*Why it is the most safety-critical code here:* the same arithmetic runs in
three places — training, backend inference, and the browser. If they disagree
even slightly, training accuracy stays at 95% while live predictions become
noise, **with nothing in any log to explain it**.

*Key files:* [`ml/normalization.py`](backend/app/ml/normalization.py) (the one
Python implementation — the training scripts import it rather than
reimplementing it), [`landmarkUtils.js`](frontend/src/utils/landmarkUtils.js),
and [`test_normalization_parity.py`](backend/tests/test_normalization_parity.py)
which runs identical inputs through both languages and asserts agreement to
1e-6. That test was verified to **fail** when a 0.001% divergence is injected.

`metadata.json` records `"normalization_version": 1`, and the backend refuses to
load a model whose version does not match — turning a stale model file into a
loud startup error instead of a silent accuracy collapse.

### 7.5 Classification

*What it does:* 63 floats → one of 28 classes.

*Why an MLP:* the input is already a short list of meaningful numbers. A
convolutional network would have to relearn hand detection from scratch, take
hours on a CPU, and additionally memorise the dataset's backgrounds and
lighting.

*Key files:* [`ml/predictor.py`](backend/app/ml/predictor.py),
[`ml/scripts/train_static.py`](ml/scripts/train_static.py).

### 7.6 Smoothing and sentence assembly

*What it does:* turns flickering per-frame predictions into readable text.

*Why it is not optional:* at 10 FPS, holding one handshape for two seconds
produces 20 letters. The frames *between* two signs contain a hand in
transition, which the model dutifully classifies as some third letter. No amount
of model accuracy fixes this — the model is answering "what letter is this
frame?", which is not the question a conversation needs answered.

Four filters in series:

| Filter | Setting | Removes |
|---|---|---|
| Confidence gate | ≥ 0.80 | Transition frames, where the model is genuinely unsure |
| Majority vote | 7 of last 10 | Single-frame flickers |
| Debounce | 1500 ms per label | `AAAAAAAA` from a held handshape |
| Neutral reset | 8 empty frames | Lets you repeat a letter by lowering your hand |

*Key files:* [`ml/smoothing.py`](backend/app/ml/smoothing.py),
[`test_smoothing.py`](backend/tests/test_smoothing.py).

### 7.7 Video calling

*What it does:* a 1:1 audio/video call, peer-to-peer.

*Why the server is only a relay:* WebRTC media goes browser to browser. Our
backend passes the introduction (offer, answer, ICE candidates) and then steps
out of the media path entirely. It never sees a video frame.

*Key files:* [`ws/signaling.py`](backend/app/ws/signaling.py),
[`useWebRTC.js`](frontend/src/hooks/useWebRTC.js).

*Known limit:* STUN only, no TURN. Two peers behind symmetric NAT will fail to
connect. See [Limitations](#18-limitations-and-known-issues).

### 7.8 Speech-to-text

*What it does:* captions the hearing participant for the deaf participant.

*Why Web Speech API over Whisper:* it is already in the browser, streams results
word by word with no perceptible delay, and needs no model download or GPU.

*The honest cost:* in Chrome this is **not local** — audio is sent to Google for
recognition. For a tool handling private conversations that is a genuine privacy
cost, and it sits oddly beside our "video never leaves your machine" claim for
the sign direction. Whisper is the documented upgrade path.

*Key files:* [`useSpeechCaptions.js`](frontend/src/hooks/useSpeechCaptions.js),
and [`services/stt/`](frontend/src/services/stt/) which puts Web Speech and
Whisper behind one interface.

---

## 8. The machine learning, explained from zero

### 8.1 What a hand landmark is

MediaPipe locates 21 specific points on a hand:

```
        8   12  16  20        ← fingertips
        |   |   |   |
        7   11  15  19
        |   |   |   |
    4   6   10  14  18
    |   |   |   |   |
    3   5   9   13  17
     \   \  |  /   /
      2   \ | /   /
       \   \|/   /
        1   |   /
         \  |  /
          \ | /
            0                 ← wrist (the normalisation origin)
```

Point 0 is the wrist. Points 1–4 are the thumb, 5–8 the index finger, and so on.
Each carries an (x, y, z) position, so one hand is **21 × 3 = 63 numbers**.

### 8.2 Why classify landmarks instead of pixels

A 200×200 colour image is 120,000 numbers, most of which describe the wall
behind the hand. Those 63 landmark numbers describe *only* the hand's shape.

That difference matters three times over:

- **Training is fast.** 62 seconds on a CPU, versus hours for a CNN.
- **Lighting and skin tone stop mattering.** MediaPipe already solved "where is
  the hand"; our model only solves "what shape is it in". A CNN trained on this
  dataset would also learn its backgrounds and fall apart in a different room.
- **Training and inference see the same thing.** MediaPipe runs in the browser
  at inference time and produces exactly these landmarks.

### 8.3 Why normalisation matters

Raw MediaPipe coordinates depend on two things that have nothing to do with
which letter is being signed:

- **Where** the hand is in the frame. Signing in the corner gives completely
  different numbers from signing in the centre.
- **How far** the hand is from the camera. Leaning in doubles every value.

Train on raw coordinates and the model learns "an A is a hand in the middle of
the frame, 60 cm away", which collapses the moment anyone sits differently.

The fix, in two steps:

1. **Translate** — subtract the wrist from all 21 points, so the wrist is at
   (0,0,0). Position no longer matters.
2. **Scale** — divide by the largest distance from the wrist, so the hand always
   spans exactly 1.0. Distance no longer matters.

A pleasant consequence worth knowing: this makes **scale-jitter augmentation a
mathematical no-op**. Scaling a sample and re-normalising returns the original
vector exactly. Scale invariance is already guaranteed by the representation,
so we omit that augmentation rather than adding one that does nothing.

### 8.4 Why static and dynamic signs need different models

A letter like **A** is fully determined by one frame — there is no motion to
model, so a single-frame MLP is exactly right.

A word sign like **"hello"** is a *movement*. One frame of it is meaningless;
the information is in how the hand travels over time. That needs a network that
reads a sequence and remembers what came earlier — an LSTM. Specification in
[ml/README.md](ml/README.md); not trained in this MVP.

### 8.5 What the training numbers mean

```
Epoch 7/100
1873/1873 - 3s - accuracy: 0.9903 - loss: 0.0310 - val_accuracy: 0.9404
```

- **accuracy** — how often it is right on data it is *learning from*.
- **val_accuracy** — how often it is right on data held back from training.
  This is the number that matters.
- **loss** — how wrong it is, weighted by confidence. Being confidently wrong
  costs more than being unsure and wrong.
- **The gap between them** is the overfitting signal. Ours is 99.3% vs 94.0%,
  a ~5 point gap — some memorisation, but within the normal range.

Training stopped at epoch 18 of a possible 100 because validation loss stopped
improving, and **restored the weights from epoch 7** — the best one seen, not
whichever the last epoch happened to produce.

### 8.6 How to read a confusion matrix

![Confusion matrix](docs/images/confusion_matrix.png)

Rows are the true letter, columns are what the model predicted. A perfect model
is a bright diagonal and nothing else. Each off-diagonal cell is a mistake, and
**where** they cluster tells you far more than the headline accuracy.

In ours, the diagonal is bright and two dark blocks stand out: **M/N** and
**R/U**. Both are pairs that are nearly identical once a hand is reduced to 21
points. See [Model results](#10-model-results).

---

## 9. Dataset documentation

### The constraint, stated plainly

**Every model in this project is trained on publicly available data.** No member
of the team recorded gestures to train a model, and no script in this repository
collects training data.

This matters for two reasons:

1. **Reproducibility.** Anyone with a Kaggle account can download the same data
   and retrain the same model.
2. **Honesty of the numbers.** A model trained on our own hands, in our own
   room, then tested on our own hands in that same room, would produce an
   accuracy figure that means nothing. Training on public data and testing on
   our own webcam is harder, scores lower, and is the honest measurement.

Two scripts use the webcam. **Neither writes training data:**

| Script | Purpose |
|---|---|
| [`test_realtime.py`](ml/scripts/test_realtime.py) | Runs the **already-trained** model live, to see it work |
| [`record_eval_clip.py`](ml/scripts/record_eval_clip.py) | Records a clip to **evaluate** the trained model |

### Dataset used

**ASL Alphabet** — Kaggle `grassknoted/asl-alphabet`
<https://www.kaggle.com/datasets/grassknoted/asl-alphabet>

- ~87,000 images, 200×200 px, 29 class folders (A–Z, `space`, `del`, `nothing`)
- ~1.1 GB
- Licence: GPL-2 per the dataset's Kaggle page; research/education use
- Citation: Akash. *ASL Alphabet*. Kaggle, 2018.

### Datasets considered and rejected

| Dataset | Why not |
|---|---|
| **WLASL processed** (`risangbaskoro/wlasl-processed`) | Not rejected — **selected for Model B and not yet downloaded.** It is several gigabytes, and the build brief requires asking before a download that size. The full pipeline that consumes it is written and tested; see [ml/README.md](ml/README.md). It is also the only dataset here carrying `signer_id`, which is what makes a signer-disjoint evaluation possible. |
| **Google Isolated Sign Language Recognition** (`asl-signs`) | Already in MediaPipe landmark format, which is ideal — but the full download is ~55 GB. Practical only with per-file downloads of a chosen subset. |
| **Sign Language MNIST** | 28×28 greyscale images. Too low-resolution for MediaPipe to find a hand at all. |

### Statistics

| | |
|---|---|
| Images processed | 87,000 |
| Landmarks successfully extracted | 66,858 |
| **Discarded (no hand found)** | **20,142 (23.2%)** |
| Classes trained | 28 (`nothing` excluded, see below) |
| Balanced to | 1,529 samples per class |
| Train / val / test | 29,960 / 6,412 / 6,440 (before augmentation) |
| Train after augmentation | 119,840 |

### The `nothing` class: a finding, not an omission

The dataset's `nothing` class discarded at **99.5%**. Those images contain no
hand, so MediaPipe finds no landmarks, so there is nothing to classify. The 14
rows that survived are false detections.

This is not a bug — it is a structural consequence of classifying landmarks
rather than pixels, and it would not have affected a pixel-based CNN at all.

The neutral state still exists; it moved into the pipeline. **When no hand is
detected, the backend emits `nothing` without consulting the model.** That is
more reliable and cheaper than a learned class would have been, and it is why
`nothing` is absent from `labels.json`.

### Data hygiene rules, enforced in code

- **Contiguous splits, not random.** ASL Alphabet images are consecutive video
  frames — `A1.jpg` and `A2.jpg` are near-identical. A random split puts one in
  train and the other in test, grading the model on frames it has effectively
  memorised. We sort by capture order and cut contiguous blocks.
- **Class balancing by even stride.** Classes do not survive extraction equally
  (N loses 49%, F loses 3%). Every class is subsampled to the smallest, taking
  evenly spaced samples across capture order rather than the first N — which
  would keep only the earliest frames and discard later variation.
- **Augmentation on the training split only.** Rotation (±12°), coordinate
  noise (σ=0.015), and horizontal mirroring. Augmenting validation or test data
  would mean grading the model on data we invented.
- **Mirroring is an accessibility feature**, not an accuracy trick: the dataset
  is almost entirely right-handed, and mirroring teaches left-handed signing it
  would otherwise never see.
- **`dataset_manifest.json`** records source, version, class counts, split
  sizes, augmentation settings and extraction date.

---

## 10. Model results

### Headline numbers

| Metric | Value |
|---|---|
| Training accuracy | 99.28% |
| Validation accuracy | 94.04% |
| **Test (held-out) top-1** | **90.53%** |
| **Test top-3** | **96.91%** |
| Macro F1 | 0.9055 |
| Test samples | 6,440 |
| Training time | 62 seconds, CPU |
| Epochs | 18 of 100 (early stopping restored epoch 8) |
| Median inference latency | 6.2 ms |

**Why test sits below validation** (90.5% vs 94.0%): the test block is the last
15% of each class's capture sequence. It is genuinely unseen footage, not frames
interleaved with training data. A random split would report a higher number that
would not survive a follow-up question.

Top-3 at 96.9% matters more than it looks: it bounds what the smoothing layer
can recover. When the right letter is in the top 3, a majority vote across
frames can still land on it.

### Per-class accuracy

![Per-class recall](docs/images/per_class_accuracy.png)

**Strongest:** F (1.00), K (0.99), L (0.99), V (0.99), C (0.98).

**Weakest:**

| Class | Recall | F1 |
|---|---|---|
| N | 0.57 | 0.62 |
| R | 0.57 | 0.69 |
| P | 0.82 | 0.89 |
| M | 0.83 | 0.69 |
| A | 0.84 | 0.88 |

### Failure analysis

| Confusion | Rate | Why |
|---|---|---|
| **N → M** | 37.4% of all N | Both are a closed fist with the thumb tucked between folded fingers. The only difference is *how many* fingers the thumb sits under — and the thumb is the landmark most often occluded by exactly those fingers. |
| **R → U** | 36.5% of all R | Both are two fingers raised. R crosses index over middle; U holds them together. Crossing is nearly invisible in 21 points, because the fingertips end up in almost the same place. |
| M → N | 15.2% | The same ambiguity, in reverse. |
| P → Q | 10.0% | Both point downward; they differ mainly in wrist rotation, which normalisation deliberately discards. |
| A → M | 7.8% | Both closed fists, thumb position differing by millimetres. |

**The same ambiguity appears twice, independently — which is what makes this a
finding rather than an excuse.** At *extraction* time, N and M had the highest
discard rates of any class (49.0% and 34.8%) because MediaPipe struggles to
landmark a fist with a hidden thumb. Then, among the samples that survived, the
same two letters get confused with each other. The problem is visible in the raw
data before the model ever sees it.

P→Q is worth noting separately because it is caused by *our own design*.
Normalisation deliberately throws away scale and position — and along with them,
some rotation information that would have distinguished these two. That is the
cost of the invariance that makes everything else work.

### Training curves

![Training curves](docs/images/training_curves.png)

Validation loss flattens around epoch 7–8 while training loss keeps falling —
the textbook signature of the point where further training only memorises.
Early stopping caught it.

### An honest experiment that partly failed

The first trained model capped extraction at 1,500 images per class. That meant
the weakest class also had the least data: N discarded 37.7% and ended with 935
samples while Y had 1,483.

Extracting all 87,000 images and balancing every class to the smallest gave:

| | Before | After |
|---|---|---|
| Test top-1 | 88.52% | **90.53%** |
| N recall | 0.27 | **0.57** |
| C recall | 0.73 | 0.98 |
| **R recall** | **0.78** | **0.57** |
| **A recall** | **0.98** | **0.84** |

Overall accuracy rose 2 points and N more than doubled — but **R and A got
measurably worse.** Balancing gave every class N's sample count, which meant
less R data in absolute terms than before. We traded R for N and came out
ahead on aggregate.

One caveat stated plainly: the two figures come from **different test splits**
(the second is balanced at 230 per class), so this is not a controlled
comparison. The macro average is the more comparable figure, and N's movement
is far too large to be a split artefact.

---

## 11. API reference

Full detail with request/response examples: **[docs/api.md](docs/api.md)**.
Interactive documentation: <http://localhost:8000/docs>.

| Method | Path | Auth | Purpose |
|---|---|:--:|---|
| `GET` | `/health` | — | Liveness, database, and model status |
| `POST` | `/api/auth/register` | — | Create an account, returns a token |
| `POST` | `/api/auth/login` | — | OAuth2 form login (Swagger's Authorize) |
| `POST` | `/api/auth/login/json` | — | JSON login (the React client) |
| `GET` | `/api/auth/me` | ✅ | Current user |
| `POST` | `/api/meetings` | ✅ | Create; returns a join code |
| `GET` | `/api/meetings/history` | ✅ | Meetings hosted or attended |
| `GET` | `/api/meetings/{code}` | ✅ | Detail with participants |
| `POST` | `/api/meetings/{code}/join` | ✅ | Join; records attendance |
| `POST` | `/api/meetings/{code}/leave` | ✅ | Stamp your attendance row |
| `POST` | `/api/meetings/{code}/end` | ✅ host | End for everyone |
| `POST` | `/api/meetings/{code}/focus-events` | ✅ | Log an Interview Mode event |
| `GET` | `/api/meetings/{code}/focus-events` | ✅ host | Focus summary |
| `POST` | `/api/transcripts` | ✅ | Append a line |
| `GET` | `/api/transcripts/{id}` | ✅ | Full transcript |
| `GET` | `/api/transcripts/{id}/export` | ✅ | Download `.txt` |

**Access levels.** Public (health, auth), authenticated (meeting lookup — you
need to see a title before deciding to join), and **member** (all transcript and
focus endpoints). Being logged in is deliberately not enough to read a
transcript; membership is the boundary, enforced in the API rather than the UI.

### WebSockets

**`WS /ws/predict/{code}?token=<jwt>`** — landmarks in, text out, plus subtitle
and speech relay. **No video frame can cross this socket; there is no code path
that accepts one.**

```json
// client → server
{ "type": "landmarks", "mode": "static", "timestamp": 1234567890,
  "hands": [{"handedness": "Right", "landmarks": [[0.51,0.42,0.0], "… 21 items"]}] }

// server → client
{ "type": "prediction", "label": "A", "confidence": 0.94,
  "stable": true, "sentence": "HELLO", "latency_ms": 6.2 }
```

**`WS /ws/signal/{code}?token=<jwt>`** — relays `offer`, `answer`,
`ice-candidate`, `hangup`. The server never parses SDP; it only stamps the
sender. Exactly one peer is told `should_initiate`.

---

## 12. Database schema

```mermaid
erDiagram
    users ||--o{ meetings : hosts
    users ||--o{ meeting_participants : attends
    users ||--o{ transcripts : speaks
    users ||--o{ focus_events : triggers
    meetings ||--o{ meeting_participants : has
    meetings ||--o{ transcripts : contains
    meetings ||--o{ focus_events : records

    users {
        int id PK
        varchar name
        varchar email UK
        varchar password_hash
        enum role "deaf, hearing"
        datetime created_at
    }
    meetings {
        int id PK
        varchar code UK
        varchar title
        int host_id FK
        bool is_interview_mode
        datetime started_at "null until first join"
        datetime ended_at "null while live"
        datetime created_at
    }
    meeting_participants {
        int id PK
        int meeting_id FK
        int user_id FK
        datetime joined_at
        datetime left_at
    }
    transcripts {
        int id PK
        int meeting_id FK
        int user_id FK
        enum source "sign, speech"
        text content
        float confidence "null for speech"
        datetime created_at
    }
    focus_events {
        int id PK
        int meeting_id FK
        int user_id FK
        enum event_type "blur, hidden, return"
        datetime created_at
    }
```

Notes worth defending:

- `meetings.started_at` is null until the **first participant joins**. A meeting
  created Monday for Friday must not report a Monday start.
- `meetings.ended_at` being null *is* the definition of "active" — no separate
  boolean to fall out of sync.
- `meeting_participants` is a **log, not a set**. Rejoining after a dropped
  connection writes a new row, so disconnections stay visible instead of being
  quietly erased.
- `transcripts.confidence` is null for speech. The Web Speech API reports its
  own confidence, but it is not comparable to a softmax probability, so
  averaging them would be meaningless.
- Indexes on `meetings.code`, `transcripts(meeting_id, created_at)` and
  `meeting_participants(meeting_id, user_id)` — the pairs that are actually
  queried together.

Schema: [`database/schema.sql`](database/schema.sql). A parity test
([`test_schema_parity.py`](backend/tests/test_schema_parity.py)) fails if it
ever drifts from the ORM models.

---

## 13. Setup guide

### Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Python | **3.11** (3.12 works; **not 3.13** — no TensorFlow wheels) | `python3.11 --version` |
| Node.js | **20 LTS or newer** | `node --version` |
| MySQL | **8.x or newer** | `mysql --version` |
| Git | any recent | `git --version` |

```bash
# macOS
brew install python@3.11
# Ubuntu / Debian
sudo apt install python3.11 python3.11-venv
# Windows — python.org installer, tick "Add python.exe to PATH"
```

### Step 1 — Clone and run setup

```bash
git clone <your-repo-url> BridgeTalk
cd BridgeTalk

./scripts/setup.sh          # macOS / Linux
scripts\setup.bat           # Windows
```

This creates `.venv`, installs every pinned Python and npm dependency
(TensorFlow is large — allow several minutes), downloads MediaPipe's
`hand_landmarker.task`, copies the WASM runtime into `frontend/public/models/`,
and creates `.env` from the template. It is safe to re-run.

### Step 2 — Create the database

Start MySQL, then:

```bash
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed.sql     # two demo accounts
```

`schema.sql` creates the `bridgetalk` database and a least-privilege
`bridgetalk@localhost` user. **Edit the `CHANGE_ME` password in that file
first**, and use the same value in `.env`. The application never connects as
root: if the API were compromised, the blast radius is one database rather than
your whole MySQL server.

Seeded accounts (both password `bridgetalk123`):
`deaf.demo@example.com` and `hearing.demo@example.com`.

### Step 3 — Configure `.env`

```bash
DATABASE_URL=mysql+pymysql://bridgetalk:YOUR_PASSWORD@localhost:3306/bridgetalk
JWT_SECRET_KEY=<paste the output of the command below>
```

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

> **Zero-setup alternative:** replace the `DATABASE_URL` line with
> `DATABASE_URL=sqlite:///./bridgetalk.db`. That is the only change needed.

### Step 4 — Get the dataset

Download **ASL Alphabet** from
<https://www.kaggle.com/datasets/grassknoted/asl-alphabet> (~1.1 GB, free
account) and unzip it into `ml/data/raw/asl_alphabet/`.

Extra nesting is fine — the scripts find the class folders wherever they are.
Verify:

```bash
source .venv/bin/activate
python ml/scripts/download_datasets.py --verify
```

You want a per-class table and `PASS`. If you have a Kaggle API token at
`~/.kaggle/kaggle.json` (chmod 600), `--download` fetches it for you instead.

### Step 5 — Extract landmarks and train

```bash
python ml/scripts/extract_landmarks_images.py --limit-per-class 3000   # ~13 min
python ml/scripts/preprocess.py                                        # ~15 s
python ml/scripts/train_static.py                                      # ~60 s
python ml/scripts/evaluate.py                                          # ~10 s
```

Use `--limit-per-class 500` for a faster, less accurate run while testing the
pipeline.

### Step 6 — Check the model before touching the web app

```bash
python ml/scripts/test_realtime.py
```

An OpenCV window opens with your webcam. **Do not skip this.** If letters appear
here, the model works, and every later problem is plumbing — which is how you
avoid spending an evening debugging a WebSocket that was fine all along.

---

## 14. How to run

```bash
# terminal 1 — backend on :8000, docs at /docs
./scripts/run_backend.sh          # Windows: scripts\run_backend.bat

# terminal 2 — frontend on :5173
./scripts/run_frontend.sh         # Windows: scripts\run_frontend.bat
```

Open <http://localhost:5173>, log in, create a meeting, and share the code.

### Two participants on one machine

Open <http://localhost:5173> in a normal window and again in a **private/
incognito** window. They need separate windows because the JWT lives in
`localStorage`, which is shared between tabs of the same profile — two ordinary
tabs would be the same user.

Log in as `deaf.demo@example.com` in one and `hearing.demo@example.com` in the
other, create a meeting in the first, join by code in the second.

### Testing with two devices

**Two windows on one laptop is not enough for everything.** Interview mode and
speech recognition both need two real devices:

- **Interview mode** detects the window losing focus. Clicking the *other*
  window on the same laptop is a genuine focus change, so every interaction
  records a violation and the blocking overlay fights you.
- **Speech recognition** runs on the microphone. Two windows share one
  microphone, so both recognisers hear the same voice and caption it twice.

`npm run dev:lan` exists for this. It turns on three things at once:

| | Why |
|---|---|
| `host: true` | Listen on every interface, so another device on the Wi-Fi can reach it |
| **HTTPS**, via `@vitejs/plugin-basic-ssl` | Not optional. `getUserMedia` requires a *secure context*, and only `localhost` is exempt — over plain `http://192.168.x.x` the camera prompt never appears at all |
| A **proxy** for `/api`, `/ws` and `/health` | So the second device needs **one** address and trusts **one** certificate. Without it the browser must also accept a second self-signed certificate for the backend, which it will not do silently for a WebSocket — the socket just fails with no usable error |

**Steps:**

```bash
# 1. Backend as usual. It already binds 0.0.0.0.
./scripts/run_backend.sh

# 2. Frontend in LAN mode, with HTTPS and the API proxied through it.
cd frontend && npm run dev:lan
```

Vite prints two addresses. Take the **Network** one, for example:

```
  ➜  Local:   https://localhost:5173/
  ➜  Network: https://192.168.1.42:5173/
```

```bash
# 3. Allow that origin in the repository-root .env, then restart the backend.
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://192.168.1.42:5173
```

4. On the **second device**, open the Network address. The browser will warn
   about the self-signed certificate — choose **Advanced → Proceed**. This is
   expected: the certificate is generated locally and signed by nobody.
5. Sign in as a different user on each device, create a meeting on one, join by
   code on the other.

**Notes**

- Both devices must be on the **same Wi-Fi**, and some guest networks block
  device-to-device traffic entirely — WebRTC will not connect there, and no
  amount of configuration fixes it without a TURN server.
- The certificate must be accepted **once per device**.
- `BRIDGETALK_BACKEND` overrides the proxy target if the API is not on
  `127.0.0.1:8000`.
- **None of this touches the production build.** `vite build` is unaffected, and
  `npm run dev` still serves plain HTTP on localhost only.

### Two participants on one laptop — still fine for captions

For sign-to-text and the caption pipeline, two windows on one machine is the
quickest path and is what the acceptance checks assume. Use it for anything
except interview mode and speech.

---

## 15. Project structure

```
BridgeTalk/
├── backend/
│   ├── app/
│   │   ├── api/            REST routers — thin: validate, delegate, serialise
│   │   │   ├── auth.py         register / login / me
│   │   │   ├── meetings.py     CRUD, join/leave/end, focus events
│   │   │   └── transcripts.py  append / read / export
│   │   ├── ws/
│   │   │   ├── inference.py         landmarks in, text out, subtitle relay
│   │   │   ├── signaling.py         WebRTC offer/answer/ICE relay
│   │   │   └── connection_manager.py  who is in which meeting
│   │   ├── ml/
│   │   │   ├── normalization.py  THE canonical implementation
│   │   │   ├── predictor.py      loads .keras once, version-guarded
│   │   │   └── smoothing.py      gate → vote → debounce → reset
│   │   ├── models/         SQLAlchemy ORM — the only place that knows SQL
│   │   ├── schemas/        Pydantic — the only place defining the wire format
│   │   ├── core/           security.py (JWT, bcrypt), deps.py (get_current_user)
│   │   ├── config.py       pydantic-settings; the only reader of .env
│   │   ├── database.py     engine + session factory
│   │   └── main.py         app, CORS, routers, model load at startup
│   ├── tests/              276 tests
│   └── requirements.txt    every version pinned
│
├── ml/
│   ├── data/raw/           downloaded datasets           (gitignored)
│   ├── data/processed/     extracted landmarks           (gitignored)
│   ├── scripts/
│   │   ├── download_datasets.py       verify what is on disk
│   │   ├── extract_landmarks_images.py MediaPipe over the dataset
│   │   ├── preprocess.py              balance, split, augment
│   │   ├── train_static.py            Model A
│   │   ├── evaluate.py                report + confusion matrix
│   │   └── test_realtime.py           live webcam check (writes nothing)
│   └── models/             .keras (gitignored) + JSON side-cars (committed)
│
├── frontend/
│   ├── .eslintrc.cjs       no-use-before-define as an ERROR — see section 17
│   ├── vitest.config.js    jsdom render tests
│   ├── tailwind.config.js  the two palettes, with contrast ratios recorded
│   ├── src/
│   │   ├── pages/          Login, Home, Lobby, MeetingRoom, MeetingEnded,
│   │   │                   History, Transcript, SignDetection
│   │   ├── components/
│   │   │   ├── ui/         the design system: Icon, Avatar, IconButton,
│   │   │   │               Dialog, Menu, TextField, Select, ToastHost,
│   │   │   │               States, TopBar, Logo
│   │   │   ├── meeting/    Stage, MeetingTile, CaptionRail, ControlBar,
│   │   │   │               SidePanel, DetailsPanel, PeoplePanel,
│   │   │   │               LiveTranscriptPanel, SettingsDialog
│   │   │   └── …           HandOverlayCanvas, DebugOverlay, ErrorBoundary,
│   │   │                   InterviewModeDialog / Overlay
│   │   ├── hooks/          useHandLandmarker, useSignSocket, useWebRTC,
│   │   │                   useSignCaptions, useSpeechCaptions,
│   │   │                   useCaptionStore, useScreenShare, useInterviewMode,
│   │   │                   useMediaDevices, useMicLevel,
│   │   │                   useMeetingPreferences, useClock
│   │   ├── services/
│   │   │   ├── api.js      the only module that calls fetch
│   │   │   ├── stt/        Web Speech and Whisper behind one interface
│   │   │   └── devicePreferences.js  sessionStorage, never the URL
│   │   ├── config/         recognition.js — every threshold, in one file
│   │   ├── context/        AuthContext
│   │   ├── test/           setup.js (browser API stubs), pages.test.jsx
│   │   └── utils/          landmarkUtils.js — MUST match normalization.py
│   │                       formatters.js — dates, durations, meeting codes
│   └── public/models/      MediaPipe assets              (gitignored)
│
├── database/               schema.sql, seed.sql
├── docs/                   api.md, images/
└── scripts/                setup + run, .sh and .bat
```

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `setup.sh: Python 3.11 not found` | Wrong Python on PATH | `brew install python@3.11`, re-run setup |
| `Node <version> is too old` | Node 18 or earlier | Install Node 20 LTS+ |
| Backend exits: `Database connection FAILED` | MySQL down, or wrong `DATABASE_URL` | Start MySQL; check credentials; or switch to the SQLite line |
| `Access denied for user 'bridgetalk'` | Password in `.env` ≠ password in `schema.sql` | Make them match, or `ALTER USER 'bridgetalk'@'localhost' IDENTIFIED BY '…'` |
| Frontend: **Offline** / CORS error in console | Backend not running, or origin not allowed | Start backend; add the origin to `CORS_ORIGINS` in `.env`; restart |
| Camera never starts, no permission prompt | Not a secure context | Use `http://localhost:5173`, not an IP address. See [How to run](#14-how-to-run) |
| `NotReadableError` on the camera | Another app holds it | Close Zoom, Teams, Photo Booth |
| MediaPipe WASM 404 | Assets missing from `public/models/` | Re-run `./scripts/setup.sh`, or download `hand_landmarker.task` manually |
| Panel says **MODEL_NOT_LOADED** | No trained model | Run `preprocess.py` then `train_static.py` |
| Startup error: normalization version mismatch | Model trained with different maths | Retrain, or check out the matching commit. **This guard is working as intended** |
| Good training accuracy, poor live accuracy | Domain gap, or a normalisation mismatch | Run `pytest backend/tests/test_normalization_parity.py`. If it passes, it is the domain gap — see [Limitations](#18-limitations-and-known-issues) |
| Kaggle 403 on download | Dataset terms not accepted | Open the dataset page, sign in, accept |
| WebSocket keeps reconnecting | Backend restarting, or bad token | Check the backend log; log out and back in |
| Call stuck at `connecting` | No TURN server, restrictive NAT | Two windows on one machine, or two devices on one Wi-Fi |
| Speech captions button disabled | Firefox/Safari | Web Speech API needs Chrome or Edge |
| Letters repeat (`AAAA`) | Debounce misconfigured | Check `COOLDOWN_MS` in `.env`; default 1500 |
| Nothing recognised despite a visible skeleton | Confidence below threshold | Better lighting; or lower `CONFIDENCE_THRESHOLD` and accept more errors |

---

## 17. Testing

There are two suites, and they answer different questions.

```bash
# backend — the protocol, the database, the maths
source .venv/bin/activate && pytest backend/tests -q

# frontend — does every page actually render, and does it lint
cd frontend && npm run lint && npm test
```

```
pytest backend/tests -q      276 passed, 2 skipped   (~50s)
npm run lint                 0 errors, 6 warnings
npm test                     71 passed               (~3s)
npx vite build               built in ~2.6s
```

### Backend — 258 tests

They run against throwaway in-memory SQLite, so no MySQL is needed and no real
data can be touched.

| File | Covers |
|---|---|
| `test_auth.py` | Registration, login, duplicate emails, expired/forged/deleted-user tokens, password hashing, the identical-error rule for unknown email vs wrong password |
| `test_meetings.py` | Meeting CRUD, join/leave/end, attendance logging, membership boundaries, history payload shape, history search, and a query-count guard |
| `test_captions.py` | The one caption protocol: interim replaces, final persists, one row per `segment_id`, and that no row carries accumulated history |
| `test_transcripts.py` | Transcript CRUD, TXT and PDF export, member-only access |
| `test_smoothing.py` | The full smoothing algorithm against a synthetic prediction stream with injected time — no webcam or model needed |
| `test_normalization_parity.py` | Python vs JavaScript agreement to 1e-6, plus the invariants (wrist at origin, furthest landmark at 1.0, translation and scale invariance) |
| `test_websockets.py` | Socket auth, message validation, the should-initiate rule, verbatim relay |
| `test_focus_events.py` | Interview Mode logging, host-only reads, opt-in enforcement |
| `test_schema_parity.py` | `schema.sql` and the ORM models describing the same tables, columns and enum values |
| `test_transcribe.py` | Fragmented WebM audio decoding through the real `StreamDecoder` path |

Several of these were **verified to fail when their fix is removed**, because a
test that cannot detect the bug it guards is worse than no test:

* `test_normalization_parity.py` — inject a 0.001% divergence
* the stale-vote regression test in `test_smoothing.py`
* `test_history_does_not_issue_a_query_per_meeting` — remove the `selectinload`
* `test_history_search_returns_each_meeting_once` — change the subquery to a JOIN

### Frontend — lint and render tests

Both of these exist because of a specific failure. The meeting room shipped with
**eleven** use-before-define errors: `const` bindings read above the line that
initialises them, which throws `Cannot access 'X' before initialization` and
takes the whole screen to the error boundary. A hook dependency array is the
trap — the callback body is deferred and looks fine, but `[a, b]` is evaluated
during render.

`vite build` cannot catch it. It transforms modules and performs no scope
analysis, so the bundle built cleanly while the page was broken. And
`npm run lint` had never worked: `package.json` carried the script and four
pinned ESLint packages since Phase 0 with **no configuration file**, so it
exited with "couldn't find a configuration file".

So:

* **`frontend/.eslintrc.cjs`** now exists, with `no-use-before-define` as an
  error, plus `react-hooks/rules-of-hooks`.
* **`frontend/src/test/`** mounts all eight routes against jsdom with the
  browser APIs this app needs stubbed — `getUserMedia`, `MediaStream`,
  `RTCPeerConnection`, `WebSocket`, `AudioContext`, `srcObject` — and fails if
  anything throws. `setup.js` additionally fails a test when React logs a render
  error, so a crash swallowed by an error boundary cannot pass silently.

These tests deliberately do **not** test behaviour that needs a camera or a
voice. They answer the narrower question no human should have to re-check after
every edit: *does each page render at all?* The behaviour that matters — a
caption crossing from one browser to the other — is in the manual checklist
below.

They have already paid for themselves twice: they found the unguarded
`canvas.getContext('2d')` in `HandOverlayCanvas` (null in a real browser when
the GPU context is lost, and the throw destroyed the entire meeting to fail at
drawing a decorative overlay), and they caught that the lobby's device picker
had no effect because `MeetingRoom` was still reading query parameters after the
lobby moved to `sessionStorage`.

### Profile comparison (Bug 5)

```bash
cd frontend && npm run compare:profiles           # warm vs cold profile
cd frontend && npm run compare:profiles:offline   # and with the font CDN blocked
```

`scripts/compare-profiles.mjs` drives Chromium through Playwright, captures
every page from a warm profile and from a brand-new context (which is what an
incognito window is), and reports a pixel diff **and** a layout fingerprint —
element boxes, every icon box, whether each webfont loaded, and whether the
document overflows. The layout fingerprint is the gate: "text and icons are
misaligned" is a layout statement, and a pixel diff on a page with a live camera
feed is meaningless because the frame changes between shots.

Current result, with the CDN blocked: **0 of 15 layouts differ**, across five
pages at 1024/1280/1920 px plus a zoom sweep at 80/100/125%.

### Fonts are self-hosted

Roboto and Material Symbols Outlined come from the `@fontsource/roboto` and
`material-symbols` npm packages and are served from our own origin. They used to
load from Google's CDN, and that was Bug 5: measured, the icon font was still
loading **2.5 seconds** after page load on a good connection, and never arrived
on a restricted one. **The application now runs entirely offline after setup.**

### Manual end-to-end checklist

Needs **two browser profiles** — not two tabs. Each needs its own camera
permission and its own login. Add `?debug=1` to the meeting URL for the
diagnostic overlay.

1. `./scripts/run_backend.sh` — `/health` reports every model's `loaded` state
2. `./scripts/run_frontend.sh` — sign in as the seeded deaf demo user
3. Create a meeting from Home; note the code
4. Second profile — sign in as the hearing demo user, join by code
5. Both tiles show; the People panel reports audio and video arriving
6. Deaf user signs — the word appears on **both** screens, **once**
7. Hearing user speaks — grey interim text appears on **both** screens within
   about a second and turns white on pause
8. Rest hands in frame for 30 seconds — **zero** captions
9. Open the Transcript panel — exactly one entry per utterance, no entry
   containing an earlier one's text
10. Present a window — the screen fills the stage and **both camera tiles stay
    visible**; stop from the browser's own bar and check the layout returns
11. Leave; the meeting-ended page offers the transcript; History lists it
12. `SELECT segment_id, source, content FROM transcripts;` — one row per segment

`PROGRESS.md` has the full Part D script, with the expected result for each step
and what to report back if one fails.

---

## 18. Limitations and known issues

**Stated plainly, because a limitation you have measured is worth more in a
review than one a reviewer finds for you.**

1. **The domain gap.** The model scores 90.5% on held-out dataset images. On
   *your* webcam, in *your* room, it will do worse. It was trained on one
   dataset's cameras, lighting, framing and hands, and yours are different. This
   is the single most important caveat, it is well documented in the
   literature, and `test_realtime.py` exists to measure it honestly.

2. **M/N and R/U are genuinely hard.** N recall is 0.57. These pairs differ by
   millimetres of thumb or finger position, and the distinguishing part is
   usually occluded. The evidence appears twice independently — in extraction
   discard rates *and* in the confusion matrix — so it is a property of the
   representation, not a training failure.

3. **Fingerspelling is not sign language.** Deaf people do not spell out whole
   conversations letter by letter; fingerspelling is for names and technical
   terms. This MVP recognises the alphabet, which is a genuine building block
   and not the whole problem.

4. **No TURN server.** Two peers behind symmetric NAT or a corporate firewall
   cannot establish a direct connection and the call will fail. Adding TURN
   (e.g. coturn) is the fix; it needs a server with bandwidth.

5. **Camera needs a secure context.** Two laptops over plain HTTP will not get
   camera access. Browser policy, not our bug — workarounds in
   [How to run](#14-how-to-run).

6. **Speech recognition is not local.** In Chrome, audio goes to Google. This
   sits oddly beside our privacy claim for the sign direction, and we say so
   rather than glossing it. Whisper is the upgrade path.

7. **In-memory connection registry.** Running more than one backend worker would
   put two participants in two separate registries and they would never see each
   other. Fine for 1:1 on one process; Redis is the fix for anything larger.

8. **Interview Mode is a deterrent, not proctoring.** It sees only that this tab
   lost focus. It cannot detect a second monitor, a phone, notes, or another
   person in the room. The UI tells the participant this.

9. **One hand only.** Model A tracks a single hand, which covers fingerspelling
   but not the many two-handed signs.

10. **Right-hand bias.** The dataset is almost entirely right-handed. Mirroring
    augmentation mitigates this but was not separately evaluated on left-handed
    signers, because no public left-handed test set was available.

---

## 19. Future enhancements

Mapped to the SRS:

- **Sentence-level translation.** Move from letter-by-letter to a sequence model
  that outputs phrases, respecting ASL grammar rather than transliterating.
- **Model B — dynamic word signs.** No longer a design sketch: the whole
  pipeline is built and tested, and what remains is downloading WLASL and
  running four commands ([ml/README.md](ml/README.md)). Expect 55–80% on a
  signer-disjoint split and be honest about it — and expect live performance
  below that, because the model is trained on segmented clips and used on an
  unsegmented stream.
- **Continuous sign segmentation.** The single biggest lever on Model B's live
  accuracy, and an open research problem. Today `sequence.py` uses two
  heuristics: a run of hand-free frames ends a sign, and mostly-empty windows
  are not classified. Neither helps a signer who does not pause.
- **Indian Sign Language.** The INCLUDE and ISL-CSLTR datasets. The whole
  pipeline is language-agnostic — only the training data and labels change,
  which is a direct benefit of classifying landmarks rather than pixels.
- **Multilingual captions.** Translate the recognised text before display.
- **Emotion recognition** from facial landmarks, to carry the non-manual markers
  that ASL uses for grammar and which text alone loses.
- **Mobile app.** MediaPipe has native iOS and Android SDKs; the backend needs
  no changes.
- **AI meeting summaries** from the stored transcripts.
- **TURN server** for calls across restrictive networks.
- **Whisper** for local, private speech recognition.

---

## 20. References

**Technology**

- MediaPipe Solutions — <https://ai.google.dev/edge/mediapipe/solutions/guide>
- MediaPipe Hand Landmarker — <https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker>
- TensorFlow / Keras — <https://www.tensorflow.org/guide/keras>
- React — <https://react.dev>
- Vite — <https://vite.dev>
- Tailwind CSS — <https://tailwindcss.com/docs>
- FastAPI — <https://fastapi.tiangolo.com>
- SQLAlchemy 2.0 — <https://docs.sqlalchemy.org/en/20/>
- OpenCV — <https://docs.opencv.org>
- WebRTC — <https://webrtc.org/getting-started/overview>
- MDN, Web Speech API — <https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API>
- OpenAI Whisper — <https://github.com/openai/whisper>

**Datasets**

- ASL Alphabet — <https://www.kaggle.com/datasets/grassknoted/asl-alphabet>
- WLASL processed — <https://www.kaggle.com/datasets/risangbaskoro/wlasl-processed>
- Google Isolated Sign Language Recognition — <https://www.kaggle.com/competitions/asl-signs>
- INCLUDE (Indian Sign Language) — <https://zenodo.org/record/4010759>

**Papers**

- Zhang, F. et al. *MediaPipe Hands: On-device Real-time Hand Tracking.* CVPR
  Workshop on Computer Vision for AR/VR, 2020. <https://arxiv.org/abs/2006.10214>
- Li, D., Rodriguez, C., Yu, X., Li, H. *Word-level Deep Sign Language
  Recognition from Video: A New Large-scale Dataset and Methods Comparison.*
  WACV 2020. <https://arxiv.org/abs/1910.11006>
- Sridhar, A. et al. *INCLUDE: A Large Scale Dataset for Indian Sign Language
  Recognition.* ACM Multimedia, 2020.

---

## Models and measured accuracy

Every number here was measured on a held-out split and can be reproduced with
the commands shown. Nothing is quoted from a training log.

| Model | Input | Classes | Measured | Split |
|---|---|---|---|---|
| **ISL words** (BiLSTM) — the demo model | `(30, 132)` | 40 | **85.23%** top-1, 94.63% top-3 · **17.5% WER** continuous | random (see caveat) |
| **ISL fingerspelling** (MLP) | `(126,)` | 35 | **92.04%** macro recall | pose-disjoint |
| ASL fingerspelling (MLP) — baseline | `(63,)` | 28 | 90.53% top-1, 96.91% top-3 | contiguous by capture order |

```bash
python ml/scripts/evaluate.py --model ml/models/isl_model.keras \
    --labels ml/models/labels_isl.json --prefix isl_ \
    --report isl_evaluation_report.json --image-tag _isl

# And through the path the browser actually uses, not the training arrays:
python ml/scripts/test_inference_path.py
```

Both report the same figures. That agreement is the point: it says the serving
path applies the same normalisation and feature layout as training did.

### Read the ISL fingerspelling number carefully

`evaluate.py` prints **98.14% top-1** for it. That figure is inflated by class
size and should not be quoted. The honest headline is **92.04% macro
recall over the 28 classes that actually have held-out samples**, because:

- **7 classes cannot be judged at all** — `1, 2, 3, 4, 5, 8, L`. The source
  data contains fewer than three distinct poses for each, so nothing could be
  held out. They are in training and absent from the test set.
- **Two classes score zero** — `H, J`. H fails on all 94 of its held-out
  samples and J on all 11. Where a genuinely unseen pose exists, the model
  frequently cannot generalise to it.

### Why the split had to be pose-disjoint

The first training run returned 100% train, 100% validation, loss 0.0000 and
99.75% test. Perfect scores on 35 classes are a leakage signal, so we measured
instead of reporting:

- no *exact* duplicate feature vectors across splits
- but median nearest-neighbour distance from a test row to the training set was
  **0.1018**, while two random different-class rows sit **4.0178** apart — test
  rows are 40× closer to a training row than two distinct signs are to each other
- the nearest training neighbour shared the test row's label **100%** of the time

The cause: clustering at a tight threshold collapses **41,609 images into 1,159
distinct poses (2.8%)**. Several classes have one pose across 1,200 images.
Because the duplicates are scattered through the folder rather than adjacent,
contiguous-by-capture-order splitting cannot separate them — any index-based
split puts copies of the same pose on both sides.

`preprocess.py --split-by-pose` clusters near-duplicate vectors and assigns
whole **clusters** to train/val/test, so nothing in test has a copy in training.

### Datasets, and their licences

| Model | Source | Licence |
|---|---|---|
| ISL words | INCLUDE — Sridhar et al., ACM MM 2020 | research use |
| ISL fingerspelling | `Hemg/Indian_sign_language_dataset` (Hugging Face) | **none declared** |
| ASL fingerspelling | `grassknoted/asl-alphabet` (Kaggle) | GPL-2 per its dataset page |

All training data is from public datasets. No gestures were recorded for
training — `test_realtime.py` and `record_eval_clip.py` use the webcam only to
*evaluate* an already-trained model.

The ISL fingerspelling dataset **declares no licence**. It is publicly
downloadable, which is why it was used, but that is not the same as permissive
terms and should not be presented as such.

### Two limits that apply to every number above

**No signer-independent measurement.** INCLUDE records no signer identity, so
the word model's test split holds out *clips*, not *people*. Our code writes
`signer_disjoint: false` everywhere so nothing overstates it. A new signer will
score below these figures; that gap is the domain gap and is unmeasured.

**Continuous signing is harder than isolated clips.** 85.23% is per-clip.
Signing a sentence without pausing gives **17.5% word error rate** — roughly
one word in six wrong. Measured with `ml/scripts/evaluate_continuous.py`.

---

## Interview mode: exactly what it can and cannot do

A web page **cannot** prevent tab switching. There is no API for it, by design.
What is implemented is the strongest layered version browsers permit, and the
in-app dialog claims exactly this and no more.

| Layer | Chrome / Edge | Firefox / Safari |
|---|---|---|
| Fullscreen on acknowledgement | ✅ | ✅ |
| Keyboard Lock (Esc, Tab, Ctrl+T/N/W/L/R) | ✅ | ❌ not supported |
| Detection (`visibilitychange`, `blur`, `fullscreenchange`) | ✅ | ✅ |
| Blocking overlay until return + re-fullscreen | ✅ | ✅ |
| Logged to MySQL with duration | ✅ | ✅ |
| Host alerted live, per participant | ✅ | ✅ |

**It cannot** capture Alt+Tab or Cmd+Tab — those belong to the operating
system. It cannot see a second monitor, a phone, paper notes, or another person
in the room. It records when *this tab* loses focus. It is a deterrent, and the
host is shown which participants have reduced enforcement.

Absences under 900 ms are not reported: that is a notification stealing focus,
not someone looking an answer up, and reporting them would bury real incidents.
At 3 violations the host is **prompted**, not forced — ejecting someone from an
interview is a judgement call.

---

## HTTPS is required in production

`getUserMedia`, the Web Speech API and Keyboard Lock all need a **secure
context**. `http://localhost` counts, so local development and a one-machine
demo work over plain HTTP.

**They will not work from another device over `http://192.168.x.x`** — the
camera simply never starts. A real deployment needs TLS in front of the
frontend and `wss://` for the three WebSockets. The `docker-compose.yml` here
does not provide TLS and is not intended to.

---

## Known limitations, stated plainly

| Limitation | What it would take to remove |
|---|---|
| 17.5% WER on continuous signing | Continuous sign segmentation is an open research problem; more clips per sign and a model trained on unsegmented streams |
| No signer-independent accuracy | A dataset that records signer identity, so whole people can be held out |
| 7 ISL letters cannot be evaluated | A fingerspelling dataset with more than 2 distinct poses per letter |
| H and J at 0% recall | Same — those letters have too few distinct poses to generalise from |
| 40-word vocabulary, not a language | ISL has its own grammar and word order; this is isolated-sign recognition, not translation |
| Docker stack unverified | Docker was not installed on the development machine; `docker compose up --build` has never been run |
| Web Speech sends audio to Google | Use the Whisper engine, which runs on our own backend |
| Tailwind build-chain advisories | A breaking Tailwind 4 migration. `npm audit --omit=dev` reports zero — they are dev-only with no exposure in the shipped bundle |
