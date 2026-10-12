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
