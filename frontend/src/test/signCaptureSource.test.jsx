import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MeetingRoom from '../pages/MeetingRoom';
import { renderPage } from './renderPage';

/**
 * The deaf user's signs were never captured at all.
 *
 * MediaPipe does not read the camera directly — it reads frames from a
 * dedicated <video> element that the meeting room keeps out of the layout with
 * `display: none`. That element carries `autoPlay`, but **Chrome does not
 * autoplay an element it is not rendering**, so it sat at `paused: true` with
 * `currentTime` frozen at 0 for the whole meeting.
 *
 * Nothing errored, which is why this survived every earlier test. `readyState`
 * was 4 and `videoWidth` 640 — everything the guard inside `detect()` checks
 * before handing a frame over. So hand tracking ran at 10 FPS against the SAME
 * first frame for the entire call and truthfully reported no hands, whatever
 * the signer did in front of the camera. The landmark socket stayed busy and
 * the server kept answering `nothing`, so every symptom pointed somewhere else:
 * the hearing user's captions were empty because there was never a sign to
 * caption.
 *
 * The element must therefore be played EXPLICITLY. This test pins that, and
 * only that: a detection source that is not playing cannot see a hand.
 */

/** The hidden detection source, found the way the component marks it. */
const detectionVideo = (container) =>
  [...container.querySelectorAll('video')].find((video) =>
    video.className.includes('hidden'),
  );

describe('the hand-tracking frame source', () => {
  it('is played explicitly, because autoPlay does not fire on a display:none element', async () => {
    const play = HTMLMediaElement.prototype.play;
    const { container } = renderPage(<MeetingRoom />, {
      path: '/meeting/:code',
      entry: '/meeting/K7Q-2M4',
    });

    await act(async () => {
      await Promise.resolve();
    });

    const video = await waitFor(() => {
      const found = detectionVideo(container);
      expect(found, 'the meeting room must keep a hidden detection video').toBeTruthy();
      return found;
    });

    // The stream has to be attached, or there is nothing to decode...
    await waitFor(() => expect(video.srcObject).toBeTruthy());
    // ...and play() has to be called, or it is attached to a paused element
    // and MediaPipe reads one frozen frame for the whole meeting.
    await waitFor(() =>
      expect(
        play.mock.calls.length,
        'the detection video is never played, so hand tracking sees a frozen frame',
      ).toBeGreaterThan(0),
    );
  });

  it('keeps the guard that detect() relies on intact', async () => {
    const { container } = renderPage(<MeetingRoom />, {
      path: '/meeting/:code',
      entry: '/meeting/K7Q-2M4',
    });

    await act(async () => {
      await Promise.resolve();
    });

    const video = await waitFor(() => {
      const found = detectionVideo(container);
      expect(found).toBeTruthy();
      return found;
    });

    // `muted` is what allows play() without a user gesture. Losing it would
    // make the play() above reject with NotAllowedError and silently restore
    // the bug.
    expect(video.muted, 'play() without a gesture needs a muted element').toBe(true);
  });
});
