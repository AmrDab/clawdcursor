/**
 * Coordinate-space scaling — the fix for hybrid clicks landing on the wrong
 * window. On a 2560-wide screen the screenshot is 1280px, so image-space coords
 * must be ×2 to reach the screen; a11y/screen coords pass through unchanged.
 *
 * Also covers the macOS Retina fix (#154): on darwin, nut-js drives the cursor
 * in LOGICAL POINTS, not physical pixels. imageScale() must therefore target
 * logicalWidth on macOS so a 2× Retina panel (4480 physical / 2240 logical)
 * yields scale=1.75 (logical/1280) not 3.5 (physical/1280).
 *
 * NEEDS REAL-MAC VERIFICATION for Items 1 & 2 — these tests are deterministic
 * on any platform via the injectable _platform field, but real-device mouse
 * accuracy can only be confirmed on a physical Retina Mac.
 *
 * Verifies both the pure scale helper and the granular `click` tool's `space`
 * behavior end-to-end with a mock adapter (OS-agnostic).
 */
import { describe, it, expect, vi } from 'vitest';
import { imageScale, scaleCoord, screenCenter, LLM_TARGET_WIDTH } from '../platform/coord-scale';
import { buildUnifiedTools } from '../tools/projected/tools';
import type { AgentToolContext } from '../tools/projected/types';

