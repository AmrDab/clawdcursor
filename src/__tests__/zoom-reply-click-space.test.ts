/**
 * `computer zoom` / `desktop_screenshot_region` return a magnified view. Clicks do NOT take coordinates from that image: they stay
 * in the space of the full screenshot (one number system per screenshot, never two). The reply used to say only
 * "Region: (175,147) 200x120 image-space → zoomed to 700x420px, about 390 image tokens." — an agent that clicked the target's position IN the zoomed image
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
import { setLastFrame } from '../platform/coord-scale';

const region = getDesktopTools().find(t => t.name === 'desktop_screenshot_region')!;
const ctx = () => ({
  ensureInitialized: async () => {},
  getScreenshotScaleFactor: () => 3.5,
  getMouseScaleFactor: () => 3.5,
  desktop: { captureRegionForLLM: vi.fn(async () => ({ buffer: Buffer.from('x'), llmWidth: 700, llmHeight: 420 })) },
}) as never;

describe('the zoom reply', () => {
  it('keeps the region line and says clicks stay in full-screenshot coordinates, with the conversion', async () => {
    const r = await region.handler({ x: 175, y: 147, width: 200, height: 120 }, ctx());
    expect(r.text).toContain('Region: (175,147) 200x120 image-space → zoomed to 700x420px, about 390 image tokens.');
    expect(r.text).toMatch(/clicks stay in full-screenshot coordinates/i);
    expect(r.text).toContain('x = 175 + zx·200/700');
    expect(r.text).toContain('y = 147 + zy·120/420');
  });

  // #354: a look at only the changed area can cost less; the reply states the price.
  it('max_edge shrinks the zoom (clamped to 64..1280) and the reply states the size and cost', async () => {
    const c = ctx() as unknown as { desktop: { captureRegionForLLM: ReturnType<typeof vi.fn> } };
    c.desktop.captureRegionForLLM.mockResolvedValueOnce({ buffer: Buffer.from('x'), llmWidth: 512, llmHeight: 307 });
    const r = await region.handler({ x: 175, y: 147, width: 200, height: 120, max_edge: 512 }, c as never);
    expect(c.desktop.captureRegionForLLM).toHaveBeenLastCalledWith(613, 515, 700, 420, 512);
    expect(r.text).toContain('→ zoomed to 512x307px, about 210 image tokens.');
    await region.handler({ x: 175, y: 147, width: 200, height: 120, max_edge: 10 }, c as never);
    expect(c.desktop.captureRegionForLLM).toHaveBeenLastCalledWith(613, 515, 700, 420, 64);
    await region.handler({ x: 175, y: 147, width: 200, height: 120, max_edge: 5000 }, c as never);
    expect(c.desktop.captureRegionForLLM).toHaveBeenLastCalledWith(613, 515, 700, 420, 1280);
  });

  it('a screen-space region converts to screen coordinates (space:"screen")', async () => {
    const r = await region.handler({ x: 600, y: 300, width: 350, height: 210, space: 'screen' }, ctx());
    expect(r.text).toContain('Region: (600,300) 350x210 screen-space → zoomed to 700x420px, about 390 image tokens.');
    expect(r.text).toContain('x = 600 + zx·350/700');
    expect(r.text).toMatch(/space:"screen"/);
  });
});

describe('screenshot max_edge', () => {
  it("reaches the capture, so the frame and the click scale it sets are the small image's", async () => {
    const shot = getDesktopTools().find(t => t.name === 'desktop_screenshot')!;
    const captureForLLM = vi.fn(async () => ({ buffer: Buffer.from('x'), llmWidth: 512, llmHeight: 288, width: 2560, height: 1440, scaleFactor: 5 }));
    const r = await shot.handler({ max_edge: 512 }, { ensureInitialized: async () => {}, desktop: { captureForLLM } } as never);
    expect(captureForLLM).toHaveBeenCalledWith(512);
    expect(r.text).toContain('Screenshot: 512x288px');
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
    expect(captureRegionForLLM).toHaveBeenCalledWith(2796 + 150, -1080 + 75, 300, 180, 1280);
  }));

  it('the reply names the display the coordinates belong to, and that clicks follow the latest screenshot', () => onWindows(async () => {
    const { ctx } = withDisplays();
    const r = await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 1 }, ctx);
    expect(r.text).toContain("display #1's screenshot");
    expect(r.text).toMatch(/screenshot with display:1 first/);
    const plain = await region.handler({ x: 100, y: 50, width: 200, height: 120 }, ctx);
    expect(plain.text).not.toMatch(/display #/);
  }));

  it('maps by the latest screenshot of that display when there is one (its max_edge scale)', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    // screenshot {display:1, max_edge:512} of 1920x1080: 512x288 at 3.75 screen px per image px.
    setLastFrame({ originX: 2796, originY: -1080, scale: 3.75, display: 1 });
    try {
      await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 1 }, ctx);
      expect(captureRegionForLLM).toHaveBeenCalledWith(2796 + 375, -1080 + 188, 750, 450, 1280);
    } finally { setLastFrame(null); }
  }));

  it('the primary display maps by the plain screenshot scale', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 0 }, ctx);
    expect(captureRegionForLLM).toHaveBeenCalledWith(300, 150, 600, 360, 1280);
  }));

  it('refuses a display that does not exist, as screenshot does', () => onWindows(async () => {
    const { ctx, captureRegionForLLM } = withDisplays();
    const r = await region.handler({ x: 100, y: 50, width: 200, height: 120, display: 7 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No display #7');
    expect(captureRegionForLLM).not.toHaveBeenCalled();
  }));
});
