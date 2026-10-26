/**
 * macOS, normal path (screenshot-helper present): NativeDesktop.connect() must
 * detect dpiRatio = physical / logical. It returned before any probe, so
 * getDpiRatio() stayed 1 on every Mac — ocr.ts divides OCR's physical pixels by
 * it to report "screen coordinates" (logical on macOS), smart_click's OCR
 * fallback divides by it before clicking, and scope:"window" OCR multiplies the
 * window bounds by it. All three were 2× off on Retina (#154) even after the
 * mouse scale itself had been fixed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
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

const helper = vi.hoisted(() => ({
  capture: vi.fn(async () => ({ path: '/nonexistent/clawdcursor-probe.png', width: 4480, height: 2520 })),
  preflight: vi.fn(async () => {}),
  Denied: class ScreenRecordingDeniedError extends Error {},
}));
vi.mock('../platform/native-helper', () => ({
  getNativeHelper: () => null, captureScreenViaHelper: helper.capture,
  assertScreenRecordingGranted: helper.preflight, ScreenRecordingDeniedError: helper.Denied,
}));

const nsScreen = vi.hoisted(() => ({ value: null as null | { logicalWidth: number; logicalHeight: number; backingScaleFactor: number } }));
vi.mock('../platform/mac-screen', () => ({ readMainScreenInfo: vi.fn(async () => nsScreen.value) }));

import { NativeDesktop } from '../platform/native-desktop';

const config = {} as ClawdConfig;   // connect() reads nothing from it

describe('macOS without Screen Recording: an error, never a wallpaper-only image (#276)', () => {
  it('a denial from the helper is not downgraded to a nut-js grab', async () => {
    const nut = await import('@nut-tree-fork/nut-js');
    const d = new NativeDesktop(config);
    await d.connect();
    const denied = new helper.Denied('Screen Recording permission denied');
    helper.capture.mockRejectedValue(denied);
    (nut.screen.grab as any).mockClear();
    for (const capture of [() => d.captureScreen(), () => d.captureForLLM()]) {
      await expect(capture()).rejects.toBe(denied);
    }
    expect(nut.screen.grab).not.toHaveBeenCalled();
    // a grab that does fall back (helper missing) is checked too
    helper.capture.mockRejectedValue(new Error('helper missing'));
    helper.preflight.mockRejectedValueOnce(denied);
    await expect(d.captureScreen()).rejects.toBe(denied);
    expect(nut.screen.grab).not.toHaveBeenCalled();
    helper.capture.mockReset();
    helper.capture.mockImplementation(async () => ({ path: '/nonexistent/clawdcursor-probe.png', width: 4480, height: 2520 }));
  });
});

describe('NativeDesktop.connect() on macOS with the screenshot-helper', () => {
  // connect()'s DPI step branches on process.platform (os.platform is mocked above): run as macOS on every CI runner.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' }); });
  afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); });
  beforeEach(() => { nsScreen.value = { logicalWidth: 2240, logicalHeight: 1260, backingScaleFactor: 2 }; helper.capture.mockClear(); });

  it('detects dpiRatio = physical / logical (2 on a 4480×2520 / 2240×1260 Retina panel)', async () => {
    const d = new NativeDesktop(config);
    await d.connect();
    expect(helper.capture).toHaveBeenCalled();          // the helper path, not the nut-js fallback
    expect(d.getScaleFactor()).toBeCloseTo(3.5, 5);     // screenshots: physical / 1280, unchanged
    expect(d.getDpiRatio()).toBe(2);                     // OCR → screen coords divide by this
  });

  it('no helper and a failed grab: connects anyway with the NSScreen size, so tools that never capture keep working (#244)', async () => {
    const nut = await import('@nut-tree-fork/nut-js');
    helper.capture.mockRejectedValueOnce(new Error('helper missing'));
    (nut.screen.grab as any).mockRejectedValueOnce(new Error('Failed to capture screen'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = new NativeDesktop(config);
    await expect(d.connect()).resolves.toBeUndefined();
    expect(d.getDpiRatio()).toBe(2);
    expect(d.getScreenSize()).toEqual({ width: 4480, height: 2520 });   // NSScreen 2240×1260 × backing 2
    expect(d.getScaleFactor()).toBeCloseTo(3.5, 5);
    expect(warn.mock.calls.some(c => /Screen capture unavailable/.test(String(c[0])))).toBe(true);
    // A screenshot then fails with what to do about it — through the path the screenshot tool uses, too.
    for (const capture of [() => d.captureScreen(), () => d.captureForLLM()]) {
      helper.capture.mockRejectedValue(new Error('helper missing'));
      (nut.screen.grab as any).mockRejectedValue(new Error('Failed to capture screen'));
      await expect(capture()).rejects.toThrow(/Screen capture unavailable on macOS.*Screen Recording/);
    }
    helper.capture.mockReset();
    helper.capture.mockImplementation(async () => ({ path: '/nonexistent/clawdcursor-probe.png', width: 4480, height: 2520 }));
    (nut.screen.grab as any).mockReset();
    warn.mockRestore();
  });

  it('a failed grab with NSScreen unreadable too still fails connect() (no size to work with)', async () => {
    const nut = await import('@nut-tree-fork/nut-js');
    nsScreen.value = null;
    helper.capture.mockRejectedValueOnce(new Error('helper missing'));
    (nut.screen.grab as any).mockRejectedValueOnce(new Error('Failed to capture screen'));
    const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    await expect(new NativeDesktop(config).connect()).rejects.toThrow(/Failed to capture screen/);
    quiet.forEach(s => s.mockRestore());
  });

  it('keeps dpiRatio at 1 when NSScreen is unreadable, without failing connect()', async () => {
    nsScreen.value = null;
    const d = new NativeDesktop(config);
    await d.connect();
    expect(d.getDpiRatio()).toBe(1);
  });
});
