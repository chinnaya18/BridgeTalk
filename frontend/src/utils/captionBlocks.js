import { CAPTIONS } from '../config/recognition';

/**
 * Groups caption segments into continuous speaker blocks, for display only.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Every final segment used to be rendered on its own line, so a short pause
 * while speaking or signing started a new line. Captions read as a list rather
 * than as live speech.
 *
 * Google Meet shows a speaker's text as ONE continuous paragraph that grows.
 * This produces that: consecutive segments from the same speaker are merged
 * into a single block with one avatar, one name, and one paragraph.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A HOOK
 * ------------------------------------------
 * It is the whole of the fix's logic, and it is entirely decidable from
 * (captions, now). Keeping it pure means the grouping rules can be tested
 * directly — "does a 2-second pause append or start a new block?" is a unit
 * test, not something to verify by signing at a camera.
 *
 * IT CHANGES NOTHING ABOUT THE PROTOCOL
 * -------------------------------------
 * Segments still carry their own `segment_id`, interim events still replace by
 * id, finals still persist one row each. This reads that stream and decides
 * how to draw it. The transcript panel and the saved transcript are untouched.
 */

/**
 * @param {Array} captions  store entries, chronological. Each is one segment:
 *                          {segmentId, speakerId, speakerName, source, text,
 *                           isFinal, timestamp}
 * @param {object} options
 * @param {number} options.now            epoch ms, for expiry. Injected so
 *                                        tests do not depend on wall-clock time.
 * @param {number|null} options.excludeSpeakerId
 *                                        drop captions from this speaker.
 *                                        Used to hide your own captions from
 *                                        your own caption area (Bug 2).
 * @param {number} options.ttlMs          how long a block lives after its last
 *                                        update.
 * @param {number} options.continueWindowMs
 *                                        a same-speaker gap longer than this
 *                                        starts a new block.
 * @param {number} options.maxBlocks      how many blocks to return.
 * @returns {Array} blocks, oldest first. Each:
 *   {key, speakerId, speakerName, source, settledText, interimText,
 *    lastUpdate, ageMs, fadingOut, segmentIds}
 */
export function buildCaptionBlocks(
  captions,
  {
    now = Date.now(),
    excludeSpeakerId = null,
    ttlMs = CAPTIONS.BLOCK_TTL_MS,
    continueWindowMs = CAPTIONS.BLOCK_CONTINUE_WINDOW_MS,
    maxBlocks = CAPTIONS.MAX_VISIBLE_BLOCKS,
  } = {},
) {
  if (!Array.isArray(captions) || captions.length === 0) return [];

  const usable = captions.filter((caption) => {
    if (!caption || typeof caption.text !== 'string') return false;
    // An empty segment carries no text to show. It is not dropped from the
    // store — an interim can legitimately start empty and fill in — but it has
    // nothing to contribute to a paragraph.
    if (!caption.text.trim()) return false;
    // Bug 2: the caption area shows what OTHER people produced. Your own words
    // are already visible to you on your own tile's detection pill, and
    // reading your own speech back is noise.
    if (excludeSpeakerId != null && caption.speakerId === excludeSpeakerId) return false;
    return true;
  });

  if (usable.length === 0) return [];

  const blocks = [];

  for (const caption of usable) {
    // ORDER comes from the server's clock, which is the right one for sorting
    // across two devices. AGE comes from this browser's clock, because the
    // server's is not comparable with `now` — see useCaptionStore.
    const at = toEpoch(caption.timestamp, now);
    const arrived = typeof caption.receivedAt === 'number' ? caption.receivedAt : at;
    const current = blocks[blocks.length - 1];

    // A new block starts when a DIFFERENT person speaks, or when this speaker
    // resumes after their previous block would already have faded out. Any
    // shorter pause continues the same paragraph.
    const sameSpeaker = current && current.speakerId === caption.speakerId;
    const withinWindow = current && at - current.lastUpdate <= continueWindowMs;

    if (sameSpeaker && withinWindow) {
      current.segments.push(caption);
      current.lastUpdate = Math.max(current.lastUpdate, at);
      current.lastArrival = Math.max(current.lastArrival, arrived);
    } else {
      blocks.push({
        key: `${caption.speakerId ?? 'anon'}-${caption.segmentId}`,
        speakerId: caption.speakerId,
        speakerName: caption.speakerName,
        segments: [caption],
        lastUpdate: at,
        lastArrival: arrived,
      });
    }
  }

  const shaped = blocks.map((block) => {
    // The trailing segment is "interim" only while it is still open. Every
    // earlier segment is settled text, including a non-final one that has been
    // superseded — its text is the best we will ever have for it.
    const last = block.segments[block.segments.length - 1];
    const openTail = last.isFinal ? null : last;
    const settled = openTail ? block.segments.slice(0, -1) : block.segments;

    // Measured from ARRIVAL, on this browser's clock.
    const ageMs = Math.max(0, now - block.lastArrival);

    // Sign blocks live longer than speech, and the reason is about the viewer
    // rather than the technology.
    //
    // Speech captions stream continuously, so the block keeps refreshing while
    // somebody talks. A sign caption is committed once per movement — one word
    // every few seconds — and the hearing participant is WATCHING THE SIGNER,
    // not the caption rail. By the time they look down, a five-second block
    // has already gone, and the words survive only in the transcript. That is
    // precisely the reported bug.
    const ttlForBlock = last.source === 'sign' ? CAPTIONS.SIGN_BLOCK_TTL_MS : ttlMs;

    return {
      key: block.key,
      speakerId: block.speakerId,
      speakerName: block.speakerName,
      // Which direction produced the most recent text in this block, for the
      // Sign/Speech badge. A block can legitimately mix the two if a
      // participant signs and speaks.
      source: last.source,
      settledText: joinSegments(settled),
      interimText: openTail ? openTail.text.trim() : '',
      lastUpdate: block.lastUpdate,
      ageMs,
      // Past its time to live: the UI starts the fade. It is kept in the list
      // for BLOCK_FADE_MS so the fade can be seen rather than the block
      // vanishing between two renders.
      fadingOut: ageMs > ttlForBlock,
      ttlMs: ttlForBlock,
      segmentIds: block.segments.map((segment) => segment.segmentId),
    };
  });

  // Drop blocks that have finished fading. Doing it here rather than in the
  // component keeps "what is on screen" a function of (captions, now).
  const alive = shaped.filter(
    (block) => block.ageMs <= block.ttlMs + CAPTIONS.BLOCK_FADE_MS,
  );

  // Newest blocks win when there are too many; the oldest is dropped first.
  return alive.slice(-maxBlocks);
}

/**
 * Join segment texts into one paragraph.
 *
 * Letter segments concatenate with no separator and word segments with a
 * space, but a segment's text already arrives joined correctly by
 * `useSignCaptions`. What is joined HERE is whole segments, which are separate
 * utterances, so a space is always right — and a double space is collapsed so
 * two segments cannot leave a visible gap.
 */
function joinSegments(segments) {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Timestamps arrive as server ISO strings.
 *
 * An unparseable one falls back to the CALLER'S `now`, not `Date.now()`.
 * Using the wall clock here made expiry depend on real time even when the
 * caller had injected a clock, so a caption with a bad timestamp could be
 * judged thousands of seconds old and vanish immediately.
 */
function toEpoch(timestamp, now) {
  if (typeof timestamp === 'number') return timestamp;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? now : parsed;
}
