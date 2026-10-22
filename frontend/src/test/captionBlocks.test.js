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

describe('buildCaptionBlocks — Bug 2: your own captions are not shown to you', () => {
  const ME = 1;
  const THEM = 2;

  it('drops captions produced by the excluded speaker', () => {
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 'mine', speaker: ME, name: 'Me', source: 'sign', text: 'I am signing', at: 0 }),
        seg({ id: 'theirs', speaker: THEM, name: 'Them', source: 'speech', text: 'I am speaking', at: 200 }),
      ],
      { now: T0 + 300, excludeSpeakerId: ME },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].speakerName).toBe('Them');
    expect(blocks[0].settledText).toBe('I am speaking');
  });

  /**
   * The two screens in the reported scenario. One rule produces both.
   */
  it("the hearing user sees only the deaf user's sign captions", () => {
    const stream = [
      seg({ id: 'sign1', speaker: THEM, name: 'Deaf user', source: 'sign', text: 'good morning', at: 0 }),
      seg({ id: 'speech1', speaker: ME, name: 'Hearing user', source: 'speech', text: 'good morning to you', at: 500 }),
    ];
    const blocks = buildCaptionBlocks(stream, { now: T0 + 600, excludeSpeakerId: ME });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('sign');
    expect(blocks[0].settledText).toBe('good morning');
  });

  it("the deaf user sees only the hearing user's speech captions", () => {
    const stream = [
      seg({ id: 'sign1', speaker: ME, name: 'Deaf user', source: 'sign', text: 'good morning', at: 0 }),
      seg({ id: 'speech1', speaker: THEM, name: 'Hearing user', source: 'speech', text: 'good morning to you', at: 500 }),
    ];
    const blocks = buildCaptionBlocks(stream, { now: T0 + 600, excludeSpeakerId: ME });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('speech');
    expect(blocks[0].settledText).toBe('good morning to you');
  });

  it('works when a participant uses the other mode — it filters by SPEAKER, not source', () => {
    // A hearing user who also signs. Their sign captions are still their own,
    // so they are still hidden from them.
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 'a', speaker: ME, source: 'sign', name: 'Me', text: 'my sign', at: 0 }),
        seg({ id: 'b', speaker: ME, source: 'speech', name: 'Me', text: 'my speech', at: 200 }),
        seg({ id: 'c', speaker: THEM, source: 'sign', name: 'Them', text: 'their sign', at: 400 }),
      ],
      { now: T0 + 500, excludeSpeakerId: ME },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].speakerName).toBe('Them');
  });

  it('shows everything when no speaker is excluded', () => {
    const stream = [
      seg({ id: 'a', speaker: ME, name: 'Me', text: 'mine', at: 0 }),
      seg({ id: 'b', speaker: THEM, name: 'Them', text: 'theirs', at: 200 }),
    ];
    expect(buildCaptionBlocks(stream, { now: T0 + 300 })).toHaveLength(2);
    expect(buildCaptionBlocks(stream, { now: T0 + 300, excludeSpeakerId: null })).toHaveLength(2);
  });

  it('removing your own segment does not merge the two speakers around it', () => {
    // A, me, A. With me removed the two A blocks are adjacent in time and
    // must merge into one paragraph — not stay split by a gap that is no
    // longer there.
    const blocks = buildCaptionBlocks(
      [
        seg({ id: 'a1', speaker: THEM, name: 'Them', text: 'first', at: 0 }),
        seg({ id: 'mine', speaker: ME, name: 'Me', text: 'interjection', at: 300 }),
        seg({ id: 'a2', speaker: THEM, name: 'Them', text: 'second', at: 600 }),
      ],
      { now: T0 + 700, excludeSpeakerId: ME },
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('first second');
  });
});

