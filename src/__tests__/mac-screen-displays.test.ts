/**
 * Multi-monitor enumeration on macOS. The AppleScript behind listDisplays()
 * compared `(s as any) = primaryScreen`, which does not even compile (-2741), so
 * every macOS install silently fell back to "one display". NSScreen.screens puts
 * the primary (menu-bar) screen at index 0, and each screen has its own scale.
 */
import { describe, it, expect } from 'vitest';
import { parseDisplayList, readDisplayList } from '../platform/mac-screen';

describe('parseDisplayList', () => {
  it('parses one line per screen: index|x,y,w,h|primary|backingScaleFactor', () => {
    expect(parseDisplayList('0|0,0,2240,1260|true|2.0\n1|2240,0,1920,1080|false|1.0\n')).toEqual([
      { index: 0, x: 0, y: 0, width: 2240, height: 1260, primary: true, backingScaleFactor: 2 },
      { index: 1, x: 2240, y: 0, width: 1920, height: 1080, primary: false, backingScaleFactor: 1 },
    ]);
  });

  it('a screen left of the primary has a negative x', () => {
    expect(parseDisplayList('0|0,0,2240,1260|true|2.0\n1|-1920,0,1920,1080|false|1.0')[1].x).toBe(-1920);
  });

  it('returns [] for empty output', () => {
    expect(parseDisplayList('')).toEqual([]);
  });
});

describe('readDisplayList', () => {
  it('returns null when osascript fails, so listDisplays() can fall back to the main screen', async () => {
    const exec = async () => { throw new Error('script error'); };
    expect(await readDisplayList(exec as never)).toBeNull();
  });

});
