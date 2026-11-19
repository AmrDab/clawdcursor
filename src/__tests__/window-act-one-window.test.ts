/**
 * close / minimize / focus act on ONE window, named in the reply (audit 2026-11-19, item 20).
 *  - every given field must match (AND): close {processName:"chrome", title:"Restore pages?"} is the dialog, never the first
 *    chrome window;
 *  - two or more matches is an error that lists them;
 *  - close waits about a second and says closed or still open;
 *  - Linux closes by window id (wmctrl -c <text> closes the first window containing the text).
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
vi.mock('../sleep', () => ({ sleep: vi.fn(async () => {}) }));

type Call = { cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };
const calls: Call[] = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: Call['opts'], cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
    calls.push({ cmd, args, opts });
    cb(null, { stdout: 'ok', stderr: '' });
  },
  spawn: vi.fn(),
  execSync: vi.fn(),
}));
const run = vi.fn();
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: (c: unknown) => run(c), start: vi.fn(), stop: vi.fn() } }));

import { WindowsAdapter } from '../platform/windows';
import { matchWindows, selectionProblem } from '../platform/window-match';
import type { WindowInfo } from '../platform/types';

const win = (title: string, processName: string, processId: number, handle: number): WindowInfo =>
  ({ title, processName, processId, handle, bounds: { x: 0, y: 0, width: 100, height: 100 }, isMinimized: false });
const MAIN = win('Inbox - Google Chrome', 'chrome', 10, 1001);
const DIALOG = win('Restore pages?', 'chrome', 10, 1002);
const OTHER = win('Restore pages?', 'notepad', 20, 2001);
const TWO_CHROME = win('Docs - Google Chrome', 'chrome', 10, 1003);

describe('matchWindows — every given field must match', () => {
  it('process name AND title pick the dialog, not the first window of the process', () => {
    expect(matchWindows([MAIN, DIALOG, OTHER], { processName: 'chrome', title: 'Restore pages?' })).toEqual([DIALOG]);
  });
  it('a title or process alone can match several; a selector with no fields matches nothing', () => {
    expect(matchWindows([MAIN, DIALOG, OTHER], { title: 'restore pages' })).toEqual([DIALOG, OTHER]);
    expect(matchWindows([MAIN, DIALOG, OTHER], {})).toEqual([]);
  });
  it('says nothing matched, or lists the several that did', () => {
    expect(selectionProblem({ processName: 'chrome', title: 'Nope' }, [])).toBe('No open window matches processName "chrome" and title "Nope".');
    const several = selectionProblem({ processName: 'chrome' }, [MAIN, TWO_CHROME])!;
    expect(several).toContain('2 windows match processName "chrome"');
    expect(several).toContain('"Inbox - Google Chrome" [chrome] pid:10');
    expect(several).toContain('"Docs - Google Chrome" [chrome] pid:10');
    expect(selectionProblem({ processName: 'chrome' }, [MAIN])).toBeNull();
  });
});

describe('WindowsAdapter — close, minimize and focus act on one named window', () => {
  let adapter: WindowsAdapter;
  let listed: WindowInfo[];
  const psCalls = () => calls.filter(c => /powershell/i.test(c.cmd));
  beforeEach(() => {
    calls.length = 0; run.mockReset();
    adapter = new WindowsAdapter();
    listed = [MAIN, DIALOG, OTHER];
    vi.spyOn(adapter, 'listWindows').mockImplementation(async () => listed);
  });

  it('close posts to the dialog handle, then says it is closed once it is gone from the list', async () => {
    const afterClose = [MAIN, OTHER];
    vi.mocked(adapter.listWindows).mockResolvedValueOnce(listed).mockResolvedValue(afterClose);
    expect(await adapter.setWindowState('close', { processName: 'chrome', title: 'Restore pages?' })).toBe(true);
    expect(psCalls()[0].args.join(' ')).toContain('$h = [IntPtr]1002;');
    expect(adapter.takeWindowNote()).toBe('Closed "Restore pages?" [chrome] pid:10.');
    expect(adapter.takeWindowNote()).toBeNull();
  });

  it('close says the window is still open when it is still in the list after the wait', async () => {
    expect(await adapter.setWindowState('close', { processName: 'chrome', title: 'Restore pages?' })).toBe(true);
    expect(adapter.takeWindowNote()).toMatch(/^Sent close to "Restore pages\?" \[chrome\] pid:10, but it is still open after 1 s/);
  });

  it('two matches: nothing is closed, and the reply lists both', async () => {
    expect(await adapter.setWindowState('close', { processName: 'chrome' })).toBe(false);
    expect(psCalls()).toHaveLength(0);
    const note = adapter.takeWindowNote()!;
    expect(note).toMatch(/^2 windows match processName "chrome"/);
    expect(note).toContain('Inbox - Google Chrome');
    expect(note).toContain('Restore pages?');
  });

  it('no match: nothing runs and the reply says what was asked for', async () => {
    expect(await adapter.setWindowState('minimize', { processName: 'chrome', title: 'Nope' })).toBe(false);
    expect(psCalls()).toHaveLength(0);
    expect(adapter.takeWindowNote()).toBe('No open window matches processName "chrome" and title "Nope".');
  });

  it('minimize acts on the resolved handle and does not look the window up again by its title', async () => {
    expect(await adapter.setWindowState('minimize', { processName: 'chrome', title: 'Inbox' })).toBe(true);
    expect(psCalls()[0].opts.env?.CLAWD_PS_TITLE).toBe('');
    expect(psCalls()[0].args.join(' ')).toContain('$h = [IntPtr]1001;');
    expect(adapter.takeWindowNote()).toBe('Minimized window "Inbox - Google Chrome" [chrome] pid:10.');
  });

  it('focus with a title two windows hold is an error that lists them, and the bridge is not asked', async () => {
    expect(await adapter.focusWindow({ processName: 'chrome', title: 'e' })).toBe(false);
    expect(adapter.takeFocusFailure()).toMatch(/windows match processName "chrome" and title "e"/);
    expect(run.mock.calls.filter(c => (c[0] as { cmd: string }).cmd === 'focus-window')).toHaveLength(0);
  });

  it('focus by an app name alone brings up its first window and names it (not an error)', async () => {
    run.mockResolvedValue({ success: true, foreground: true, processId: 10, title: 'Inbox - Google Chrome' });
    expect(await adapter.focusWindow({ processName: 'chrome' })).toBe(true);
    expect(adapter.takeWindowNote()).toContain('Inbox - Google Chrome');
  });

  it('focus by a pid alone still goes to the process (callers that re-focus an app they used): no list error', async () => {
    run.mockResolvedValue({ success: true, foreground: true, processId: 10, title: 'Inbox - Google Chrome' });
    expect(await adapter.focusWindow({ processId: 10 })).toBe(true);
    expect(run).toHaveBeenCalledWith({ cmd: 'focus-window', restore: true, processId: 10 });
  });

  it('focus with pid and title that match one window focuses that handle and names it', async () => {
    run.mockResolvedValue({ success: true, foreground: true, processId: 10, title: 'Restore pages?' });
    expect(await adapter.focusWindow({ processId: 10, title: 'Restore pages?' })).toBe(true);
    expect(run).toHaveBeenCalledWith({ cmd: 'focus-window', restore: true, handle: 1002 });
    expect(adapter.takeWindowNote()).toBe('Focused window "Restore pages?" [chrome] pid:10.');
  });
});
