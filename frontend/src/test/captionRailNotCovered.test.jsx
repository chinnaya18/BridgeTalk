import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Stage from '../components/meeting/Stage';
import { fakeStream } from './setup.js';

/**
 * Captions were invisible during an ordinary call, and appeared only while
 * somebody shared their screen.
 *
 * Nothing was wrong with the captions. They were delivered, correct, and in
 * the DOM at the right coordinates — the video was simply painted on top of
 * them. `MeetingTile` had no height of its own, so the `<video>` inside it
 * resolved `height: 100%` against an auto-height parent and fell back to the
 * stream's intrinsic aspect ratio. Measured in a real browser, a 4:3 camera
 * rendered **1480x1110** inside a **640px** stage and the 486px of overflow
 * covered the caption strip underneath.
 *
 * Sharing a screen hid the symptom by accident: the presenting layout puts
 * both cameras in fixed `aspect-video` boxes, which gives them a height, so
 * nothing overflowed and the captions reappeared.
 *
 * THE LIMIT OF THIS TEST
 * ----------------------
 * jsdom has no layout engine — every element is 0x0 — so it cannot catch the
 * overflow itself. What it can pin is the two things whose absence caused it:
 * a tile that sizes itself to its container, and a stage that clips rather
 * than letting a mis-sized child paint over the captions. The overflow and
 * the occlusion are checked against a real browser, by hit-testing the centre
 * of the caption strip.
 */

/** The camera tiles only — the shared screen is not a MeetingTile. */
const cameraTiles = (container) => [...container.querySelectorAll('.group')];

const props = {
  localStream: fakeStream(),
  localName: 'Signer',
  remoteStream: fakeStream(),
  remoteName: 'Listener',
};

describe('the caption strip cannot be covered by the video', () => {
  it('sizes every camera tile to its container, not to the stream', () => {
    const { container } = render(<Stage {...props} />);

    const tiles = cameraTiles(container);
    expect(tiles.length, 'a two-person call shows both cameras').toBeGreaterThan(0);

    for (const tile of tiles) {
      expect(
        tile.className,
        'a tile without a height grows to the video and covers the captions',
      ).toMatch(/\bh-full\b/);
      expect(tile.className).toMatch(/\bw-full\b/);
    }
  });

  it('clips the stage, so a mis-sized tile can never paint over the captions', () => {
    const { container } = render(<Stage {...props} />);

    const stage = container.querySelector('[aria-label="Participants"]');
    expect(stage).toBeTruthy();
    expect(
      stage.className,
      'without this the failure is silent: the captions are present and simply cannot be seen',
    ).toMatch(/\boverflow-hidden\b/);
  });

  it('keeps the tiles sized while somebody is presenting', () => {
    const { container } = render(<Stage {...props} screenStream={fakeStream()} />);

    const tiles = cameraTiles(container);
    expect(tiles.length, 'the cameras stay on screen while presenting').toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.className).toMatch(/\bh-full\b/);
    }
  });
});
