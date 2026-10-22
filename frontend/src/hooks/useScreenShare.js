import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Screen sharing: an ADDITIONAL track, never a replacement.
 *
 * WHY IT MUST BE ADDITIONAL
 * -------------------------
 * The obvious implementation is replaceTrack on the camera sender — it needs
 * no renegotiation and every tutorial shows it. It is wrong for this project:
 * replacing the camera would hide the signer the moment anyone presents, which
 * removes the one thing BridgeTalk exists to carry. So the screen is added
 * alongside, and the connection renegotiates.
 *
 * THREE WAYS A SHARE ENDS, AND ALL THREE MUST WORK
 * ------------------------------------------------
 *   1. The Stop presenting button.
 *   2. The browser's own "Stop sharing" bar — which does NOT call our code, so
 *      the track's `ended` event is the only way to learn about it. Miss this
 *      and the UI claims someone is presenting a screen that is gone.
 *   3. The presenter leaving, handled by the cleanup on unmount.
 *
 * Cancelling the picker is not an error. getDisplayMedia rejects with
 * NotAllowedError whether the user denied permission or simply pressed Escape,
 * and treating the second as a failure would show an error for a deliberate
 * choice.
 */
export function useScreenShare({
  addScreenTrack,
  removeScreenSender,
  sendSignal,
  onPresentingChange,
} = {}) {
  const [isPresenting, setIsPresenting] = useState(false);
  const [error, setError] = useState(null);

  const streamRef = useRef(null);
  const senderRef = useRef(null);
  const onChangeRef = useRef(onPresentingChange);

  useEffect(() => {
    onChangeRef.current = onPresentingChange;
  }, [onPresentingChange]);

  const stop = useCallback(
    (announce = true) => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      if (senderRef.current) {
        removeScreenSender?.(senderRef.current);
        senderRef.current = null;
      }

      if (announce) sendSignal?.({ type: 'presentation-stop', payload: {} });

      setIsPresenting(false);
      onChangeRef.current?.(false);
    },
    [removeScreenSender, sendSignal],
  );

  const start = useCallback(async () => {
    setError(null);

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('This browser cannot share a screen.');
      return false;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        // Screen audio is deliberately not requested. It would be picked up by
        // the speech recogniser and captioned as if the presenter had said it.
        audio: false,
      });
    } catch (cause) {
      // Cancelling the picker rejects with NotAllowedError, exactly as a
      // denial does. There is no way to tell them apart, and showing an error
      // for "changed my mind" is worse than showing nothing.
      if (cause?.name !== 'NotAllowedError') {
        setError(`Could not start sharing: ${cause?.message ?? cause}`);
      }
      return false;
    }

    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    // The browser's own "Stop sharing" bar does not call back into our code.
    // This event is the only notification, and without it the UI would keep
    // claiming a share that has already ended.
    track.addEventListener('ended', () => stop(true));

    streamRef.current = stream;

    // ANNOUNCE FIRST, THEN ADD THE TRACK. The comment here always said
    // "announce before the track arrives", but the code added the track first
    // and announced afterwards.
    //
    // `addTrack` fires `onnegotiationneeded`, which sends an offer; the track
    // itself reaches the far side once that offer is answered. Announcing
    // first means the receiver already knows which stream id is the screen
    // when `ontrack` fires, instead of filing it as the camera and replacing
    // the presenter's face with their own desktop.
    //
    // Both messages go over the same WebSocket, so ordering was usually
    // preserved anyway — but "usually" is doing too much work for something
    // this cheap to make certain.
    sendSignal?.({ type: 'presentation-start', payload: { stream_id: stream.id } });

    senderRef.current = addScreenTrack?.(track, stream) ?? null;

    // addScreenTrack returns null when there is no peer connection — nobody
    // else has joined yet, or the call dropped. The local preview still works,
    // which is exactly how this looks from the presenter's side, so say so
    // rather than letting them believe the far side can see it.
    if (!senderRef.current) {
      setError(
        'Your screen is not reaching the other participant — the call is not connected.',
      );
    }

    setIsPresenting(true);
    onChangeRef.current?.(true);
    return true;
  }, [addScreenTrack, sendSignal, stop]);

  // Leaving the meeting mid-share must release the screen.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  return {
    isPresenting,
    error,
    localScreenStream: streamRef.current,
    startPresenting: start,
    stopPresenting: () => stop(true),
  };
}
