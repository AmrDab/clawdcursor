/** WindowsAdapter.deliverToWindow: rung R1, one adapter method over ps-bridge `deliver-to-window`. */
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

const runCalls: Array<Record<string, unknown>> = [];
let reply: Record<string, unknown> = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: (p: Record<string, unknown>) => { runCalls.push(p); return Promise.resolve(reply); }, start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';
import { GUARDED_METHODS } from '../platform/pointer-guard';

describe('WindowsAdapter.deliverToWindow', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => { runCalls.length = 0; adapter = new WindowsAdapter(); });

  it('passes the target and exactly one input to the bridge, and says it was verified', async () => {
    reply = { success: true, rung: 'R1', method: 'WM_CHAR', verified: true };
    const r = await adapter.deliverToWindow({ processId: 42, name: 'Notes' }, { text: 'hi' });
    expect(runCalls).toEqual([{ cmd: 'deliver-to-window', processId: 42, name: 'Notes', text: 'hi' }]);
    expect(r).toEqual({ success: true, method: 'WM_CHAR', verified: true });
  });

  it('an elevated target is its own failure, with the bridge\'s reason', async () => {
    reply = { success: false, reason: 'uipi', error: 'the window runs elevated' };
    expect(await adapter.deliverToWindow({ handle: 7 }, { click: true })).toEqual({ success: false, reason: 'uipi', error: 'the window runs elevated' });
    expect(runCalls).toHaveLength(1);
  });

  it('says it cannot when the bridge fails, rather than throwing', async () => {
    reply = {};
    expect(await adapter.deliverToWindow({ processId: 1 }, { setText: 'x' })).toMatchObject({ success: false });
  });

  it('is stopped when the user stops clawdcursor, like every other act that does not go through the front window', () => {
    expect(GUARDED_METHODS.deliverToWindow?.kind).toBe('background');
  });
});