describe('imageScale / scaleCoord', () => {
  it('scales by physicalWidth/1280 when the screen is wider than the screenshot', () => {
    expect(imageScale({ screen: { physicalWidth: 2560 }, _platform: 'win32' })).toBe(2);
    expect(imageScale({ screen: { physicalWidth: 3840 }, _platform: 'win32' })).toBe(3);
  });
  it('is 1 when the screen is no wider than the screenshot', () => {
    expect(imageScale({ screen: { physicalWidth: 1280 }, _platform: 'win32' })).toBe(1);
    expect(imageScale({ screen: { physicalWidth: 1024 }, _platform: 'win32' })).toBe(1);
    expect(imageScale({ screen: {}, _platform: 'win32' })).toBe(1);
  });
  it('LLM_TARGET_WIDTH is the 1280 screenshot width', () => {
    expect(LLM_TARGET_WIDTH).toBe(1280);
  });
  it('scaleCoord rounds', () => {
    expect(scaleCoord(1107, 2)).toBe(2214);
    expect(scaleCoord(100.4, 1)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// macOS Retina fix (#154) — NEEDS REAL-MAC VERIFICATION
//
// On macOS, nut-js drives in logical points. A 2× Retina Mac has:
//   physicalWidth = 4480, logicalWidth = 2240 (backingScaleFactor=2)
// The mouse scale must target LOGICAL coords → 2240/1280 = 1.75, not 3.5.
// ─────────────────────────────────────────────────────────────────────────────
describe('imageScale — macOS Retina (#154)', () => {
  it('2× Retina (4480 physical / 2240 logical): returns logicalWidth/1280 = 1.75', () => {
    // physicalWidth=4480 would give 3.5 (wrong); logicalWidth=2240 gives 1.75 (correct).
    const scale = imageScale({
      screen: { physicalWidth: 4480, logicalWidth: 2240 },
      _platform: 'darwin',
    });
    expect(scale).toBeCloseTo(1.75, 5);
  });

  it('1× non-Retina Mac (1440 physical = 1440 logical): returns 1.125 (1440/1280)', () => {
    const scale = imageScale({
      screen: { physicalWidth: 1440, logicalWidth: 1440 },
      _platform: 'darwin',
    });
    expect(scale).toBeCloseTo(1.125, 5);
  });

  it('standard 1280-wide Mac screen: returns 1 (no downscale)', () => {
    expect(imageScale({
      screen: { physicalWidth: 1280, logicalWidth: 1280 },
      _platform: 'darwin',
    })).toBe(1);
  });

  it('falls back to physicalWidth when logicalWidth is absent/zero (best-effort)', () => {
    // Should not silently use 1; should use physical as best guess.
    expect(imageScale({
      screen: { physicalWidth: 2560, logicalWidth: 0 },
      _platform: 'darwin',
    })).toBe(2); // physicalWidth fallback
  });

  it('non-darwin platforms still use physicalWidth (Windows / Linux unchanged)', () => {
    // A 2× Windows HiDPI screen: physical=3840, logical=1920.
    // Windows nut-js is physical-pixel-aware → scale = physical/1280 = 3.
    expect(imageScale({
      screen: { physicalWidth: 3840, logicalWidth: 1920 },
      _platform: 'win32',
    })).toBe(3);
    expect(imageScale({
      screen: { physicalWidth: 3840, logicalWidth: 1920 },
      _platform: 'linux',
    })).toBe(3);
  });
});

describe('screenCenter — scroll no-coordinate fallback (M3)', () => {
  it('macOS Retina: centers in LOGICAL space, not physical (2560 logical / 5120 physical → 1280,720)', () => {
    const c = screenCenter({
      screen: { physicalWidth: 5120, physicalHeight: 2880, logicalWidth: 2560, logicalHeight: 1440 },
      _platform: 'darwin',
    });
    expect(c).toEqual({ x: 1280, y: 720 });   // was (2560,1440) = off-screen edge before the fix
  });
  it('Windows/Linux: centers in PHYSICAL space (nut-js is physical there)', () => {
    expect(screenCenter({ screen: { physicalWidth: 2560, physicalHeight: 1440 }, _platform: 'win32' }))
      .toEqual({ x: 1280, y: 720 });
    expect(screenCenter({ screen: { physicalWidth: 3840, physicalHeight: 2160 }, _platform: 'linux' }))
      .toEqual({ x: 1920, y: 1080 });
  });
  it('macOS falls back to physical when logical is absent', () => {
    expect(screenCenter({ screen: { physicalWidth: 1440, physicalHeight: 900 }, _platform: 'darwin' }))
      .toEqual({ x: 720, y: 450 });
  });
});

function makeCtx(clicks: Array<{ x: number; y: number }>): AgentToolContext {
  return {
    platform: {
      platform: 'win32',
      mouseClick: vi.fn((x: number, y: number) => { clicks.push({ x, y }); return Promise.resolve(); }),
      getActiveWindow: vi.fn(() => Promise.resolve({ title: 'Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })),
    } as any,
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
  };
}

describe('click tool coordinate space', () => {
  const click = buildUnifiedTools().find(t => t.name === 'click')!;

  it('space:"image" scales screenshot coords to physical (1107 → 2214)', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const r = await click.execute({ x: 1107, y: 423, space: 'image' }, makeCtx(clicks));
    expect(r.success).toBe(true);
    expect(clicks[0]).toEqual({ x: 2214, y: 846 });
    expect(r.text).toMatch(/image \(1107,423\)/);
    expect(r.text).toMatch(/×2/);
  });

  it('space:"screen" passes a11y coords through unchanged', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    await click.execute({ x: 1107, y: 423, space: 'screen' }, makeCtx(clicks));
    expect(clicks[0]).toEqual({ x: 1107, y: 423 });
  });

  it('result text ends with an effect line naming the app in front after the click', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    // before = Terminal, after = Edge (another process) → the effect line names it
    const ctx = makeCtx(clicks);
    let n = 0;
    (ctx.platform.getActiveWindow as any) = vi.fn(() => n++ === 0
      ? Promise.resolve({ title: 'Terminal', processName: 'wt', processId: 2, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })
      : Promise.resolve({ title: 'Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }));
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).toMatch(/\neffect: another app is in front: "msedge" "Edge"$/);
  });

  it('a clean click says the window stayed the same', async () => {
    const r = await click.execute({ x: 100, y: 100 }, makeCtx([]));
    expect(r.text).toMatch(/\neffect: same app in front$/);
  });

  // ── focus-theft warning (#bug 2026-06-11: OTP typed into the wrong window) ──
  it('warns FOCUS NOT CONFIRMED when the platform reports activation failed', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const ctx = makeCtx(clicks);
    // mouseClick reports it could NOT bring the window at the point to front.
    (ctx.platform.mouseClick as any) = vi.fn((x: number, y: number) => {
      clicks.push({ x, y });
      return Promise.resolve({ activated: false, title: 'Claude', processName: 'claude' });
    });
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).toMatch(/FOCUS NOT CONFIRMED/);
    expect(r.text).toMatch(/DO NOT type next/);
  });

  it('warns when foreground changed across the click (clicked away from the focused window)', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const ctx = makeCtx(clicks);
    let n = 0;
    // before = the popup that was focused, after = another app's window → theft.
    (ctx.platform.getActiveWindow as any) = vi.fn(() => n++ === 0
      ? Promise.resolve({ title: 'Device Activation - Microsoft Edge', processName: 'msedge', processId: 1, handle: 10, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })
      : Promise.resolve({ title: 'Claude', processName: 'claude', processId: 2, handle: 20, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }));
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).toMatch(/FOCUS NOT CONFIRMED/);
    expect(r.text).not.toMatch(/Windows foreground-lock/);   // the same words on every OS (#379)
  });

  // #379: a title is not a window's identity.
  it('does NOT warn when only the title changed (a tab switch in the same window)', async () => {
    const ctx = makeCtx([]);
    let n = 0;
    (ctx.platform.getActiveWindow as any) = vi.fn(() =>
      Promise.resolve({ title: n++ === 0 ? 'Inbox - Chrome' : 'Docs - Chrome', processName: 'chrome', processId: 1, handle: 10, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }));
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).not.toMatch(/FOCUS NOT CONFIRMED/);
    expect(r.text).toMatch(/\neffect: window same, title now "Docs - Chrome"$/);
  });

  it('does NOT warn when a dialog closed back to its owner (another window of the same app)', async () => {
    const ctx = makeCtx([]);
    let n = 0;
    (ctx.platform.getActiveWindow as any) = vi.fn(() => n++ === 0
      ? Promise.resolve({ title: 'Open', processName: 'chrome', processId: 1, handle: 11, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })
      : Promise.resolve({ title: 'Upload - Chrome', processName: 'chrome', processId: 1, handle: 10, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }));
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).not.toMatch(/FOCUS NOT CONFIRMED/);
    expect(r.text).toMatch(/\neffect: another window of the same app is in front: "Upload - Chrome"$/);
  });

  it('does NOT warn on a clean click (activation ok, foreground stable)', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const ctx = makeCtx(clicks);
    (ctx.platform.mouseClick as any) = vi.fn((x: number, y: number) => {
      clicks.push({ x, y });
      return Promise.resolve({ activated: true, title: 'Edge', processName: 'msedge' });
    });
    const r = await click.execute({ x: 100, y: 100 }, ctx);  // getActiveWindow returns 'Edge' both times
    expect(r.text).not.toMatch(/FOCUS NOT CONFIRMED/);
  });
});
