/**
 * Windows clicks must land on target on ANY monitor, whatever the host
 * process's DPI awareness.
 *
 * - The pointer is placed through the PowerShell bridge (per-monitor-v2,
 *   PHYSICAL virtual-desktop px): nut-js normalises absolute moves to the
 *   primary display only, so it cannot reach a second monitor at all.
 * - The foreground check gets the same physical point (`physical: true`).
 * - If the bridge is down, nut-js is the fallback (primary display): it must
 *   still convert physical → its driver space, measured in-process (a
 *   DPI-aware host drives physical px, a DPI-unaware node logical px — the
 *   live 2026-10 bug landed every click at 1/2.25 of its target).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const nut = vi.hoisted(() => ({ grabW: 3840, grabH: 2400, mouseW: 1707, osScale: 2.25, setPosition: vi.fn() }));
const bridge = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, up: true, cursor: { x: 400, y: 300 } }));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, click: vi.fn(), pressButton: vi.fn(), releaseButton: vi.fn(), setPosition: nut.setPosition, getPosition: vi.fn(async () => ({ x: 400, y: 300 })) },
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
// The real bridge would move the real pointer — never in tests.
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: vi.fn(async (cmd: Record<string, unknown>) => {
      bridge.calls.push(cmd);
      if (!bridge.up) throw new Error('bridge down');
      if (cmd.cmd === 'move-cursor') { bridge.cursor = { x: cmd.x as number, y: cmd.y as number }; return { success: true, ...bridge.cursor }; }
      if (cmd.cmd === 'get-cursor') return { success: true, ...bridge.cursor };
      if (cmd.cmd === 'activate-at-point') return { success: true, action: 'noop' };
      return { success: true };
    }),
    start: vi.fn(), stop: vi.fn(),
  },
}));
// PowerShell (DPI-unaware) always reports the LOGICAL primary-screen size.
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: `${Math.round(nut.grabW / nut.osScale)},${Math.round(nut.grabH / nut.osScale)}`, stderr: '' }),
}));

import { WindowsAdapter } from '../platform/windows';

const sent = (cmd: string) => bridge.calls.filter(c => c.cmd === cmd);

beforeEach(() => {
  nut.setPosition.mockClear(); nut.grabW = 3840; nut.grabH = 2400; nut.osScale = 2.25; nut.mouseW = 1707;
  bridge.calls.length = 0; bridge.up = true; bridge.cursor = { x: 400, y: 300 };
});

describe('WindowsAdapter pointer placement — any monitor', () => {
  it('a click goes to the PHYSICAL point through the bridge; the foreground check gets the same physical point', async () => {
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseClick(1920, 1200);
    expect(sent('activate-at-point')[0]).toMatchObject({ x: 1920, y: 1200, physical: true });
    expect(sent('move-cursor')[0]).toMatchObject({ x: 1920, y: 1200 });
    expect(nut.setPosition).not.toHaveBeenCalled();
  });

  it('a second monitor left of / above the primary (negative coords) is reachable', async () => {
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseClick(-1500, -300);
    expect(sent('move-cursor')[0]).toMatchObject({ x: -1500, y: -300 });
  });

  it('drag waypoints are all physical bridge moves', async () => {
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseDrag(4000, 100, 4400, 100);   // e.g. on a monitor right of the primary
    const moves = sent('move-cursor');
    expect(moves[0]).toMatchObject({ x: 4000, y: 100 });
    expect(moves[moves.length - 1]).toMatchObject({ x: 4400, y: 100 });
  });

  it('relative moves add physical deltas to the physical cursor', async () => {
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseMoveRelative(225, 450);
    expect(sent('move-cursor')[0]).toMatchObject({ x: 625, y: 750 });
  });
});

describe('fallback when the bridge is down (nut-js, primary display)', () => {
  beforeEach(() => { bridge.up = false; });

  it('DPI-unaware node: nut-js gets logical coords', async () => {
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseClick(1920, 1200);
    expect(nut.setPosition.mock.calls[0][0]).toMatchObject({ x: 853, y: 533 });
  });

  it('DPI-aware host: nut-js gets physical coords', async () => {
    nut.mouseW = 3840;
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseClick(1920, 1200);
    expect(nut.setPosition.mock.calls[0][0]).toMatchObject({ x: 1920, y: 1200 });
  });

  it('100% scaling: identity', async () => {
    nut.grabW = 1920; nut.grabH = 1080; nut.mouseW = 1920; nut.osScale = 1;
    const a = new WindowsAdapter();
    await a.getScreenSize();
    await a.mouseClick(500, 300);
    expect(nut.setPosition.mock.calls[0][0]).toMatchObject({ x: 500, y: 300 });
  });
});
