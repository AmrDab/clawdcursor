/**
 * macOS, normal path (screenshot-helper present): NativeDesktop.connect() must
 * detect dpiRatio = physical / logical. It returned before any probe, so
 * getDpiRatio() stayed 1 on every Mac — ocr.ts divides OCR's physical pixels by
 * it to report "screen coordinates" (logical on macOS), smart_click's OCR
 * fallback divides by it before clicking, and scope:"window" OCR multiplies the
 * window bounds by it. All three were 2× off on Retina (#154) even after the
 * mouse scale itself had been fixed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClawdConfig } from '../types';

vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real.default, platform: () => 'darwin' }, platform: () => 'darwin' };
});
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} },
  keyboard: { config: {} },
  screen: { config: {}, grab: vi.fn(), width: vi.fn(async () => 2240), height: vi.fn(async () => 1260) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('../platform/ps-runner', () => ({ psRunner: { start: vi.fn(), run: vi.fn() } }));

const helper = vi.hoisted(() => ({ capture: vi.fn(async () => ({ path: '/nonexistent/clawdcursor-probe.png', width: 4480, height: 2520 })) }));
vi.mock('../platform/native-helper', () => ({ getNativeHelper: () => null, captureScreenViaHelper: helper.capture }));

const nsScreen = vi.hoisted(() => ({ value: null as null | { logicalWidth: number; logicalHeight: number; backingScaleFactor: number } }));
vi.mock('../platform/mac-screen', () => ({ readMainScreenInfo: vi.fn(async () => nsScreen.value) }));

import { NativeDesktop } from '../platform/native-desktop';

const config = {} as ClawdConfig;   // connect() reads nothing from it

describe('NativeDesktop.connect() on macOS with the screenshot-helper', () => {
  beforeEach(() => { nsScreen.value = { logicalWidth: 2240, logicalHeight: 1260, backingScaleFactor: 2 }; helper.capture.mockClear(); });

  it('detects dpiRatio = physical / logical (2 on a 4480×2520 / 2240×1260 Retina panel)', async () => {
    const d = new NativeDesktop(config);
    await d.connect();
    expect(helper.capture).toHaveBeenCalled();          // the helper path, not the nut-js fallback
    expect(d.getScaleFactor()).toBeCloseTo(3.5, 5);     // screenshots: physical / 1280, unchanged
    expect(d.getDpiRatio()).toBe(2);                     // OCR → screen coords divide by this
  });

  it('keeps dpiRatio at 1 when NSScreen is unreadable, without failing connect()', async () => {
    nsScreen.value = null;
    const d = new NativeDesktop(config);
    await d.connect();
    expect(d.getDpiRatio()).toBe(1);
  });
});
