import { describe, expect, it } from 'vitest';

import { shortcutFor } from '../utils/shortcuts';

/**
 * A hearing participant spent an entire meeting seeing none of the deaf
 * participant's signs.
 *
 * The signs were captured and the captions were delivered — both verified. The
 * caption area was simply switched OFF on their device, and switching it off
 * removes the strip entirely rather than emptying it, so there was nothing
 * left on screen to say what had happened or how to undo it. The transcript
 * panel kept filling normally behind it, which made it look like a delivery
 * fault and sent the search in the wrong direction for days.
 *
 * It was switched off by a BARE `c`: any keystroke outside a text field, with
 * no modifier, unlike the microphone and the camera. On a tool whose purpose
 * is making one side of a conversation readable to the other, that removed the
 * translation in a single accidental keypress.
 */

const key = (k, modifiers = {}) => ({ key: k, target: { tagName: 'DIV' }, ...modifiers });

describe('meeting keyboard shortcuts', () => {
  it('ignores a bare "c" — the keystroke that hid every caption', () => {
    expect(shortcutFor(key('c'))).toBeNull();
    expect(shortcutFor(key('C'))).toBeNull();
  });

  it('toggles captions on Ctrl+Shift+C and Cmd+Shift+C', () => {
    expect(shortcutFor(key('c', { ctrlKey: true, shiftKey: true }))).toBe('captions');
    expect(shortcutFor(key('C', { metaKey: true, shiftKey: true }))).toBe('captions');
  });

  it('leaves Ctrl/Cmd+C alone, because that is Copy', () => {
    // This page asks people to copy the meeting link. Taking Copy for captions
    // would trade one silent failure for another.
    expect(shortcutFor(key('c', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('c', { metaKey: true }))).toBeNull();
  });

  it('still toggles the microphone and camera, unchanged', () => {
    expect(shortcutFor(key('d', { ctrlKey: true }))).toBe('mic');
    expect(shortcutFor(key('D', { metaKey: true }))).toBe('mic');
    expect(shortcutFor(key('e', { ctrlKey: true }))).toBe('camera');
    expect(shortcutFor(key('E', { metaKey: true }))).toBe('camera');
  });

  it('ignores every unmodified key, so typing is never a command', () => {
    for (const k of ['d', 'e', 'c', 'a', 'Enter', ' ']) {
      expect(shortcutFor(key(k)), `bare ${k}`).toBeNull();
    }
  });

  it('ignores keystrokes aimed at a text field', () => {
    // Otherwise typing a meeting code would toggle the microphone.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(shortcutFor({ key: 'd', ctrlKey: true, target: { tagName } })).toBeNull();
      expect(
        shortcutFor({ key: 'c', ctrlKey: true, shiftKey: true, target: { tagName } }),
      ).toBeNull();
    }
  });

  it('survives an event with no usable key', () => {
    expect(shortcutFor(null)).toBeNull();
    expect(shortcutFor({ ctrlKey: true, target: { tagName: 'DIV' } })).toBeNull();
  });
});
