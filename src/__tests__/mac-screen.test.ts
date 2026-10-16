/**
 * Main-screen geometry on macOS — the one place that reads NSScreen.
 *
 * The previous AppleScripts (`size of frame` in MacOSAdapter.getScreenSize and
 * `frame()'s size's width` in NativeDesktop) throw on macOS 26: NSRect bridges
 * into AppleScript as a nested list {{x,y},{w,h}}, not a record. The error was
 * swallowed, logicalWidth fell back to the PHYSICAL width, dpiRatio became 1 and
 * every Retina click landed 2× off (#154) — in both `agent` and `mcp` modes —
 * while `system ocr` returned physical pixels labelled as screen coordinates.
 */
import { describe, it, expect } from 'vitest';
import { MAIN_SCREEN_SCRIPT, parseMainScreenInfo, readMainScreenInfo } from '../platform/mac-screen';

describe('parseMainScreenInfo', () => {
  it('parses "logicalWidth,logicalHeight,backingScaleFactor" (a 2× Retina panel)', () => {
    expect(parseMainScreenInfo('2240,1260,2.0\n')).toEqual({ logicalWidth: 2240, logicalHeight: 1260, backingScaleFactor: 2 });
  });

  it('a 1× display reports scale 1', () => {
    expect(parseMainScreenInfo('1920,1080,1')).toEqual({ logicalWidth: 1920, logicalHeight: 1080, backingScaleFactor: 1 });
  });

  it('tolerates the list-coerced form AppleScript emits when "&" joins numbers ("2240, ,, 1260")', () => {
    expect(parseMainScreenInfo('2240, ,, 1260')).toEqual({ logicalWidth: 2240, logicalHeight: 1260, backingScaleFactor: 1 });
  });

  it('returns null for empty, non-numeric or zero-sized output', () => {
    expect(parseMainScreenInfo('')).toBeNull();
    expect(parseMainScreenInfo('execution error: Can’t get size of frame.')).toBeNull();
    expect(parseMainScreenInfo('0,0,2')).toBeNull();
  });
});

describe('MAIN_SCREEN_SCRIPT', () => {
  it('does not use the NSRect record syntax that throws on macOS 26 (-1728 / -1700)', () => {
    expect(MAIN_SCREEN_SCRIPT).not.toMatch(/size of frame|'s size's/);
  });
});

describe('readMainScreenInfo', () => {
  it('runs the script through osascript and parses its output', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '2240,1260,2.0\n', stderr: '' }; };
    const info = await readMainScreenInfo(exec as never);
    expect(info).toEqual({ logicalWidth: 2240, logicalHeight: 1260, backingScaleFactor: 2 });
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0]).toContain(MAIN_SCREEN_SCRIPT);
  });

  it('returns null when osascript fails, so callers fall back instead of crashing', async () => {
    const exec = async () => { throw new Error('execution error'); };
    expect(await readMainScreenInfo(exec as never)).toBeNull();
  });

  // The regression that unit fixtures could never catch: run the real script on a real Mac.
  it.skipIf(process.platform !== 'darwin')('on a real Mac: reads a positive logical size and a scale ≥ 1', async () => {
    const info = await readMainScreenInfo();
    expect(info).not.toBeNull();
    expect(info!.logicalWidth).toBeGreaterThan(0);
    expect(info!.logicalHeight).toBeGreaterThan(0);
    expect(info!.backingScaleFactor).toBeGreaterThanOrEqual(1);
  });
});
