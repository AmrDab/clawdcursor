/**
 * MCP coordinate-space test (v0.9 PR7 critical guard #3).
 *
 * The legacy /action REST endpoint applied 1280-image-coord scaling
 * (real_x = llm_x * screen_width / 1280). When PR7.4 deleted /action,
 * agents that used to call it must use mouse_click directly. This test
 * pins down that mouse_click does NOT secretly rescale — it consults
 * ctx.getMouseScaleFactor() which the daemon sets to 1 in agent mode,
 * so coords sent in are coords the OS receives.
 *
 * If a future regression re-introduces the silent /1280 rescale this
 * test fails immediately.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mock heavy native deps ───────────────────────────────────────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { getTool } from '../tools/registry';

describe('mouse_click coordinate space (PR7 guard)', () => {
  it('passes coords through unchanged when scaleFactor=1', async () => {
    const click = getTool('mouse_click')!;
    expect(click).toBeDefined();

    const captured: Array<{ x: number; y: number }> = [];
    const ctx = {
      platform: {
        mouseClick: vi.fn(async (x: number, y: number) => { captured.push({ x, y }); }),
        getActiveWindow: vi.fn(async () => null),
      },
      desktop: { getScreenSize: () => ({ width: 2560, height: 1440 }) },
      cdp: {},
      // Agent mode sets scale factor to 1: image-coords ARE OS-coords.
      getMouseScaleFactor: () => 1,
      getScreenshotScaleFactor: () => 1,
      ensureInitialized: async () => {},
    } as any;

    // (1000, 500) is the canonical regression test from the legacy /action
    // path. Old behavior on a 2560-wide display: real_x = 1000 * (2560/1280) = 2000.
    // New behavior: real_x = 1000 (no silent rescaling).
    await click.handler({ x: 1000, y: 500 }, ctx);
    expect(captured).toEqual([{ x: 1000, y: 500 }]);
  });

  it('still respects an explicit scale factor when DPI ratio differs', async () => {
    // The scale factor is a property of the ctx, not a hidden /1280
    // assumption. If the OS reports a 2.0 DPI ratio, mouse_click scales
    // accordingly — but this is opt-in, not silent.
    const click = getTool('mouse_click')!;
    const captured: Array<{ x: number; y: number }> = [];
    const ctx = {
      platform: {
        mouseClick: vi.fn(async (x: number, y: number) => { captured.push({ x, y }); }),
        getActiveWindow: vi.fn(async () => null),
      },
      desktop: { getScreenSize: () => ({ width: 2560, height: 1440 }) },
      cdp: {},
      getMouseScaleFactor: () => 2,
      getScreenshotScaleFactor: () => 2,
      ensureInitialized: async () => {},
    } as any;

    await click.handler({ x: 100, y: 50 }, ctx);
    expect(captured).toEqual([{ x: 200, y: 100 }]);
  });
});
