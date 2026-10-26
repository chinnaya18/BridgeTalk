/**
 * Which meeting control a keystroke means, if any.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT INLINE IN THE HANDLER
 * ---------------------------------------------------------
 * It is the whole of the rule, and it is entirely decidable from the event.
 * Keeping it separate means "does a bare c hide the captions?" is a unit test
 * rather than something to verify by sitting in a meeting — which matters here
 * because the meeting page cannot be driven through a multi-step interaction
 * under jsdom: it navigates away about a second after mounting, so any test
 * that waits is racing a teardown rather than testing a shortcut.
 *
 * THE RULE THAT CHANGED, AND WHY
 * ------------------------------
 * Captions used to toggle on a BARE `c`. One stray keystroke anywhere outside
 * a text field hid every caption, and hiding them removes the strip entirely
 * rather than emptying it — so nothing was left on screen to say what had
 * happened. A hearing participant spent a whole meeting seeing none of the
 * deaf participant's signs because of it, while the transcript filled up
 * normally and made it look like a delivery fault.
 *
 * It now needs Ctrl/Cmd+Shift. Plain Ctrl/Cmd+C would not do: that is Copy,
 * and this page asks people to copy the meeting link. Shift keeps the `c`
 * mnemonic without taking Copy away.
 *
 * The microphone and camera are untouched, shift included or not, because
 * they already required a modifier and nothing about them was at fault.
 *
 * @param {KeyboardEvent} event
 * @returns {'mic'|'camera'|'captions'|null}
 */
export function shortcutFor(event) {
  if (!event) return null;

  // Typing in a field is typing, not a command — otherwise entering a meeting
  // code would toggle the microphone.
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;

  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return null;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

  if (key === 'd') return 'mic';
  if (key === 'e') return 'camera';
  if (key === 'c' && event.shiftKey) return 'captions';
  return null;
}
