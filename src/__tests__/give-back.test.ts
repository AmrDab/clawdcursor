/**
 * Rung 0 by name (UIA SetValue / Invoke) can take the foreground in Notepad, Edge and Calculator (own-window probe,
 * 2026-11-16). A by-name act on a process that is NOT in front must give the user's window back when the act took it.
 */
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
let restored = true;
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (p: Record<string, unknown>) => {
      runCalls.push(p);
      return Promise.resolve(p.cmd === 'restore-foreground' ? { success: restored, restored } : { success: true });
    },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { WindowsAdapter } from '../platform/windows';

const USER = { processId: 10, handle: 500 };
const TARGET = { processId: 42, handle: 900 };

describe('by-name act gives the user\'s window back', () => {
  let adapter: WindowsAdapter;
  let fgReads: Array<{ processId: number; handle: number }>;
  beforeEach(() => {
    runCalls.length = 0;
    restored = true;
    adapter = new WindowsAdapter();
    fgReads = [];
    vi.spyOn(adapter, 'getActiveWindow').mockImplementation(async () => (fgReads.shift() ?? null) as never);
  });
  const restores = () => runCalls.filter(c => c.cmd === 'restore-foreground');

  it('the act took the foreground: restores the window that was in front, and says so', async () => {
    fgReads = [USER, TARGET];
    const res = await adapter.invokeElement({ name: 'Search', processId: 42, action: 'set-value', value: 'x' });
    expect(res.success).toBe(true);
    expect(restores()).toEqual([{ cmd: 'restore-foreground', handle: 500 }]);
    expect(res.data?.gaveBack).toBe(true);
  });

  it('the restore did not take: no claim that it did', async () => {
    restored = false;
    fgReads = [USER, TARGET];
    const res = await adapter.invokeElement({ name: 'Search', processId: 42, action: 'click' });
    expect(restores()).toHaveLength(1);
    expect(res.data?.gaveBack).not.toBe(true);
  });

  it('the foreground did not move: nothing to give back', async () => {
    fgReads = [USER, USER];
    const res = await adapter.invokeElement({ name: 'Search', processId: 42, action: 'toggle' });
    expect(restores()).toEqual([]);
    expect(res.data?.gaveBack).toBeUndefined();
  });

  it('the target was already in front: its foreground is the user\'s, nothing is recorded or restored', async () => {
    fgReads = [TARGET, TARGET];
    await adapter.invokeElement({ name: 'Search', processId: 42, action: 'select' });
    expect(restores()).toEqual([]);
  });

  it('reading a value never touches the foreground', async () => {
    fgReads = [USER, TARGET];
    await adapter.invokeElement({ name: 'Search', processId: 42, action: 'get-value' });
    expect(restores()).toEqual([]);
    expect(runCalls.map(c => c.cmd)).toEqual(['invoke-element']);
  });
});

describe('the adapter keeps what it did for the tool result', () => {
  it('takeRouteNote says "gave your window back" once, after the act that did', async () => {
    runCalls.length = 0;
    const adapter = new WindowsAdapter();
    const reads = [USER, TARGET];
    vi.spyOn(adapter, 'getActiveWindow').mockImplementation(async () => (reads.shift() ?? null) as never);
    await adapter.invokeElement({ name: 'Search', processId: 42, action: 'click' });
    expect(adapter.takeRouteNote()).toBe('R0 by name, gave your window back');
    expect(adapter.takeRouteNote()).toBeNull();
  });

  it('names the rung and that focus did not move, and when it moved and could not be given back', async () => {
    for (const [reads, ok, note] of [
      [[USER, USER], true, 'R0 by name, focus not moved'],
      [[USER, TARGET], false, 'R0 by name, but it took the foreground and your window could not be put back'],
      [[TARGET, TARGET], true, null],   // the target was in front already: nothing to say
    ] as const) {
      restored = ok;
      const adapter = new WindowsAdapter();
      const q = [...reads];
      vi.spyOn(adapter, 'getActiveWindow').mockImplementation(async () => (q.shift() ?? null) as never);
      await adapter.invokeElement({ name: 'Search', processId: 42, action: 'click' });
      expect(adapter.takeRouteNote()).toBe(note);
    }
  });
});
