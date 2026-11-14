/**
 * `space:"screen"` must be ONE space: the one accessibility positions and `click space:"screen"` use (points on macOS,
 * physical pixels on Windows and Linux). `screenshot_region` / `zoom` passed screen values straight to the capture, which
 * takes PHYSICAL pixels — so on a Retina Mac (live 2026-11-09, 2240x1260 pt = 4480x2520 px) the window frame
 * (520,48) 780x592 came back as points (260,24)-(650,320): half the place, half the size, another app's window.
 *
 * Each case: the capture gets the physical rectangle that IS the screen rectangle, and a point read off the zoomed image,
 * converted by the reply's own formula and clicked with space:"screen", lands on the same element.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

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

import { getDesktopTools } from '../tools/desktop';
import { getTool } from '../tools/registry';
import { llmSize, setLastFrame } from '../core/agent-loop/coord-scale';

const tools = getDesktopTools();
const region = tools.find(t => t.name === 'desktop_screenshot_region')!;
const click = getTool('mouse_click')!;

type Rect = { x: number; y: number; width: number; height: number };
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const on = (value: string) => Object.defineProperty(process, 'platform', { ...realPlatform, value });
afterEach(() => { Object.defineProperty(process, 'platform', realPlatform); setLastFrame(null); });

/**
 * A machine: `ssf` image→physical, `msf` image→mouse (the click space), and the capture path it has. `captured` records
 * the PHYSICAL rectangle the capture was asked for; `mouseClick` records where the driver was sent (mouse space).
 */
function machine(ssf: number, msf: number, bridge: boolean) {
  const captured: Rect[] = [];
  const mouseClick = vi.fn(async () => {});
  const ctx = {
    ensureInitialized: async () => {},
    getScreenshotScaleFactor: () => ssf,
    getMouseScaleFactor: () => msf,
    a11y: { invalidateCache: () => {} },
    desktop: {
      mouseClick,
      captureRegionForLLM: vi.fn(async (x: number, y: number, width: number, height: number) => {
        captured.push({ x, y, width, height });
        const s = llmSize(width, height);
        return { buffer: Buffer.from('x'), llmWidth: s.width, llmHeight: s.height };
      }),
    },
    platform: bridge ? {
      listDisplays: async () => [],
      screenshot: async (o: { region: Rect }) => {
        captured.push(o.region);
        const s = llmSize(o.region.width, o.region.height);
        return { buffer: Buffer.from('x'), width: s.width, height: s.height, scaleFactor: s.scale };
      },
    } : undefined,
  } as never;
  return { ctx, captured, mouseClick };
}

/**
 * Zoom on `rect` (screen space), find `element` (a screen-space point) in the image that came back, convert it by the
 * reply's formula, click it with space:"screen". Returns the captured physical rect and where the click went.
 * `pxPerUnit` = physical pixels per screen unit on that machine (what the element's true pixel position is).
 */
async function zoomThenClick(m: ReturnType<typeof machine>, rect: Rect, element: { x: number; y: number }, pxPerUnit: number) {
  const r = await region.handler({ ...rect, space: 'screen' }, m.ctx);
  expect(r.isError).toBeFalsy();
  const cap = m.captured[m.captured.length - 1];
  const f = /x = (-?\d+) \+ zx·(\d+)\/(\d+), y = (-?\d+) \+ zy·(\d+)\/(\d+)/.exec(r.text)!;
  expect(f, r.text).toBeTruthy();
  const [X, W, zw, Y, H, zh] = f.slice(1).map(Number);
  // Where the element sits in the zoomed image: its true pixel position inside the rectangle that was really captured.
  const zx = (element.x * pxPerUnit - cap.x) / cap.width * zw;
  const zy = (element.y * pxPerUnit - cap.y) / cap.height * zh;
  expect(r.text).toMatch(/space:"screen"/);
  // The click goes through the platform adapter, as the mouse_click agents call does.
  const clickCtx = { ...(m.ctx as object), platform: { ...((m.ctx as { platform?: object }).platform ?? {}), mouseClick: m.mouseClick, getActiveWindow: async () => null } } as never;
  await click.handler({ x: X + zx * W / zw, y: Y + zy * H / zh, space: 'screen' }, clickCtx);
  const [cx, cy] = m.mouseClick.mock.calls[m.mouseClick.mock.calls.length - 1] as unknown as [number, number];
  return { cap, clicked: { x: cx, y: cy } };
}

describe('screenshot_region / zoom with space:"screen"', () => {
  it('macOS Retina 2x: screen points → the physical rect of the same window; the reply maps back to points', async () => {
    on('darwin');
    // 4480x2520 px shown as 2240x1260 pt in a 1280-wide image: 3.5 px and 1.75 pt per image px.
    const m = machine(3.5, 1.75, false);
    const { cap, clicked } = await zoomThenClick(m, { x: 520, y: 48, width: 780, height: 592 }, { x: 900, y: 300 }, 2);
    expect(cap).toEqual({ x: 1040, y: 96, width: 1560, height: 1184 });
    expect(clicked).toEqual({ x: 900, y: 300 });
  });

  it('Windows primary at 225%: screen = physical px (what UIA reports and clicks take), captured as given', async () => {
    on('win32');
    // 3840x2400 at 225%: clicks are sent physical px (the driver divides), so image→mouse = image→physical = 3.
    const m = machine(3, 3, true);
    const { cap, clicked } = await zoomThenClick(m, { x: 1170, y: 108, width: 1755, height: 1332 }, { x: 2000, y: 700 }, 1);
    expect(cap).toEqual({ x: 1170, y: 108, width: 1755, height: 1332 });
    expect(clicked).toEqual({ x: 2000, y: 700 });
  });

  it('Windows primary at 225%, bridge down: the fallback capture gets the same physical rect', async () => {
    on('win32');
    const m = machine(3, 3, false);
    const { cap, clicked } = await zoomThenClick(m, { x: 1170, y: 108, width: 1755, height: 1332 }, { x: 2000, y: 700 }, 1);
    expect(cap).toEqual({ x: 1170, y: 108, width: 1755, height: 1332 });
    expect(clicked).toEqual({ x: 2000, y: 700 });
  });

  it('a secondary display at another scale (100%, negative origin): its screen rect is captured as given', async () => {
    on('win32');
    const m = machine(3, 3, true);
    // The last screenshot showed that monitor (1.5 px per image px): screen-space values must not go through its frame.
    setLastFrame({ originX: 2796, originY: -1080, scale: 1.5, display: 1 });
    const { cap, clicked } = await zoomThenClick(m, { x: 2900, y: -900, width: 800, height: 600 }, { x: 3300, y: -600 }, 1);
    expect(cap).toEqual({ x: 2900, y: -900, width: 800, height: 600 });
    expect(clicked).toEqual({ x: 3300, y: -600 });
  });

  it('Linux at scale 1: unchanged', async () => {
    on('linux');
    const m = machine(1.5, 1.5, false);
    const { cap, clicked } = await zoomThenClick(m, { x: 100, y: 200, width: 640, height: 400 }, { x: 420, y: 333 }, 1);
    expect(cap).toEqual({ x: 100, y: 200, width: 640, height: 400 });
    expect(clicked).toEqual({ x: 420, y: 333 });
  });

  it('an image-space region is untouched by the screen mapping (macOS 2x)', async () => {
    on('darwin');
    const m = machine(3.5, 1.75, false);
    await region.handler({ x: 100, y: 50, width: 200, height: 120 }, m.ctx);
    expect(m.captured[0]).toEqual({ x: 350, y: 175, width: 700, height: 420 });
  });
});
