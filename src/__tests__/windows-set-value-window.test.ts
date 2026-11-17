/**
 * Review of 1.5.27: the Windows set-value keyboard fallback compared the foreground window's PROCESS with the target's.
 * Two windows of one process (Explorer, Notepad, Edge) share a pid, so with the target in the background one, Ctrl+A and
 * the text went to the front window. It must compare the target's TOP-LEVEL window with the foreground window.
 * A keyboard set whose read-back is null is also unverified, not a success. The bridge side is run for real in
 * windows-set-value-window.system.test.ts; this file is the adapter and the tool.
 */
import { describe, it, expect, vi } from 'vitest';

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
let reply: unknown = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: () => Promise.resolve(reply), start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';
import { buildUnifiedTools } from '../tools/projected/tools';

describe('an unverified keyboard set-value reaches the agent as such', () => {
  it('the adapter passes the bridge\'s unverified flag in data', async () => {
    reply = { success: true, unverified: true, action: 'set-value', method: 'keyboard' };
    const res = await new WindowsAdapter().invokeElement({ name: 'Name', processId: 7, action: 'set-value', value: 'x' });
    expect(res).toMatchObject({ success: true, data: { unverified: true } });
  });

  it('get-value: an empty field is "" with readable true; a Spinner reads its number; a password box is not readable', async () => {
    const get = (name: string) => new WindowsAdapter().invokeElement({ name, processId: 7, action: 'get-value' });
    reply = { success: true, action: 'get-value', value: '', method: 'ValuePattern', readable: true };
    expect((await get('Your name')).data).toMatchObject({ value: '', method: 'ValuePattern', readable: true });
    reply = { success: true, action: 'get-value', value: '100', method: 'RangeValuePattern', readable: true };
    expect((await get('Quantity')).data).toMatchObject({ value: '100', method: 'RangeValuePattern', readable: true });
    reply = { success: true, action: 'get-value', value: '', method: 'Password', readable: false, secure: true };
    expect((await get('Password')).data).toMatchObject({ value: '', readable: false, secure: true });
    reply = { success: true, action: 'get-value', value: 'Send', method: 'Name', readable: false };
    expect((await get('Send')).data).toMatchObject({ value: 'Send', method: 'Name', readable: false });
  });

  it('set_field_value says it was not verified', async () => {
    const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
    const ctx = { platform: { platform: 'win32', findElements: async () => [], getFocusedElement: async () => null,
      invokeElement: async () => ({ success: true, data: { unverified: true } }) } } as never;
    const r = await tool.execute({ name: 'Name', value: 'hello', processId: 7 }, ctx);
    expect(r.text).toMatch(/NOT verified/);
    expect(r.text).not.toMatch(/read back ✓/);
  });
});
