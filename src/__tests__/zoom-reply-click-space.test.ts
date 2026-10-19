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
