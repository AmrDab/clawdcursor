/**
 * `computer zoom` / `desktop_screenshot_region` return a magnified view. Clicks do NOT take coordinates from that image: they stay
 * in the space of the full screenshot (one number system per screenshot, never two). The reply used to say only
 * "Region: (175,147) 200x120 image-space → zoomed to 700x420px." — an agent that clicked the target's position IN the zoomed image
 * landed 133 pt away (live blind run of 2026-10-19). The reply now says how to convert.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { getDesktopTools, SPACE_PARAM } from '../tools/desktop';

const region = getDesktopTools().find(t => t.name === 'desktop_screenshot_region')!;
const ctx = () => ({
  ensureInitialized: async () => {},
  getScreenshotScaleFactor: () => 3.5,
  desktop: { captureRegionForLLM: vi.fn(async () => ({ buffer: Buffer.from('x'), llmWidth: 700, llmHeight: 420 })) },
}) as never;

describe('the zoom reply', () => {
  it('keeps the region line and says clicks stay in full-screenshot coordinates, with the conversion', async () => {
    const r = await region.handler({ x: 175, y: 147, width: 200, height: 120 }, ctx());
    expect(r.text).toContain('Region: (175,147) 200x120 image-space → zoomed to 700x420px.');
    expect(r.text).toMatch(/clicks stay in full-screenshot coordinates/i);
    expect(r.text).toContain('x = 175 + zx·200/700');
    expect(r.text).toContain('y = 147 + zy·120/420');
  });

  it('a screen-space region converts to screen coordinates (space:"screen")', async () => {
    const r = await region.handler({ x: 600, y: 300, width: 350, height: 210, space: 'screen' }, ctx());
    expect(r.text).toContain('Region: (600,300) 350x210 screen-space → zoomed to 700x420px.');
    expect(r.text).toContain('x = 600 + zx·350/700');
    expect(r.text).toMatch(/space:"screen"/);
  });
});

describe('the space parameter text', () => {
  it('no longer claims screen coordinates are "already physical" — on macOS they are points', () => {
    expect(SPACE_PARAM.description).not.toMatch(/already physical/i);
    expect(SPACE_PARAM.description).toMatch(/points/i);
    expect(SPACE_PARAM.description).toMatch(/macOS/);
  });
});

// `computer zoom` ignored `display` although `screenshot` takes it (live 2026-11-10): the region was read against
// whichever monitor the last screenshot showed. With `display`, it is read against THAT monitor's screenshot.
describe('zoom with display', () => {
  const D = (index: number, x: number, y: number, width: number, height: number, primary = false) =>
    ({ index, label: `D${index}`, primary, bounds: { x, y, width, height }, physicalSize: { width, height }, dpiRatio: 1 });
  const displays = [D(0, 0, 0, 3840, 2400, true), D(1, 2796, -1080, 1920, 1080)];
  const withDisplays = () => {
    const captureRegionForLLM = vi.fn(async () => ({ buffer: Buffer.from('x'), llmWidth: 700, llmHeight: 420 }));
    return {
      captureRegionForLLM,
      ctx: {
        ensureInitialized: async () => {},
        getScreenshotScaleFactor: () => 3,
        desktop: { captureRegionForLLM },
        platform: { listDisplays: async () => displays, screenshot: async () => { throw new Error('no bridge'); } },
      } as never,
    };
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const onWindows = async (run: () => Promise<void>) => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try { await run(); } finally { Object.defineProperty(process, 'platform', platform); }
  };

  it('declares the display parameter screenshot has', () => {
    const shot = getDesktopTools().find(t => t.name === 'desktop_screenshot')!;
    expect(shot.parameters.display.type).toBe('number');
    expect(region.parameters.display?.type).toBe('number');
  });

  it('maps an image-space region onto the named monitor, negative origin included', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    const r = await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 1 }, ctx);
    expect(r.isError).toBeFalsy();
    // 1920x1080 fits 1280 on its long edge at 1.5 screen px per image px.
    expect(captureRegionForLLM).toHaveBeenCalledWith(2796 + 150, -1080 + 75, 300, 180);
  }));

  it('the primary display maps by the plain screenshot scale', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 0 }, ctx);
    expect(captureRegionForLLM).toHaveBeenCalledWith(300, 150, 600, 360);
  }));

  it('refuses a display that does not exist, as screenshot does', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    const r = await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 7 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No display #7');
    expect(captureRegionForLLM).not.toHaveBeenCalled();
  }));
});