describe('Bug 2 — sign captions must survive long enough to be read', () => {
  const T = Date.parse('2026-10-21T09:25:43.000Z');

  /** A segment carrying an explicit local arrival time. */
  function arrived({ id, source = 'sign', text, at, receivedAt, speaker = 2 }) {
    return {
      segmentId: id, speakerId: speaker, speakerName: 'Deaf user', source, text,
      isFinal: true, confidence: null,
      timestamp: new Date(at).toISOString(),
      receivedAt,
    };
  }

  /**
   * THE CLOCK BUG.
   *
   * Expiry used to be `now - serverTimestamp`. The two clocks belong to
   * different machines. On a second device whose clock runs ahead of the
   * server's, every caption arrives already older than its lifetime and is
   * dropped before it is drawn — while the transcript still fills up, which is
   * exactly how this was reported.
   */
  it('a caption survives a client clock running far ahead of the server', () => {
    const serverStamp = T;            // what the server said
    const clientNow = T + 60_000;     // this device is a minute ahead
    const blocks = buildCaptionBlocks(
      [arrived({ id: 's1', text: 'healthy', at: serverStamp, receivedAt: clientNow })],
      { now: clientNow + 500 },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('healthy');
    expect(blocks[0].fadingOut).toBe(false);
  });

  it('a caption survives a client clock running far behind the server', () => {
    const serverStamp = T;
    const clientNow = T - 60_000;
    const blocks = buildCaptionBlocks(
      [arrived({ id: 's1', text: 'healthy', at: serverStamp, receivedAt: clientNow })],
      { now: clientNow + 500 },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('healthy');
  });

  it('sign blocks live markedly longer than speech blocks', () => {
    expect(CAPTIONS.SIGN_BLOCK_TTL_MS).toBeGreaterThan(CAPTIONS.BLOCK_TTL_MS);

    const justPastSpeechTtl = CAPTIONS.BLOCK_TTL_MS + 1000;

    const sign = buildCaptionBlocks(
      [arrived({ id: 'sg', source: 'sign', text: 'healthy', at: T, receivedAt: T })],
      { now: T + justPastSpeechTtl },
    );
    const speech = buildCaptionBlocks(
      [arrived({ id: 'sp', source: 'speech', text: 'hello', at: T, receivedAt: T })],
      { now: T + justPastSpeechTtl },
    );

    expect(sign, 'a sign block must still be on screen here').toHaveLength(1);
    expect(sign[0].fadingOut).toBe(false);
    // Speech is past its life — fading or already gone, either is correct.
    expect(speech.length === 0 || speech[0].fadingOut).toBe(true);
  });

  it('a sign block does eventually go, so the rail does not accumulate', () => {
    const blocks = buildCaptionBlocks(
      [arrived({ id: 'sg', text: 'healthy', at: T, receivedAt: T })],
      { now: T + CAPTIONS.SIGN_BLOCK_TTL_MS + CAPTIONS.BLOCK_FADE_MS + 100 },
    );
    expect(blocks).toEqual([]);
  });

  it('falls back to the server timestamp when no arrival time is recorded', () => {
    // Defensive: an entry written before this field existed.
    const blocks = buildCaptionBlocks(
      [{ segmentId: 'x', speakerId: 2, speakerName: 'D', source: 'sign',
         text: 'healthy', isFinal: true, timestamp: new Date(T).toISOString() }],
      { now: T + 1000 },
    );
    expect(blocks).toHaveLength(1);
  });

  it("the real session's three signs stay on screen together", () => {
    // healthy / bank / healthy at 09:25:43, :48, :51 — the actual sequence.
    const blocks = buildCaptionBlocks(
      [
        arrived({ id: 'a', text: 'healthy', at: T,          receivedAt: T }),
        arrived({ id: 'b', text: 'bank',    at: T + 5000,   receivedAt: T + 5000 }),
        arrived({ id: 'c', text: 'healthy', at: T + 8000,   receivedAt: T + 8000 }),
      ],
      { now: T + 12000 },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].settledText).toBe('healthy bank healthy');
    expect(blocks[0].fadingOut).toBe(false);
  });
});
