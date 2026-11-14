/**
 * Windows: where NativeDesktop puts the pointer for a SCREEN (physical px) point (#170). Through the bridge's move-cursor
 * when it answers (physical, any monitor); otherwise through nut-js, whose mouse uses the driver space of this process
 * (logical px when it is DPI-unaware), so the point is divided by dpiRatio = physical / driver width. The macOS side
 * (no division: callers already pass logical points) is in native-desktop-mac-dpi.test.ts.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { ClawdConfig } from '../types';

vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real, platform: () => 'win32' }, platform: () => 'win32' };
});
const nut = vi.hoisted(() => ({ driverWidth: 2560, setPosition: [] as Array<{ x: number; y: number }>, at: { x: 0, y: 0 } }));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: {
    config: {},
    setPosition: vi.fn(async (p: { x: number; y: number }) => { nut.setPosition.push({ x: p.x, y: p.y }); }),
    click: vi.fn(async () => {}),
    doubleClick: vi.fn(async () => {}),
    rightClick: vi.fn(async () => {}),
    scrollDown: vi.fn(async () => {}),
    scrollUp: vi.fn(async () => {}),
    pressButton: vi.fn(async () => {}),
    releaseButton: vi.fn(async () => {}),
    getPosition: vi.fn(async () => nut.at),
  },
  keyboard: { config: {} },
  // A 225 % panel: the capture is 5760×3240 physical px.
  screen: { config: {}, grab: vi.fn(async () => ({ width: 5760, height: 3240, data: Buffer.alloc(4) })), width: vi.fn(async () => nut.driverWidth), height: vi.fn(async () => 1440) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('../platform/screen-grab', () => ({ rawScreenGrab: vi.fn(async () => ({ width: 5760, height: 3240, data: Buffer.alloc(4) })) }));

import { psRunner } from '../platform/ps-runner';
import { NativeDesktop } from '../platform/native-desktop';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); });

async function desktop(driverWidth: number): Promise<NativeDesktop> {
  nut.driverWidth = driverWidth;
  const d = new NativeDesktop({} as ClawdConfig);
  await d.connect();
  return d;
}

describe('NativeDesktop on Windows: a screen point reaches the pointer', () => {
  beforeEach(() => {
    nut.setPosition.length = 0;
    vi.mocked(psRunner.run).mockRejectedValue(new Error('bridge down'));   // the nut-js fallback, unless a test says otherwise
  });

  it('a DPI-unaware process at 225 %: dpiRatio 2.25, and a click at (1000, 500) puts the nut-js pointer at (444, 222)', async () => {
    const d = await desktop(2560);
    expect(d.getDpiRatio()).toBe(2.25);
    await d.mouseClick(1000, 500);
    expect(nut.setPosition).toEqual([{ x: 444, y: 222 }]);
  });

  it('a DPI-aware process (the driver sees physical px): dpiRatio 1, the point is passed as is', async () => {
    const d = await desktop(5760);
    expect(d.getDpiRatio()).toBe(1);
    await d.mouseClick(1000, 500);
    expect(nut.setPosition).toEqual([{ x: 1000, y: 500 }]);
  });

  it('a move divides the same way as a click', async () => {
    const d = await desktop(2560);
    await d.mouseMove(2250, 1125);
    expect(nut.setPosition).toEqual([{ x: 1000, y: 500 }]);
  });

  it.each([
    ['mouseDoubleClick', (d: NativeDesktop) => d.mouseDoubleClick(1000, 500)],
    ['mouseRightClick', (d: NativeDesktop) => d.mouseRightClick(1000, 500)],
    ['mouseScroll', (d: NativeDesktop) => d.mouseScroll(1000, 500, 1)],
  ] as const)('%s at (1000, 500) divides the same way: the nut-js pointer at (444, 222)', async (_name, act) => {
    const d = await desktop(2560);
    await act(d);
    expect(nut.setPosition).toEqual([{ x: 444, y: 222 }]);
  });

  it('mouseDrag divides every waypoint by 2.25, from the start point to the end point', async () => {
    const d = await desktop(2560);
    await d.mouseDrag(1000, 500, 1090, 545);   // 5 steps
    expect(nut.setPosition).toEqual([
      { x: 444, y: 222 }, { x: 452, y: 226 }, { x: 460, y: 230 }, { x: 468, y: 234 }, { x: 476, y: 238 }, { x: 484, y: 242 },
    ]);
  });

  it('the cursor read is the inverse: the nut-js pointer at (444, 222) is the screen point (999, 500)', async () => {
    const d = await desktop(2560);
    nut.at = { x: 444, y: 222 };
    expect(await d.getCursorPosition()).toEqual({ x: 999, y: 500 });
  });

  it('with the bridge up, the physical point goes to move-cursor (any monitor) and nut-js is not used', async () => {
    const d = await desktop(2560);
    vi.mocked(psRunner.run).mockResolvedValue({ success: true } as never);
    await d.mouseClick(1000, 500);
    expect(psRunner.run).toHaveBeenCalledWith({ cmd: 'move-cursor', x: 1000, y: 500 });
    expect(nut.setPosition).toEqual([]);
  });
});
