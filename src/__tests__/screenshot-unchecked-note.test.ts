/**
 * A macOS capture that went ahead because Screen Recording could not be checked may be a wallpaper-only image (#276).
 * The warning goes to stderr, which an MCP client never shows the agent, so the screenshot reply itself says it — on
 * `desktop_screenshot` / `desktop_screenshot_region`, which the compact `computer screenshot` / `zoom` delegate to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const check = vi.hoisted(() => ({ unchecked: false }));
vi.mock('../platform/native-helper', async (orig) => ({
  ...(await orig<typeof import('../platform/native-helper')>()), lastCaptureUnchecked: () => check.unchecked,
}));

import { getDesktopTools } from '../tools/desktop';

const tool = (name: string) => getDesktopTools().find(t => t.name === name)!;
const frame = { buffer: Buffer.from('x'), width: 2560, height: 1600, llmWidth: 1280, llmHeight: 800, scaleFactor: 2 };
const ctx = () => ({
  ensureInitialized: async () => {},
  getScreenshotScaleFactor: () => 2,
  desktop: { captureForLLM: vi.fn(async () => frame), captureRegionForLLM: vi.fn(async () => frame) },
}) as never;
const NOTE = /Screen Recording could not be checked on this Mac — if this image shows only the desktop background, the app running clawdcursor needs Screen Recording/;
const shots = [
  () => tool('desktop_screenshot').handler({}, ctx()),
  () => tool('desktop_screenshot_region').handler({ x: 0, y: 0, width: 100, height: 100 }, ctx()),
];

beforeEach(() => { check.unchecked = false; });

describe('the screenshot reply after an unchecked capture', () => {
  it('says the grant could not be checked, on one line of its own', async () => {
    check.unchecked = true;
    for (const shot of shots) {
      const r = await shot();
      expect(r.text).toMatch(NOTE);
      expect(r.text.split('\n').at(-1)).toMatch(NOTE);
    }
  });

  it('a checked capture says nothing extra', async () => {
    for (const shot of shots) expect((await shot()).text).not.toMatch(/could not be checked/);
  });
});
