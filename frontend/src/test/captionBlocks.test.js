import { describe, expect, it } from 'vitest';

import { CAPTIONS } from '../config/recognition';
import { buildCaptionBlocks } from '../utils/captionBlocks';

/**
 * Bug 1: captions were rendered one line per final segment, so a short pause
 * while speaking or signing started a new line and the rail read as a list.
 *
 * These tests pin the grouping rules directly, because "does a 2-second pause
 * append or start a new block?" should not require signing at a camera.
 *
 * `now` and the timestamps are injected, so nothing here depends on
 * wall-clock time.
 */

const T0 = Date.parse('2026-10-12T10:00:00.000Z');

/** One store entry. `at` is milliseconds after T0. */
function seg({ id, speaker = 1, name = 'Swarna', source = 'speech', text, isFinal = true, at = 0 }) {
  return {
    segmentId: id,
    speakerId: speaker,
    speakerName: name,
    source,
    text,
    isFinal,
    confidence: null,
    timestamp: new Date(T0 + at).toISOString(),
  };
}

describe('buildCaptionBlocks — continuous paragraphs', () => {
  it('merges consecutive segments from one speaker into a single block', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: 'good morning', at: 0 }),
        seg({ id: 's2', text: 'shall we start', at: 1500 }),
        seg({ id: 's3', text: 'I have the slides', at: 3000 }),
      ],
      { now: T0 + 3200 },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].speakerName).toBe('Swarna');
    expect(blocks[0].settledText).toBe('good morning shall we start I have the slides');
    expect(blocks[0].interimText).toBe('');
  });

  it('a pause SHORTER than the continue window appends — it must not start a new line', () => {
    const pause = CAPTIONS.BLOCK_CONTINUE_WINDOW_MS - 1000;
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: 'first part', at: 0 }),
        seg({ id: 's2', text: 'second part', at: pause }),
      ],
      { now: T0 + pause + 100 },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('first part second part');
  });

  it('the same speaker resuming AFTER the window starts a fresh block', () => {
    const gap = CAPTIONS.BLOCK_CONTINUE_WINDOW_MS + 1000;
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: 'before the gap', at: 0 }),
        seg({ id: 's2', text: 'after the gap', at: gap }),
      ],
      // A generous ttl, so this test exercises the GROUPING rule alone. With
      // the real ttl the first block would also have expired, which is correct
      // behaviour but would conflate two separate rules in one assertion.
      { now: T0 + gap + 100, ttlMs: 60_000 },
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].settledText).toBe('before the gap');
    expect(blocks[1].settledText).toBe('after the gap');
  });

  it('a different speaker always starts a new block', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', speaker: 1, name: 'Swarna', text: 'hello', at: 0 }),
        seg({ id: 's2', speaker: 2, name: 'Thamizh', text: 'hello back', at: 500 }),
      ],
      { now: T0 + 600 },
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].speakerName).toBe('Swarna');
    expect(blocks[1].speakerName).toBe('Thamizh');
  });

  it('interleaved speakers produce one block each, in order', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 'a1', speaker: 1, name: 'A', text: 'one', at: 0 }),
        seg({ id: 'b1', speaker: 2, name: 'B', text: 'two', at: 400 }),
        seg({ id: 'a2', speaker: 1, name: 'A', text: 'three', at: 800 }),
      ],
      { now: T0 + 900, maxBlocks: 5 },
    );

    expect(blocks.map((b) => b.speakerName)).toEqual(['A', 'B', 'A']);
    expect(blocks[2].settledText).toBe('three');
  });
});

