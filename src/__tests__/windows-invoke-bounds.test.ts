/**
 * Windows invokeElement must (1) surface the found element's bounds when the
 * bridge reports "found but no invoke/toggle/select pattern" and (2) normalize
 * controlType the same way findElements does.
 *
 * Live regression (Windows 11 / Edge / Azure portal, 2026-10): the bridge
 * answered {success:false, error:"No invoke/toggle/select pattern",
 * clickPoint:{x,y}} and the adapter returned a bare {success:false} — so the
 * caller could not coordinate-fallback even though `find` saw the Button.
 * And a prefixed "ControlType.Button" was forwarded raw, which the bridge's
 * $ctMap cannot match, silently dropping the role filter.
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
let reply: (payload: Record<string, unknown>) => unknown = () => ({});
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (payload: Record<string, unknown>) => { runCalls.push(payload); return Promise.resolve(reply(payload)); },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { WindowsAdapter } from '../platform/windows';

describe('WindowsAdapter.invokeElement — pattern miss surfaces bounds', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    runCalls.length = 0;
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
  });

  it('maps bridge bounds + clickPoint on a "no pattern" miss into res.bounds', async () => {
    reply = () => ({
      success: false, action: 'click', error: 'No invoke/toggle/select pattern',
      clickPoint: { x: 125, y: 210 }, bounds: { x: 100, y: 200, width: 50, height: 20 },
    });
    const res = await adapter.invokeElement({ name: 'Switch client type, Organizations', processId: 3292 });
    expect(res.success).toBe(false);
    expect(res.bounds).toEqual({ x: 100, y: 200, width: 50, height: 20 });
  });

  it('falls back to a point-sized rect when the bridge only reports clickPoint', async () => {
    reply = () => ({ success: false, error: 'No invoke/toggle/select pattern', clickPoint: { x: 125, y: 210 } });
    const res = await adapter.invokeElement({ name: 'X', processId: 3292 });
    expect(res.bounds).toEqual({ x: 125, y: 210, width: 1, height: 1 });
  });

  it('normalizes a prefixed controlType to the bare name the bridge can match', async () => {
    reply = () => ({ success: true });
    await adapter.invokeElement({ name: 'Save', controlType: 'ControlType.Button', processId: 1 });
    expect(runCalls[0].cmd).toBe('invoke-element');
    expect(runCalls[0].controlType).toBe('Button');
  });

  it('fails closed on a controlType the bridge cannot honor (parity with findElements)', async () => {
    reply = () => ({ success: true });
    const res = await adapter.invokeElement({ name: 'Save', controlType: 'ControlType.Bogus', processId: 1 });
    expect(res.success).toBe(false);
    expect(runCalls.find(c => c.cmd === 'invoke-element')).toBeUndefined();
  });
});

describe('WindowsAdapter.scrollIntoView — UIA ScrollItemPattern through the bridge', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    runCalls.length = 0;
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
  });

  it('sends scroll-into-view with the pid, name and last-seen bounds, and maps the new rect', async () => {
    reply = () => ({ success: true, action: 'scroll-into-view', method: 'ScrollItemPattern', bounds: { x: 10, y: 400, width: 300, height: 80 } });
    const bounds = { x: 10, y: 1500, width: 300, height: 80 };
    const res = await adapter.scrollIntoView({ name: 'Describe', processId: 7, bounds });
    expect(runCalls[0]).toEqual({ cmd: 'scroll-into-view', processId: 7, name: 'Describe', bounds });
    expect(res).toEqual({ success: true, method: 'ScrollItemPattern', bounds: { x: 10, y: 400, width: 300, height: 80 } });
  });

  it('passes the bound window handle, and maps the scrolled element\'s name and role back', async () => {
    reply = () => ({ success: true, method: 'ScrollItemPattern', name: 'Describe', role: 'ControlType.Edit', bounds: { x: 10, y: 400, width: 300, height: 80 } });
    const res = await adapter.scrollIntoView({ name: 'Describe', processId: 7, windowHandle: 4242, bounds: { x: 10, y: 1500, width: 300, height: 80 } });
    expect(runCalls[0].handle).toBe(4242);
    expect(res).toMatchObject({ success: true, name: 'Describe', role: 'ControlType.Edit' });
  });

  it('defaults to the foreground window\'s pid', async () => {
    reply = () => ({ success: true, method: 'SetFocus' });
    const res = await adapter.scrollIntoView({ name: 'Describe' });
    expect(runCalls[0].processId).toBe(42);
    expect(res).toEqual({ success: true, method: 'SetFocus' });   // no rect read: no bounds claimed
  });

  it('carries the bridge\'s reason on a miss, and a bridge failure is a failed scroll, not a throw', async () => {
    reply = () => ({ success: false, error: 'element not found in pid 42 (name=\'Describe\')' });
    expect(await adapter.scrollIntoView({ name: 'Describe' })).toEqual({ success: false, error: 'element not found in pid 42 (name=\'Describe\')' });
    reply = () => { throw new Error('bridge timeout'); };
    expect(await adapter.scrollIntoView({ name: 'Describe' })).toEqual({ success: false, error: 'bridge timeout' });
  });
});

describe('WindowsAdapter.invokeElement — the reason reaches the agent', () => {
  it('carries the bridge error and a late invoke failure in data', async () => {
    const adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
    reply = () => ({ success: false, error: 'No invoke/toggle/select pattern', lateInvokeError: 'Element not enabled', clickPoint: { x: 5, y: 6 } });
    const res = await adapter.invokeElement({ name: 'X', processId: 3292 });
    expect(res.data).toEqual({ error: 'No invoke/toggle/select pattern', lateInvokeError: 'Element not enabled' });
  });
});
