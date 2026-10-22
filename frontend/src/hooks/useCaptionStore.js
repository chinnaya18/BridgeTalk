import { useCallback, useRef, useState } from 'react';

/**
 * The live caption list, keyed by segment id.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * An interim event carries the FULL CURRENT text of its segment, so a receiver
 * **replaces** the entry with that id. It never appends.
 *
 * Appending is what produced the reported
 * "warm warm fast we we we we old warm warm warm": every interim was treated
 * as new text and concatenated onto the line before it.
 *
 * A final event closes the segment. The entry stays in the list — it is now
 * settled text — and the producer moves to a new id.
 *
 * WHY THE LIST IS CAPPED
 * ----------------------
 * The caption area shows the most recent few lines. An hour-long meeting would
 * otherwise hold thousands of entries in React state and re-render all of them
 * on every interim, which arrive several times a second. The transcript panel
 * reads from the database, not from here, so nothing is lost by trimming.
 */

// Enough for the caption area to show its three lines and scroll smoothly.
const MAX_LIVE_CAPTIONS = 40;

export function useCaptionStore() {
  const [captions, setCaptions] = useState([]);
  // Mirrors the list for synchronous reads inside callbacks, where state would
  // be a render behind.
  const bySegment = useRef(new Map());

  const applyCaption = useCallback((event) => {
    const segmentId = event?.segment_id;
    if (!segmentId) return;

    const entry = {
      segmentId,
      speakerId: event.speaker?.id ?? null,
      speakerName: event.speaker?.name ?? 'Participant',
      source: event.source === 'sign' ? 'sign' : 'speech',
      text: event.text ?? '',
      isFinal: Boolean(event.is_final),
      confidence: event.confidence ?? null,
      timestamp: event.timestamp ?? new Date().toISOString(),
      // When THIS browser received it, on THIS browser's clock.
      //
      // Expiry used to be measured from `timestamp`, which the SERVER stamps.
      // The two clocks are unrelated: on a second device whose clock runs
      // ahead of the server's by more than the block lifetime, every caption
      // arrives already "expired" and is dropped before it is ever drawn.
      // Nothing in the UI explains that, and the transcript still fills up —
      // which is exactly the reported symptom.
      //
      // The server timestamp is still used for ORDER and for display, where it
      // is the right clock to trust. Only the age is local.
      receivedAt: Date.now(),
    };

    bySegment.current.set(segmentId, entry);

    setCaptions((current) => {
      const index = current.findIndex((item) => item.segmentId === segmentId);

      // REPLACE, never append. See the note above.
      if (index !== -1) {
        const next = current.slice();
        next[index] = entry;
        return next;
      }

      // An empty interim for a brand-new segment is the recogniser warming
      // up. Showing a blank line would make the caption area flicker.
      if (!entry.text.trim()) return current;

      const next = [...current, entry];
      return next.length > MAX_LIVE_CAPTIONS
        ? next.slice(next.length - MAX_LIVE_CAPTIONS)
        : next;
    });
  }, []);

  const clearCaptions = useCallback(() => {
    bySegment.current.clear();
    setCaptions([]);
  }, []);

  /** Drop one segment, for the local "undo last" control. */
  const removeSegment = useCallback((segmentId) => {
    bySegment.current.delete(segmentId);
    setCaptions((current) => current.filter((item) => item.segmentId !== segmentId));
  }, []);

  return { captions, applyCaption, clearCaptions, removeSegment };
}

/**
 * Generate a segment id.
 *
 * Needs to be unique across PARTICIPANTS, not just within one browser: the
 * server keys a UNIQUE database index on (meeting_id, segment_id), so two
 * people generating "1" at the same moment would make one of their captions
 * silently fail to persist.
 */
export function newSegmentId(prefix = 'seg') {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
