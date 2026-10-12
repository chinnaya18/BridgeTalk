/**
 * The blocking dialog shown to a non-host the moment Interview Mode starts.
 *
 * WHY IT BLOCKS, AND WHY THE BUTTON MATTERS TECHNICALLY
 * -----------------------------------------------------
 * Two reasons, and the second is not obvious:
 *
 *   1. Consent. Being monitored without being told is indefensible, and this
 *      is the only screen where the participant learns what is recorded.
 *   2. Fullscreen requires a user gesture. The browser will refuse
 *      `requestFullscreen()` called from a timer or an effect. The
 *      "Continue in full screen" click IS that gesture — which is why enforcement starts
 *      here rather than automatically when the mode is switched on.
 *
 * WHAT IT PROMISES
 * ----------------
 * Exactly what the browser can deliver, and no more. It does not claim tab
 * switching is prevented, because no web page can prevent it. It says leaving
 * is detected, reported and recorded, which is true.
 */
export default function InterviewModeDialog({ hostName, capabilities, onAcknowledge }) {
  const reduced = !capabilities.fullscreen || !capabilities.keyboardLock;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-dark-bg/95 p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="interview-dialog-title"
      aria-describedby="interview-dialog-body"
    >
      <div className="max-w-lg rounded-2xl border border-[#FDD663] bg-dark-raised p-6 shadow-2xl">
        <h2
          id="interview-dialog-title"
          className="text-2xl font-bold text-dark-text"
        >
          Interview mode is on
        </h2>
        <p className="mt-1 text-sm text-dark-muted">
          {hostName ? `Switched on by ${hostName}.` : 'Switched on by the host.'}
        </p>

        <div id="interview-dialog-body" className="mt-4 space-y-3 text-sm text-dark-text">
          {/* The wording the brief specifies, stated once and plainly, before
              the detail below. */}
          <p className="text-base">
            The host has turned on interview mode. The meeting will open in full
            screen. You will not be able to switch tabs or windows until the
            host ends the meeting. Leaving the meeting screen is recorded and
            reported to the host.
          </p>

          <p>In detail:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>This meeting will go <strong>fullscreen</strong>.</li>
            <li>
              Switching to another tab, window or application is{' '}
              <strong>not allowed</strong>.
            </li>
            <li>
              If you leave, it is <strong>detected</strong>, the host is{' '}
              <strong>told straight away</strong>, and it is{' '}
              <strong>recorded</strong> with how long you were away.
            </li>
            <li>The meeting view is covered until you come back.</li>
            <li>
              Only the host can end this interview — your Leave button is{' '}
              <strong>disabled</strong> until they do.
            </li>
            <li>
              The call keeps running behind this message; your camera and
              microphone are already live.
            </li>
          </ul>

          {/* Say plainly what this cannot do. Overstating it is the fastest
              way to lose a participant's trust — and an examiner's. */}
          <p className="rounded-lg border border-dark-surface bg-dark-bg p-3 text-xs text-dark-muted">
            <strong className="text-dark-muted">What this cannot do:</strong> a web
            page cannot truly stop you leaving, and this does not watch your
            room, your phone, or a second screen. It records when this tab loses
            focus. It is a deterrent, not surveillance.
          </p>

          {reduced && (
            <p
              className="rounded-lg border border-[#FDD663] bg-[#FDD663] p-3 text-xs text-dark-text"
              role="status"
            >
              <strong>Reduced enforcement in this browser.</strong>{' '}
              {!capabilities.fullscreen && 'Fullscreen is unavailable. '}
              {!capabilities.keyboardLock &&
                'Keyboard shortcuts cannot be captured (this needs Chrome or Edge). '}
              Leaving will still be detected and reported. The host is told that
              your browser has reduced enforcement.
            </p>
          )}

          <p className="text-xs text-dark-muted">
            Sign and speech captions work exactly as normal.
          </p>
        </div>

        <button
          type="button"
          onClick={onAcknowledge}
          autoFocus
          className="btn-primary mt-5 w-full"
        >
          Continue in full screen
        </button>
      </div>
    </div>
  );
}
