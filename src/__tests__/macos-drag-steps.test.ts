/**
 * Dragging on macOS: `mouse_down`, `mouse_move`, `mouse_up` and the stepped / path drags made one jump per point with no
 * hold after the press. A held button now holds 80 ms after the press, and every move glides in steps of at most 18 px,
 * 10 ms apart (as mouseDrag always did).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const nut = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: {
    config: {},
    setPosition: vi.fn(async (p: { x: number; y: number }) => { nut.events.push(`move ${p.x},${p.y}`); }),
    pressButton: vi.fn(async () => { nut.events.push('down'); }),
    releaseButton: vi.fn(async () => { nut.events.push('up'); }),
  },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { MacOSAdapter } from '../platform/macos';
import type { MacAx } from '../platform/mac-ax';

const mac = new MacOSAdapter({ ax: { frontmost: vi.fn(), prepare: vi.fn() } as unknown as MacAx });
const moves = () => nut.events.filter(e => e.startsWith('move ')).map(e => e.slice(5).split(',').map(Number) as [number, number]);

beforeEach(() => { nut.events.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

/** Run an adapter call with fake timers advancing, and return what it logged. */
async function run(p: Promise<unknown>) {
  const done = p.then(() => true);
  for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(20);
  await done;
}

describe('a held button', () => {
  it('mouse_down waits 80 ms before returning, so the first move is not part of the press', async () => {
    let returned = false;
    const p = mac.mouseDown('left').then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(79);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(returned).toBe(true);
  });

  it('a move while held glides: no step is longer than 18 px, and the last is the target', async () => {
    await run(mac.mouseMove(100, 100));
    await run(mac.mouseDown('left'));
    nut.events.length = 0;
    await run(mac.mouseMove(300, 100));
    const m = moves();
    expect(m.length).toBeGreaterThan(10);
    let prev: [number, number] = [100, 100];
    for (const p of m) { expect(Math.hypot(p[0] - prev[0], p[1] - prev[1])).toBeLessThanOrEqual(18); prev = p; }
    expect(m[m.length - 1]).toEqual([300, 100]);
    await run(mac.mouseUp('left'));
  });

  it('a path (several segments) glides through each of its points in order', async () => {
    await run(mac.mouseMove(0, 0));
    await run(mac.mouseDown('left'));
    nut.events.length = 0;
    await run(mac.mouseMove(90, 0));
    await run(mac.mouseMove(90, 90));
    const m = moves();
    expect(m).toContainEqual([90, 0]);
    expect(m[m.length - 1]).toEqual([90, 90]);
    expect(m.every((p, i) => i === 0 || Math.hypot(p[0] - m[i - 1][0], p[1] - m[i - 1][1]) <= 18)).toBe(true);
    await run(mac.mouseUp('left'));
  });

  it('after mouse_up a move is one jump again', async () => {
    await run(mac.mouseMove(0, 0));
    await run(mac.mouseDown('left'));
    await run(mac.mouseUp('left'));
    nut.events.length = 0;
    await run(mac.mouseMove(500, 500));
    expect(moves()).toEqual([[500, 500]]);
  });

  it('a short move is one step', async () => {
    await run(mac.mouseMove(0, 0));
    await run(mac.mouseDown('left'));
    nut.events.length = 0;
    await run(mac.mouseMove(10, 0));
    expect(moves()).toEqual([[10, 0]]);
    await run(mac.mouseUp('left'));
  });
});
