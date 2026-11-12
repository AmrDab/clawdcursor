/**
 * Under the test fence a window call reaches the platform as an exact window HANDLE (core/fence.ts pins it), never as a
 * title to search for: the bridge's focus-window takes "the first title that CONTAINS the text", and a Store app's host
 * process owns the windows of every Store app. This file follows the handle from the tool to the bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn() } }));

import { psRunner } from '../platform/ps-runner';
import { WindowsAdapter } from '../platform/windows';
import { getTools } from '../tools/registry';
import type { ToolContext } from '../tools/types';

const run = vi.mocked(psRunner.run);
const sent = () => run.mock.calls.map(c => c[0] as Record<string, unknown>);

beforeEach(() => { run.mockReset(); });

describe('the bridge: focus-window with a handle', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
  const start = bridge.indexOf('function Cmd-FocusWindow');
  const fn = bridge.slice(start, bridge.indexOf('\nfunction ', start + 10));
  const handleBranch = fn.slice(fn.indexOf('if ($handle -ne 0)'), fn.indexOf('elseif ($wpid -gt 0 -and $title -ne "")'));

  it('matches the window whose native handle EQUALS it, before any pid or title matching', () => {
    expect(fn).toContain('$handle = if ($cmd.handle) { [int64]$cmd.handle } else { 0 }');
    expect(handleBranch).toContain('[int64]$w.Current.NativeWindowHandle -eq $handle');
    expect(fn.indexOf('if ($handle -ne 0)')).toBeLessThan(fn.indexOf('.Contains($tl)'));
    // The pid and title branches are an elseif of it: with a handle they do not run.
    expect(fn).toMatch(/\}\s*(#[^\n]*\n\s*)*elseif \(\$wpid -gt 0 -and \$title -ne ""\)/);
  });

  it('has no title search and no fallback to the process: a handle that is not there is "not found"', () => {
    expect(handleBranch).not.toMatch(/Contains|ConvertTo-TitleKey|ProcessId/);
    expect(handleBranch).toContain('return @{ success=$false; error="Window not found: handle=$handle" }');
  });
});

describe('the Windows adapter', () => {
  const adapter = () => new WindowsAdapter();

  it('focusWindow with a handle sends the handle and nothing else to search by', async () => {
    run.mockResolvedValue({ success: true, foreground: true, processId: 300, title: 'Calculator' });
    expect(await adapter().focusWindow({ handle: 7003, title: 'Calculator', processId: 300, processName: 'ApplicationFrameHost' })).toBe(true);
    const focus = sent().filter(c => c.cmd === 'focus-window');
    expect(focus).toEqual([{ cmd: 'focus-window', restore: true, handle: 7003 }]);
  });

  it('a handle that is not a positive integer is refused before the bridge is asked', async () => {
    for (const handle of [0, -5, 12.5, NaN]) expect(await adapter().focusWindow({ handle })).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('without a handle it sends the title and the pid as before', async () => {
    run.mockResolvedValue({ success: true, foreground: true });
    await adapter().focusWindow({ title: 'Notepad', processId: 42 });
    expect(sent().filter(c => c.cmd === 'focus-window')).toEqual([{ cmd: 'focus-window', restore: true, title: 'Notepad', processId: 42 }]);
  });
});

describe('the window tools', () => {
  const focusWindow = vi.fn(async (_q: Record<string, unknown>) => true);
  const setWindowState = vi.fn(async (_s: string, _q?: Record<string, unknown>) => true);
  const setWindowBounds = vi.fn(async (_b: object, _q?: Record<string, unknown>) => true);
  const ctx = { ensureInitialized: async () => {}, platform: { focusWindow, setWindowState, setWindowBounds, takeFocusFailure: () => null,
    getActiveWindow: async () => null, listWindows: async () => [] } } as unknown as ToolContext;
  const tool = (name: string) => getTools().find(t => t.name === name)!;

  beforeEach(() => { focusWindow.mockClear(); setWindowState.mockClear(); setWindowBounds.mockClear(); });

  it('given a handle, focus_window asks the platform for that handle alone', async () => {
    await tool('focus_window').handler({ handle: 7001, title: 'Bench Dialog', processId: 101 }, ctx);
    expect(focusWindow).toHaveBeenCalledWith({ handle: 7001 });
  });

  it('so do close, minimize, maximize, restore and resize', async () => {
    for (const name of ['close_window', 'minimize_window_to_taskbar', 'maximize_window', 'restore_window']) {
      await tool(name).handler({ handle: 7001, title: 'Bench Dialog' }, ctx);
    }
    expect(setWindowState.mock.calls.map(c => c[1])).toEqual([{ handle: 7001 }, { handle: 7001 }, { handle: 7001 }, { handle: 7001 }]);
    await tool('resize_window').handler({ handle: 7001, title: 'Bench Dialog', width: 800, height: 600 }, ctx);
    expect(setWindowBounds.mock.calls[0][1]).toEqual({ handle: 7001 });
  });

  it('without a handle nothing changes: the title and the process are passed as before', async () => {
    await tool('focus_window').handler({ title: 'Notepad', processId: 42 }, ctx);
    expect(focusWindow).toHaveBeenCalledWith({ title: 'Notepad', processId: 42 });
  });
});
