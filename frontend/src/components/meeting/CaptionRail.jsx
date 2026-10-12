import { useEffect, useRef, useState } from 'react';

import { CAPTIONS } from '../../config/recognition';
import { buildCaptionBlocks } from '../../utils/captionBlocks';
import Avatar from '../ui/Avatar';
import Icon from '../ui/Icon';

/**
 * The live caption area, between the stage and the control bar.
 *
 * CAPTIONS FLOW; THEY ARE NOT A LIST
 * ----------------------------------
 * Each speaker gets a BLOCK: their avatar and name once, then their text as one
 * continuous paragraph that grows. Consecutive segments from the same person are
 * merged, so a pause never starts a new line.
 *
 * This used to render one line per segment, which meant a short pause while
 * speaking or signing produced a new line and the rail read as a list rather
 * than as live speech.
 *
 * All of the grouping logic is in `utils/captionBlocks.js` as a pure function,
 * so the rules — what continues a paragraph, what starts a block, when a block
 * expires — are unit-tested rather than verified by signing at a camera.
 *
 * DISPLAY ONLY
 * ------------
 * Nothing here touches the caption protocol. Segments still carry their own
 * `segment_id`, interims still replace by id, and finals still persist one row
 * each. The transcript panel and the saved transcript are unaffected, and keep
 * both sides of the conversation.
 *
 * INTERIM IS GREY, SETTLED IS WHITE
 * ---------------------------------
 * The only signal a reader gets that text may still change. Without it, a deaf
 * participant cannot tell a settled sentence from a guess the recogniser is
 * about to revise, and revisions look like the system contradicting itself.
 */

const SIZE_CLASS = {
  normal: 'text-caption',
  large: 'text-caption-lg',
  xlarge: 'text-caption-xl',
};

// Line heights matching the three caption sizes, used to clamp a paragraph to
// VISIBLE_LINES. They have to agree with tailwind.config.js, which sets
// 22/30, 28/38 and 34/46.
const LINE_HEIGHT_PX = { normal: 30, large: 38, xlarge: 46 };

export default function CaptionRail({
  captions,
  size = 'normal',
  visible = true,
  excludeSpeakerId = null,
}) {
  // A block must disappear on its own, with no new caption to trigger a
  // re-render. This ticks only while something is on screen, so an idle
  // meeting does no work.
  const [tick, setTick] = useState(() => Date.now());
  const hasCaptions = Array.isArray(captions) && captions.length > 0;

  useEffect(() => {
    if (!visible || !hasCaptions) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(timer);
  }, [visible, hasCaptions]);

  // Hidden entirely rather than visually: the stage reclaims the 140px.
  if (!visible) return null;

  const blocks = buildCaptionBlocks(captions, { now: tick, excludeSpeakerId });
  const textClass = SIZE_CLASS[size] ?? SIZE_CLASS.normal;
  const lineHeight = LINE_HEIGHT_PX[size] ?? LINE_HEIGHT_PX.normal;

  return (
    <section
      aria-label="Live captions"
      className="h-captions shrink-0 border-t border-dark-surface bg-dark-bg"
    >
      <div
        // aria-live so a screen-reader user hears captions as they settle.
        // "polite" deliberately: "assertive" would cut off the previous line
        // mid-word every time an interim arrived.
        aria-live="polite"
        aria-atomic="false"
        className="mx-auto flex h-full max-w-caption flex-col justify-end gap-2 overflow-hidden px-4 py-3"
      >
        {blocks.length === 0 ? (
          <p className="text-sm text-dark-muted">
            Captions will appear here as people sign or speak.
          </p>
        ) : (
          blocks.map((block) => (
            <CaptionBlock
              key={block.key}
              block={block}
              textClass={textClass}
              lineHeight={lineHeight}
            />
          ))
        )}
      </div>
    </section>
  );
}

function CaptionBlock({ block, textClass, lineHeight }) {
  const scrollRef = useRef(null);

  // Keep the newest words in view. The paragraph is clamped to VISIBLE_LINES
  // and scrolled to the bottom, so as text grows older lines move up and out
  // while the newest words stay in the same place on screen.
  //
  // `scrollTop` is assigned directly rather than using
  // scrollIntoView({behavior: 'smooth'}): this runs on every interim, several
  // times a second, and smooth scrolling would queue animations faster than
  // they can finish so the rail would visibly lag behind the text.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [block.settledText, block.interimText]);

  return (
    <article
      className="transition-opacity"
      style={{
        opacity: block.fadingOut ? 0 : 1,
        transitionDuration: `${CAPTIONS.BLOCK_FADE_MS}ms`,
      }}
    >
      <div className="flex items-center gap-2">
        <Avatar name={block.speakerName} size={20} />
        <span className="truncate text-xs font-medium text-dark-muted">
          {block.speakerName}
        </span>
        <SourceBadge source={block.source} />
      </div>

      <div
        ref={scrollRef}
        className="mt-0.5 overflow-hidden"
        style={{ maxHeight: `${lineHeight * CAPTIONS.VISIBLE_LINES}px` }}
      >
        {/* ONE paragraph. Settled text and the open interim are spans inside
            it, not separate blocks, so the interim continues the sentence on
            the same line instead of starting a new one. */}
        <p className={`break-words font-medium ${textClass}`}>
          {block.settledText ? <span className="text-white">{block.settledText}</span> : null}
          {block.settledText && block.interimText ? ' ' : null}
          {block.interimText ? (
            <span className="text-[#BDC1C6]">{block.interimText}</span>
          ) : null}
        </p>
      </div>
    </article>
  );
}

function SourceBadge({ source }) {
  const isSign = source === 'sign';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-1.5
                 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dark-muted"
    >
      <Icon name={isSign ? 'sign_language' : 'mic'} size={12} />
      {isSign ? 'Sign' : 'Speech'}
    </span>
  );
}
