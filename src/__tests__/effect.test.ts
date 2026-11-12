/** #357 / #379: what the window in front did across an act, by identity (handle, else process), never by title. */
import { describe, it, expect } from 'vitest';
import { windowChange, effectLine } from '../core/effect';

describe('windowChange', () => {
  it('a Store app is the app its frame hosts: two apps in one frame process are two apps', () => {
    expect(windowChange({ processId: 9, hostedProcessId: 1, handle: 5 }, { processId: 9, hostedProcessId: 2, handle: 6 })).toBe('other-app');
  });
  it('a read that failed, or a window the OS only guessed (Linux without xdotool), tells nothing', () => {
    expect(windowChange(null, { processId: 1 })).toBeUndefined();
    expect(windowChange({ processId: 1, guessed: true }, { processId: 2 })).toBeUndefined();
    expect(effectLine({ processId: 1 }, { processId: 2, guessed: true })).toBe('');
  });
  it('the same title in another app is another app', () => {
    expect(windowChange({ processId: 1, title: 'Untitled' }, { processId: 2, title: 'Untitled' })).toBe('other-app');
  });
});
