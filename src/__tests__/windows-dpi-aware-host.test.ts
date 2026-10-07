/**
 * Windows clicks must land on target whether or not the HOST process is
 * DPI-aware.
 *
 * Live regression (Windows 11, 3840x2400 @ 225%, 2026-10): under a DPI-aware
 * host (Claude Desktop runs MCP extensions in an Electron utility process)
 * nut-js drives PHYSICAL px, but the adapter divided by the PowerShell-measured
 * ratio (2.25) anyway — every click landed at 1/2.25 of its target. The
 * PowerShell bridge itself stays DPI-unaware, so the foreground check must
 * still get LOGICAL coords.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const nut = vi.hoisted(() => ({ grabW: 3840, grabH: 2400, mouseW: 1707, osScale: 2.25, setPosition: vi.fn() }));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, click: vi.fn(), setPosition: nut.setPosition, getPosition: vi.fn(async () => ({ x: 400, y: 300 })) },
  keyboard: { config: {}, type: vi.fn() },
  screen: {
    grab: vi.fn(async () => ({ width: nut.grabW, height: nut.grabH, data: null })),
    width: vi.fn(async () => nut.mouseW),
  },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
// PowerShell (DPI-unaware) always reports the LOGICAL primary-screen size.
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: `${Math.round(nut.grabW / nut.osScale)},${Math.round(nut.grabH / nut.osScale)}`, stderr: '' }),
}));

import { WindowsAdapter } from '../platform/windows';

async function clickAt(x: number, y: number) {
  const adapter = new WindowsAdapter();
  const fg = vi.spyOn(adapter as never, 'ensureForegroundAtPoint').mockResolvedValue(undefined as never);
  await adapter.getScreenSize();
  await adapter.mouseClick(x, y);
  const [mx, my] = [nut.setPosition.mock.calls[0][0].x, nut.setPosition.mock.calls[0][0].y];
  return { mouse: { x: mx, y: my }, bridge: { x: (fg.mock.calls[0] as number[])[0], y: (fg.mock.calls[0] as number[])[1] } };
}

describe('WindowsAdapter.mouseClick under DPI-aware and DPI-unaware hosts', () => {
  beforeEach(() => { nut.setPosition.mockClear(); nut.grabW = 3840; nut.grabH = 2400; nut.osScale = 2.25; });

  it('DPI-unaware node: mouse and bridge both get logical coords (unchanged behaviour)', async () => {
    nut.mouseW = 1707;
    const r = await clickAt(1920, 1200);
    expect(r.mouse).toEqual({ x: 853, y: 533 });
    expect(r.bridge).toEqual({ x: 853, y: 533 });
  });

  it('DPI-aware host: mouse gets physical coords, bridge still gets logical', async () => {
    nut.mouseW = 3840;
    const r = await clickAt(1920, 1200);
    expect(r.mouse).toEqual({ x: 1920, y: 1200 });
    expect(r.bridge).toEqual({ x: 853, y: 533 });
  });

  it('100% scaling: identity everywhere', async () => {
    nut.grabW = 1920; nut.grabH = 1080; nut.mouseW = 1920; nut.osScale = 1;
    const r = await clickAt(500, 300);
    expect(r.mouse).toEqual({ x: 500, y: 300 });
    expect(r.bridge).toEqual({ x: 500, y: 300 });
  });

  it('relative moves take physical deltas like absolute ones (no 2.25x overshoot)', async () => {
    nut.mouseW = 1707;                       // DPI-unaware: driver is logical
    const adapter = new WindowsAdapter();
    await adapter.getScreenSize();
    await adapter.mouseMoveRelative(225, 450); // physical px
    expect(nut.setPosition.mock.calls[0][0]).toMatchObject({ x: 500, y: 500 }); // 400+100, 300+200
  });
});