describe('buildCaptionBlocks — interim text', () => {
  it('an open trailing segment is interim, and the rest is settled', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: 'good morning', at: 0 }),
        seg({ id: 's2', text: 'how are', isFinal: false, at: 800 }),
      ],
      { now: T0 + 900 },
    );

    expect(blocks[0].settledText).toBe('good morning');
    expect(blocks[0].interimText).toBe('how are');
  });

  it('an interim is REPLACED in place as it grows, not appended', () => {
    const grow = (text) => buildCaptionBlocks(
      [seg({ id: 's1', text, isFinal: false, at: 0 })],
      { now: T0 + 100 },
    )[0];

    expect(grow('how').interimText).toBe('how');
    expect(grow('how are').interimText).toBe('how are');
    expect(grow('how are you').interimText).toBe('how are you');
    // Settled stays empty throughout: nothing has been finalised yet.
    expect(grow('how are you').settledText).toBe('');
  });

  it('when the interim becomes final it moves into the settled text', () => {
    const open = buildCaptionBlocks(
      [seg({ id: 's1', text: 'how are you', isFinal: false, at: 0 })],
      { now: T0 + 100 },
    )[0];
    expect(open.settledText).toBe('');
    expect(open.interimText).toBe('how are you');

    const closed = buildCaptionBlocks(
      [seg({ id: 's1', text: 'how are you', isFinal: true, at: 0 })],
      { now: T0 + 100 },
    )[0];
    expect(closed.settledText).toBe('how are you');
    expect(closed.interimText).toBe('');
  });
});

describe('buildCaptionBlocks — expiry and limits', () => {
  it('a block is marked fading once past its time to live', () => {
    const fresh = buildCaptionBlocks([seg({ id: 's1', text: 'hi', at: 0 })], { now: T0 + 1000 })[0];
    expect(fresh.fadingOut).toBe(false);

    const old = buildCaptionBlocks(
      [seg({ id: 's1', text: 'hi', at: 0 })],
      { now: T0 + CAPTIONS.BLOCK_TTL_MS + 100 },
    )[0];
    expect(old.fadingOut).toBe(true);
  });

  it('a block is dropped entirely once the fade has finished', () => {
    const blocks = buildCaptionBlocks(
      [seg({ id: 's1', text: 'hi', at: 0 })],
      { now: T0 + CAPTIONS.BLOCK_TTL_MS + CAPTIONS.BLOCK_FADE_MS + 50 },
    );
    expect(blocks).toEqual([]);
  });

  it('shows at most MAX_VISIBLE_BLOCKS, dropping the oldest first', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 'a', speaker: 1, name: 'A', text: 'first', at: 0 }),
        seg({ id: 'b', speaker: 2, name: 'B', text: 'second', at: 200 }),
        seg({ id: 'c', speaker: 3, name: 'C', text: 'third', at: 400 }),
      ],
      { now: T0 + 500 },
    );

    expect(CAPTIONS.MAX_VISIBLE_BLOCKS).toBe(2);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.speakerName)).toEqual(['B', 'C']);
  });
});

describe('buildCaptionBlocks — robustness', () => {
  it('returns an empty array for empty, null or malformed input', () => {
    expect(buildCaptionBlocks([])).toEqual([]);
    expect(buildCaptionBlocks(null)).toEqual([]);
    expect(buildCaptionBlocks(undefined)).toEqual([]);
    expect(buildCaptionBlocks([{ segmentId: 'x' }])).toEqual([]);
  });

  it('ignores segments whose text is empty or whitespace', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: '   ', at: 0 }),
        seg({ id: 's2', text: 'real text', at: 100 }),
      ],
      { now: T0 + 200 },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('real text');
  });

  it('collapses whitespace so two segments never leave a visible gap', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', text: 'hello  ', at: 0 }),
        seg({ id: 's2', text: '  there', at: 100 }),
      ],
      { now: T0 + 200 },
    );
    expect(blocks[0].settledText).toBe('hello there');
  });

  it('survives an unparseable timestamp', () => {
    const blocks = buildCaptionBlocks(
      [{ segmentId: 's1', speakerId: 1, speakerName: 'A', source: 'sign', text: 'hi', isFinal: true, timestamp: 'not a date' }],
      { now: T0 },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('hi');
  });

  it('carries the badge source from the most recent segment in the block', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 's1', source: 'sign', text: 'signed', at: 0 }),
        seg({ id: 's2', source: 'speech', text: 'spoken', at: 200 }),
      ],
      { now: T0 + 300 },
    );
    expect(blocks[0].source).toBe('speech');
  });
});
