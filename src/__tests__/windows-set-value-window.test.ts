/**
 * Review of 1.5.27: the Windows set-value keyboard fallback compared the foreground window's PROCESS with the target's.
 * Two windows of one process (Explorer, Notepad, Edge) share a pid, so with the target in the background one, Ctrl+A and
 * the text went to the front window. It must compare the target's TOP-LEVEL window with the foreground window.
 * A keyboard set whose read-back is null is also unverified, not a success.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
import { buildUnifiedTools } from '../core/agent-loop/tools';

const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
const start = bridge.indexOf('# 2) Keyboard fallback');
const fallback = bridge.slice(start, bridge.indexOf('"get-value" {', start));

describe('ps-bridge set-value keyboard fallback', () => {
  it('compares the target\'s top-level window with the foreground window, not their processes', () => {
    expect(fallback).not.toMatch(/GetWindowThreadProcessId/);
    expect(fallback).not.toMatch(/Current\.ProcessId/);
    expect(fallback).toMatch(/ControlViewWalker/);
    // An owned window (Save As) is a UIA child of its owner: no walk to the desktop root, which would end at the owner.
    expect(fallback).not.toMatch(/Automation\]::Compare|RootElement/);
    expect(fallback).toMatch(/\$hwnd = \[int64\]\$up\.Current\.NativeWindowHandle\s*\n\s*if \(\$hwnd -ne 0\) \{ break \}/);  // nearest handled ancestor
    expect(fallback).toMatch(/GetAncestor\(\[IntPtr\]\$hwnd, 2\)/);                                          // GA_ROOT of the target's side
    expect(fallback).toMatch(/GetAncestor\(\[Win32UIA\]::GetForegroundWindow\(\), 2\)/);                      // and of the foreground's
  });

  it('refuses (the caller\'s click-and-type then runs) when the top-level window cannot be resolved or is not in front', () => {
    expect(fallback).toMatch(/\$topHwnd -eq 0 -or \$fgRoot -ne \$topHwnd/);
    // the check comes before any key is sent
    expect(fallback.indexOf('$fgRoot -ne $topHwnd')).toBeLessThan(fallback.indexOf('SendWait("^a")'));
  });

  it('a null read-back after typing is reported unverified, not as a plain success', () => {
    expect(fallback).not.toMatch(/-eq \$value -or \$null -eq \$after/);
    expect(fallback).toMatch(/if \(\$null -eq \$after\) \{ return @\{ success=\$true; unverified=\$true;/);
  });
});

describe('an unverified keyboard set-value reaches the agent as such', () => {
  it('the adapter passes the bridge\'s unverified flag in data', async () => {
    reply = { success: true, unverified: true, action: 'set-value', method: 'keyboard' };
    const res = await new WindowsAdapter().invokeElement({ name: 'Name', processId: 7, action: 'set-value', value: 'x' });
    expect(res).toMatchObject({ success: true, data: { unverified: true } });
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
