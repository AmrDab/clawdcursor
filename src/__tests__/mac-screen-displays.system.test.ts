/**
 * Multi-monitor enumeration on macOS. The AppleScript behind listDisplays()
 * compared `(s as any) = primaryScreen`, which does not even compile (-2741), so
 * every macOS install silently fell back to "one display". NSScreen.screens puts
 * the primary (menu-bar) screen at index 0, and each screen has its own scale.
 */
import { describe, it, expect } from 'vitest';
import { readDisplayList } from '../platform/mac-screen';

describe('readDisplayList', () => {
  it.skipIf(process.platform !== 'darwin')('on a real Mac: at least one screen, index 0 is the primary', async () => {
    const rows = await readDisplayList();
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows![0].primary).toBe(true);
    expect(rows![0].width).toBeGreaterThan(0);
    expect(rows![0].backingScaleFactor).toBeGreaterThanOrEqual(1);
  });
});
