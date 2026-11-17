/**
 * The "desktop control in progress" pill sits at the top centre — where browsers keep their tab strip and address bar —
 * and takes mouse events, so an agent's click under it hit the pill (live macOS 2026-10-19: 0 clicks reached a target
 * under it; reproduced on Windows 11 with 1.5.17). Before every synthetic press the pill is told `HIDE <ms>` and steps
 * aside; it comes back by itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(async () => {}), click: vi.fn(async () => { order.push('click'); }), setPosition: vi.fn(async () => {}), pressButton: vi.fn(async () => {}), releaseButton: vi.fn(async () => {}) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Point: class { constructor(public x: number, public y: number) {} },
  straightTo: vi.fn(),
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
const order = vi.hoisted(() => [] as string[]);

import { controlBanner } from '../core/banner';
import { beforePointerPress, setBeforePointerPress } from '../platform/pointer-guard';
import { MacOSAdapter } from '../platform/macos';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  written = '';
  killed = false;
  constructor() { super(); this.stdin.on('data', d => { this.written += String(d); }); }
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

let pills: FakeChild[];

beforeEach(() => {
  pills = [];
  order.length = 0;
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => { const c = new FakeChild(); pills.push(c); return c as unknown as ChildProcess; });
  controlBanner.__setGlowSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
});
afterEach(() => { controlBanner.__resetForTests(); });

describe('the pill steps aside for an agent\'s click', () => {
  it('dodge() tells the pill HIDE <ms> on its stdin and waits for it to be gone', async () => {
    controlBanner.pin();
    const t0 = Date.now();
    await controlBanner.dodge();
    expect(pills[0].written).toBe('HIDE 1500\n');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it('no pill (hidden, disabled, or exited): dodge does nothing and never throws', async () => {
    await expect(controlBanner.dodge()).resolves.toBeUndefined();
    controlBanner.pin();
    pills[0].stdin.destroy();
    await expect(controlBanner.dodge()).resolves.toBeUndefined();
  });

  it('the banner registers itself as the before-press hook', async () => {
    controlBanner.pin();
    await beforePointerPress();
    expect(pills[0].written).toBe('HIDE 1500\n');
  });

  it('the hook runs BEFORE the press, inside the platform adapter', async () => {
    const hook = vi.fn(async () => { order.push('dodge'); });
    setBeforePointerPress(hook);
    try {
      const mac = new MacOSAdapter({ ax: { prepare: vi.fn(), frontmost: vi.fn() } as never });
      await mac.mouseClick(100, 100);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(order[0]).toBe('dodge');
      expect(order).toContain('click');
    } finally {
      setBeforePointerPress(() => controlBanner.dodge());
    }
  });

  it('a failing hook never stops the click', async () => {
    setBeforePointerPress(async () => { throw new Error('pill gone'); });
    try {
      await expect(beforePointerPress()).resolves.toBeUndefined();
    } finally {
      setBeforePointerPress(() => controlBanner.dodge());
    }
  });
});
