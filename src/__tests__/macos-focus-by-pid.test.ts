/**
 * focus_window on macOS, with two processes of one app (the user's Chrome and the agent's own).
 *
 * Found by the live blind run of 2026-10-19: `window focus {processId: <the agent's Chrome>}` replied "Focused matching window."
 * and the USER's Chrome came to the front; `{title: "canvas only"}` for a window that existed replied "No matching window found."
 * System Events names an app's windows by process NAME, so focus-window.jxa read the first Chrome's windows whatever pid it got.
 * The adapter now asks the accessibility helper (by pid), looks a title up among the windows of the process it names, and
 * checks who really is frontmost afterwards — a focus that went elsewhere is an error that says where.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const execCalls: Array<{ cmd: string; args: string[] }> = [];
let jxaReply = '{"success":true,"title":"x","processId":1,"processName":"x"}';
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    execCalls.push({ cmd, args });
    cb(null, { stdout: jxaReply, stderr: '' });
  },
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';
import { MacAxError, type MacAx, type FrontmostInfo } from '../platform/mac-ax';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { WindowInfo } from '../platform/types';

const RECT = { x: 0, y: 0, width: 600, height: 400 };
const WIN = (over: Partial<WindowInfo> = {}): WindowInfo =>
  ({ title: 'Untitled', processName: 'Google Chrome', processId: 935, bounds: RECT, isMinimized: false, handle: 935, ...over });
const FRONT = (name: string, processId: number): FrontmostInfo => ({ locked: false, app: { name, processId, activationPolicy: 'regular', windows: [] } });

function fakeAx(over: Partial<Record<keyof MacAx, unknown>> = {}) {
  return {
    listWindows: vi.fn(async () => [WIN({ title: 'Hermes Agent - Google Chrome', processId: 935 }), WIN({ title: 'Clawd canvas only - Google Chrome', processId: 54172 })]),
    listWindowsDetailed: vi.fn(async () => ({ windows: [WIN({ title: 'Hermes Agent - Google Chrome', processId: 935 }), WIN({ title: 'Clawd canvas only - Google Chrome', processId: 54172 })], skipped: [] })),
    focusWindow: vi.fn(async (pid: number, title?: string) => ({ title: title ?? 'w', processId: pid, processName: 'Google Chrome' })),
    frontmost: vi.fn(async () => FRONT('Google Chrome', 54172)),
    appState: vi.fn(async () => null),
    prepare: vi.fn(),
    ...over,
  } as unknown as MacAx & { focusWindow: ReturnType<typeof vi.fn>; frontmost: ReturnType<typeof vi.fn> };
}
const osascripts = () => execCalls.filter(c => c.cmd === 'osascript');

beforeEach(() => { execCalls.length = 0; jxaReply = '{"success":true,"title":"x","processId":1,"processName":"x"}'; });

describe('focusWindow by process id', () => {
  it('asks the accessibility helper for THAT pid — no System Events script is run', async () => {
    const ax = fakeAx();
    await expect(new MacOSAdapter({ ax }).focusWindow({ processId: 54172, title: 'canvas only' })).resolves.toBe(true);
    expect(ax.focusWindow).toHaveBeenCalledWith(54172, 'canvas only');
    expect(osascripts()).toHaveLength(0);
  });

  it('a refusal from the helper is false, and its reason is kept for the tool to report (once)', async () => {
    const ax = fakeAx({ focusWindow: vi.fn(async () => { throw new MacAxError('failed', 'focusing failed: Google Chrome (pid 54172) has no window with a title containing "nope"'); }) });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ processId: 54172, title: 'nope' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/no window with a title containing "nope"/);
    expect(mac.takeFocusFailure()).toBeNull();
  });

  it('a successful focus clears an older reason', async () => {
    const ax = fakeAx();
    const mac = new MacOSAdapter({ ax });
    ax.focusWindow.mockRejectedValueOnce(new MacAxError('failed', 'focusing failed: first'));
    await mac.focusWindow({ processId: 1 });
    await mac.focusWindow({ processId: 54172 });
    expect(mac.takeFocusFailure()).toBeNull();
  });
});

describe('focusWindow by process name AND title', () => {
  it('the window that has both — not the first window of that name, which may belong to the user\'s other instance', async () => {
    const ax = fakeAx();
    await new MacOSAdapter({ ax }).focusWindow({ processName: 'Google Chrome', title: 'canvas only' });
    expect(ax.focusWindow).toHaveBeenCalledWith(54172, 'canvas only');
  });

  it('a name alone still takes the first window of that name', async () => {
    const ax = fakeAx();
    await new MacOSAdapter({ ax }).focusWindow({ processName: 'Google Chrome' });
    expect(ax.focusWindow).toHaveBeenCalledWith(935, undefined);
  });
});

describe('focusWindow by title alone', () => {
  it('finds the window in the list, whichever process owns it, and focuses that pid (the user\'s Chrome has the same name)', async () => {
    const ax = fakeAx();
    await expect(new MacOSAdapter({ ax }).focusWindow({ title: 'canvas only' })).resolves.toBe(true);
    expect(ax.focusWindow).toHaveBeenCalledWith(54172, 'canvas only');
    expect(osascripts()).toHaveLength(0);
  });

  it('is case-insensitive and ignores a minimized or zero-sized match when a visible one exists', async () => {
    const list = [WIN({ title: 'Report', processId: 7, isMinimized: true }), WIN({ title: 'My report', processId: 8 })];
    const ax = fakeAx({ listWindows: vi.fn(async () => list), listWindowsDetailed: vi.fn(async () => ({ windows: list, skipped: [] })) });
    await new MacOSAdapter({ ax }).focusWindow({ title: 'REPORT' });
    expect(ax.focusWindow).toHaveBeenCalledWith(8, 'REPORT');
  });

  it('no window has that title: false with a reason that says what was looked for', async () => {
    const ax = fakeAx();
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ title: 'does not exist' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/no window.*"does not exist"/i);
    expect(ax.focusWindow).not.toHaveBeenCalled();
  });
});

describe('without the helper (the System Events script is the fallback)', () => {
  const noHelper = () => fakeAx({ focusWindow: vi.fn(async () => null) });

  it('still runs focus-window.jxa with the pid', async () => {
    const ax = noHelper();
    jxaReply = '{"success":true,"title":"w","processId":54172,"processName":"Google Chrome"}';
    await expect(new MacOSAdapter({ ax }).focusWindow({ processId: 54172 })).resolves.toBe(true);
    expect(osascripts().find(c => c.args.some(a => /focus-window\.jxa$/.test(a)))?.args).toEqual(expect.arrayContaining(['-processId', '54172']));
  });

  it('a script that claims success while ANOTHER app is frontmost is a failure that names the app that came to the front', async () => {
    const ax = noHelper();
    ax.frontmost.mockResolvedValue(FRONT('Google Chrome', 935));
    jxaReply = '{"success":true,"title":"w","processId":54172,"processName":"Google Chrome"}';
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ processId: 54172 })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/pid 935/);
    expect(mac.takeFocusFailure()).toBeNull();
  });

  it('and when the right app is frontmost it is true', async () => {
    const ax = noHelper();
    ax.frontmost.mockResolvedValue(FRONT('Google Chrome', 54172));
    jxaReply = '{"success":true,"title":"w","processId":54172,"processName":"Google Chrome"}';
    await expect(new MacOSAdapter({ ax }).focusWindow({ processId: 54172 })).resolves.toBe(true);
  });
});

describe('focusWindow says why a lookup failed (live macOS 2026-10-24: a locked screen read as "No matching window found.")', () => {
  const locked = () => new MacAxError('locked', 'window list failed: the screen is locked — the lock screen (loginwindow) owns the display and keyboard.');

  it('by name: a locked screen is the answer, and nothing is focused', async () => {
    const ax = fakeAx({ listWindowsDetailed: vi.fn(async () => { throw locked(); }), appState: vi.fn(async () => { throw locked(); }) });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ processName: 'Finder' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/screen is locked/);
    expect(ax.focusWindow).not.toHaveBeenCalled();
    expect(osascripts()).toHaveLength(0);
  });

  it('by title: a locked screen is the answer, not "No window has a title containing"', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: vi.fn(async () => { throw locked(); }) }) });
    await expect(mac.focusWindow({ title: 'zzfindertest' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/screen is locked/);
  });

  it('a name nothing matches says so', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx() });
    await expect(mac.focusWindow({ processName: 'NoSuchApp' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toBe('No window or running app matches "NoSuchApp".');
  });

  it('a list that fails for another reason still resolves the name through the app list', async () => {
    const ax = fakeAx({
      listWindowsDetailed: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }),
      appState: vi.fn(async () => ({ processId: 954 })),
      frontmost: vi.fn(async () => FRONT('Finder', 954)),
    });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ processName: 'Finder' })).resolves.toBe(true);
    expect(ax.focusWindow).toHaveBeenCalledWith(954, undefined);
    expect(mac.takeFocusFailure()).toBeNull();   // the list's timeout is not left behind on a success
  });

  it('a slow list plus "no such app" from NSWorkspace says no match, not "timed out" (a typo is not retried)', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }) }) });
    await expect(mac.focusWindow({ processName: 'Finderr' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toBe('No window or running app matches "Finderr".');
  });

  it('a lock found after a slow list is still the answer', async () => {
    const ax = fakeAx({ listWindowsDetailed: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }), appState: vi.fn(async () => { throw locked(); }) });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.focusWindow({ processName: 'Finder' })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/screen is locked/);
    expect(ax.focusWindow).not.toHaveBeenCalled();
  });

  it('with no helper, a failed script says why', async () => {
    jxaReply = '{"success":false,"error":"Window not found matching title=\\"x\\" processId=954"}';
    const mac = new MacOSAdapter({ ax: fakeAx({ focusWindow: vi.fn(async () => null) }) });
    await expect(mac.focusWindow({ processId: 954 })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/^Window not found matching/);
  });

  it('through the tool, the lock reaches the caller instead of "No matching window found."', async () => {
    const tool = buildUnifiedTools().find(t => t.name === 'focus_window')!;
    const platform = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: vi.fn(async () => { throw locked(); }), appState: vi.fn(async () => { throw locked(); }) }) });
    const r = await tool.execute({ processName: 'Finder' }, { platform } as never);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/screen is locked/);
  });
});

describe('the focus_window tool', () => {
  const tool = buildUnifiedTools().find(t => t.name === 'focus_window')!;

  it('says why when the focus did not happen, instead of "No matching window found."', async () => {
    const platform = { focusWindow: vi.fn(async () => false), takeFocusFailure: vi.fn(() => 'Focus went to Google Chrome (pid 935), not to pid 54172.') };
    const r = await tool.execute({ processId: 54172 }, { platform } as never);
    expect(r.success).toBe(false);
    expect(r.text).toContain('pid 935');
  });

  it('keeps the old words when the platform has no reason to give', async () => {
    const r = await tool.execute({ title: 'x' }, { platform: { focusWindow: vi.fn(async () => false) } } as never);
    expect(r.text).toBe('No matching window found.');
  });

  it('success is unchanged', async () => {
    const r = await tool.execute({ title: 'x' }, { platform: { focusWindow: vi.fn(async () => true) } } as never);
    expect(r).toMatchObject({ success: true, text: 'Focused matching window.' });
  });
});
