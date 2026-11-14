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
import { readMainScreenInfo } from '../platform/mac-screen';

describe('readMainScreenInfo', () => {
  // The regression that unit fixtures could never catch: run the real script on a real Mac.
  it.skipIf(process.platform !== 'darwin')('on a real Mac: reads a positive logical size and a scale ≥ 1', async () => {
    const info = await readMainScreenInfo();
    expect(info).not.toBeNull();
    expect(info!.logicalWidth).toBeGreaterThan(0);
    expect(info!.logicalHeight).toBeGreaterThan(0);
    expect(info!.backingScaleFactor).toBeGreaterThanOrEqual(1);
  });
});
