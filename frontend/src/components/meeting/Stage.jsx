import MeetingTile from './MeetingTile';

/**
 * The video area.
 *
 * THREE LAYOUTS, CHOSEN BY HOW MANY PEOPLE ARE HERE
 * ------------------------------------------------
 *   alone      your own tile fills the stage
 *   two        the other person fills the stage, your video is a small
 *              floating tile at the bottom-right
 *   three+     an even grid
 *
 * The two-person case is the one that matters for this product, and "the other
 * person fills the stage" is not a cosmetic choice: when they are signing, the
 * hearing user needs their hands as large as possible. A symmetric
 * side-by-side split would halve the signer for no benefit.
 *
 * PRESENTING OVERRIDES ALL THREE
 * ------------------------------
 * While anyone presents, the shared screen fills the stage and the camera tiles
 * become a vertical strip on the right. The strip is kept — rather than hiding
 * the cameras to give the screen more room — precisely because the signer must
 * stay visible while someone presents. A shared screen with no signer on it is
 * a broken call for a deaf participant.
 *
 * The screen uses `object-contain`, never `object-cover`: cropping a shared
 * screen cuts off whatever is at its edges, which is usually the thing being
 * pointed at.
 */
export default function Stage({
  localStream,
  localName,
  localMuted,
  localCameraOff,
  localSpeaking,
  localSigning,
  localOverlay,
  remoteStream,
  remoteName,
  remoteMuted,
  remoteCameraOff,
  remoteSpeaking,
  remoteSigning,
  screenStream,
  presenterName,
  isPresentingLocally,
  interviewOn,
  children,
}) {
  const hasRemote = Boolean(remoteStream || remoteName);
  const presenting = Boolean(screenStream);

  const localTile = (
    <MeetingTile
      stream={localStream}
      name={localName}
      isLocal
      muted={localMuted}
      cameraOff={localCameraOff}
      speaking={localSpeaking}
      signing={localSigning}
      label={`${localName} (you)`}
    >
      {localOverlay}
    </MeetingTile>
  );

  const remoteTile = hasRemote ? (
    <MeetingTile
      stream={remoteStream}
      name={remoteName ?? 'Participant'}
      muted={remoteMuted}
      cameraOff={remoteCameraOff}
      speaking={remoteSpeaking}
      signing={remoteSigning}
    />
  ) : null;

  return (
    <section
      aria-label="Participants"
      // overflow-hidden is the belt to the tile's braces. A tile that is ever
      // mis-sized again must be clipped to the stage rather than allowed to
      // paint over the caption strip underneath it, because that failure is
      // silent: the captions are present, correct and in the DOM, and simply
      // cannot be seen.
      className="relative min-h-0 flex-1 overflow-hidden p-4"
    >
      {interviewOn ? (
        <span
          role="status"
          className="absolute left-7 top-7 z-20 flex items-center gap-1.5 rounded-full
                     bg-black/60 px-3 py-1 text-xs font-medium text-dark-accent backdrop-blur"
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 14 }}>
            policy
          </span>
          Interview mode
        </span>
      ) : null}

      {presenting ? (
        /* ---------------------- presenting ---------------------- */
        <div className="flex h-full min-h-0 gap-4">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-tile bg-black">
            <ScreenVideo stream={screenStream} />
            <p className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/60 px-2 py-1 text-xs text-dark-text">
              {isPresentingLocally
                ? 'Your screen'
                : `${presenterName ?? 'Someone'} is presenting`}
            </p>
          </div>

          {/* Camera strip. Fixed width so the shared screen gets the rest; it
              drops below `sm` where 200px of a narrow screen is too much. */}
          <div className="hidden w-[200px] shrink-0 flex-col gap-3 overflow-y-auto sm:flex">
            {remoteTile ? <div className="aspect-video shrink-0">{remoteTile}</div> : null}
            <div className="aspect-video shrink-0">{localTile}</div>
          </div>
        </div>
      ) : !hasRemote ? (
        /* ------------------------- alone ------------------------ */
        <div className="h-full min-h-0">
          {localTile}
          <WaitingNote />
        </div>
      ) : (
        /* -------------------- two participants ------------------ */
        <div className="relative h-full min-h-0">
          {remoteTile}
          {/* Floating self-view, bottom-right of the stage. */}
          <div className="absolute bottom-4 right-4 z-10 w-[160px] sm:w-[200px]">
            <div className="aspect-video">{localTile}</div>
          </div>
        </div>
      )}

      {children}
    </section>
  );
}

/**
 * The shared screen.
 *
 * Separate component only so the srcObject effect is not duplicated; a shared
 * screen is never mirrored and never shows an avatar placeholder, so it does
 * not fit MeetingTile.
 */
function ScreenVideo({ stream }) {
  return (
    <video
      autoPlay
      playsInline
      muted
      ref={(element) => {
        if (element && element.srcObject !== (stream ?? null)) {
          element.srcObject = stream ?? null;
        }
      }}
      // contain, not cover: cropping a shared screen hides its edges, which is
      // where menus and the thing being pointed at live.
      className="h-full w-full object-contain"
    />
  );
}

function WaitingNote() {
  return (
    <p className="pointer-events-none absolute bottom-7 left-1/2 -translate-x-1/2 rounded-full
                  bg-black/55 px-4 py-2 text-sm text-dark-muted backdrop-blur">
      Waiting for someone else to join
    </p>
  );
}
