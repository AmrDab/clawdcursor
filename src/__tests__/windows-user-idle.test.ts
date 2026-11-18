/** WindowsAdapter.userIdle / cursorPos: what the burst (foreground-burst.ts) reads to wait for the user and to put the cursor back. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const calls: string[] = [];
let reply: Record<string, Record<string, unknown>> = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: (p: { cmd: string }) => { calls.push(p.cmd); return Promise.resolve(reply[p.cmd] ?? {}); }, start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';

describe('WindowsAdapter user idle and cursor', () => {
  beforeEach(() => { calls.length = 0; });

  it('userIdle: the tick of the last input and how long ago, from ps-bridge get-idle', async () => {
    reply = { 'get-idle': { success: true, tick: 123456, idleMs: 2500 } };
    expect(await new WindowsAdapter().userIdle()).toEqual({ tick: 123456, idleMs: 2500 });
    expect(calls).toEqual(['get-idle']);
  });

  it('userIdle: null when the bridge cannot say', async () => {
    reply = { 'get-idle': { error: 'x' } };
    expect(await new WindowsAdapter().userIdle()).toBeNull();
  });

  it('cursorPos: the real cursor, physical pixels', async () => {
    reply = { 'get-cursor': { success: true, x: 10, y: 20 } };
    expect(await new WindowsAdapter().cursorPos()).toEqual({ x: 10, y: 20 });
  });
});
