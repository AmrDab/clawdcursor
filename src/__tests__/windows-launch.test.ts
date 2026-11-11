/**
 * Live repro (Windows 11, 1.6 candidate): `open_app "Calculator"` answered in 620 ms
 *   Opened "Calculator" (pid=49092, window="Application …")
 * pid 49092 was the new Outlook. Calculator was never started: the "already running?" check matched the packaged-app
 * id's last segment ("App") against window TITLES, focused the mail window and returned it.
 * And `open_file C:/Windows/System32/calc.exe` answered `Opened … (window: "Screenshots - File Explorer")`: the launch
 * goes through explorer.exe, so any Explorer window passed for the opened program.
 *
 * A window is an app's by identity only (platform/app-identity.ts): process name, package family, or — for a window
 * the UWP frame host owns — a title equal to the app's display name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WindowInfo } from '../platform/types';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const h = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  bridge: [] as Array<Record<string, unknown>>,
  installed: null as null | { path?: string; appId?: string; name?: string },
}));
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (c: Record<string, unknown>) => {
      h.bridge.push(c);
      if (c.cmd === 'get-process-paths') {
        return Promise.resolve({ paths: Object.fromEntries((c.pids as number[]).map(p => [String(p), h.paths[String(p)] ?? ''])) });
      }
      return Promise.resolve(null);
    },
    start: vi.fn(), stop: vi.fn(),
  },
}));
vi.mock('../platform/win-app-resolve', () => ({ resolveInstalledWindowsApp: async () => h.installed }));

type Call = { cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };
const spawns: Call[] = [];
vi.mock('child_process', () => ({
  execFile: (_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }),
  spawn: (cmd: string, args: string[], opts: Call['opts']) => {
    spawns.push({ cmd, args, opts });
    return { unref: () => {}, on: () => {} };
  },
}));

import { WindowsAdapter } from '../platform/windows';
import { __setSystemRootForTests } from '../platform/ps-spawn';

const W = (title: string, processName: string, processId: number): WindowInfo =>
  ({ title, processName, processId, handle: processId, bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false });

const OUTLOOK = W('Application Engineering weekly sync - Outlook', 'olk', 49092);
const GMAIL = W('Gmail – Inbox - Google Chrome', 'chrome', 200);
const EXPLORER = W('Screenshots - File Explorer', 'explorer', 300);
const DESKTOP = [OUTLOOK, GMAIL, EXPLORER];
const CALC = W('Calculator', 'CalculatorApp', 400);

const CALC_ALIAS = { uwpAppId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', searchTerm: 'Calculator', processNames: ['CalculatorApp', 'Calculator', 'calc'] };

let root = '';
let adapter: WindowsAdapter;
let focus: ReturnType<typeof vi.fn>;

/** `before` is what is open; once something has been spawned the list is `after`. */
function desktop(before: WindowInfo[], after: WindowInfo[] = before) {
  vi.spyOn(adapter, 'listWindows').mockImplementation(async () => (spawns.length ? after : before));
}

/** Drive the faked launch-poll clock until `p` settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  return p;
}

beforeEach(() => {
  spawns.length = 0; h.bridge.length = 0; h.paths = {}; h.installed = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-sysroot-'));
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(root, 'explorer.exe'), '');
  __setSystemRootForTests(root);
  adapter = new WindowsAdapter();
  focus = vi.fn(async () => true);
  vi.spyOn(adapter, 'focusWindow').mockImplementation(focus as never);
  vi.spyOn(adapter, 'keyPress').mockResolvedValue(undefined as never);
  vi.spyOn(adapter, 'typeText').mockResolvedValue(undefined as never);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  __setSystemRootForTests(undefined); fs.rmSync(root, { recursive: true, force: true });
});

const focusedPids = () => focus.mock.calls.map(c => (c[0] as { processId?: number }).processId);

describe('open_app on Windows — a running window is the app only by identity', () => {
  it('Calculator is LAUNCHED, not "found" in a mail window whose title contains "App"', async () => {
    desktop(DESKTOP, [...DESKTOP, CALC]);
    const res = await settle(adapter.launchApp('Calculator', CALC_ALIAS));
    expect(spawns.map(s => s.args.join(' '))).toEqual(['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']);
    expect(res).toMatchObject({ pid: 400, title: 'Calculator' });
    expect(focusedPids()).toEqual([400]);
  });

  it('Calculator never surfaces: nothing else is named or focused', async () => {
    desktop(DESKTOP);
    const res = await settle(adapter.launchApp('Calculator', { ...CALC_ALIAS, noStartMenuFallback: true }));
    expect(spawns).toHaveLength(1);
    expect(res).toEqual({});
    expect(focus).not.toHaveBeenCalled();
  });

  it('Calculator already running: its window is focused and nothing is launched', async () => {
    desktop([...DESKTOP, CALC]);
    const res = await settle(adapter.launchApp('Calculator', CALC_ALIAS));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 400, title: 'Calculator' });
    expect(focusedPids()).toEqual([400]);
  });

  it('a Calculator window owned by the UWP frame host counts — by its exact title, not a title that merely contains the name', async () => {
    const framed = W('Calculator', 'ApplicationFrameHost', 500);
    desktop([...DESKTOP, W('Calculator tips and tricks - Feedback Hub', 'ApplicationFrameHost', 501), framed]);
    const res = await settle(adapter.launchApp('calc', CALC_ALIAS));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 500, title: 'Calculator' });
  });

  it('Outlook is matched by its process (olk), whatever its title says', async () => {
    desktop(DESKTOP);
    const res = await settle(adapter.launchApp('Outlook', { searchTerm: 'Outlook', processNames: ['OUTLOOK', 'olk'] }));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 49092 });
    expect(focusedPids()).toEqual([49092]);
  });

  it('"Mail" is not the browser tab titled "Gmail"', async () => {
    desktop(DESKTOP);
    const res = await settle(adapter.launchApp('Mail', { searchTerm: 'Mail', processNames: ['Mail'], noStartMenuFallback: true }));
    expect(spawns).toHaveLength(1);          // a launch was attempted instead of adopting the tab
    expect(res).toEqual({});
    expect(focus).not.toHaveBeenCalled();
  });

  it('a process whose name merely contains the app name is not the app ("note" is not notepad)', async () => {
    desktop([W('Untitled - Notepad', 'notepad', 600)]);
    const res = await settle(adapter.launchApp('note', { noStartMenuFallback: true }));
    expect(spawns).toHaveLength(1);
    expect(res).toEqual({});
  });

  it('the Start-menu fallback reports only a window of the app', async () => {
    desktop(DESKTOP);
    const res = await settle(adapter.launchApp('Mail', { searchTerm: 'Mail', processNames: ['Mail'] }));
    expect(adapter.typeText).toHaveBeenCalledWith('Mail');
    expect(res).toEqual({});
    expect(focus).not.toHaveBeenCalled();
  });

  it('a packaged app is recognised by its package family, whatever its process is called', async () => {
    h.installed = { appId: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', name: 'Media Player' };
    h.paths['700'] = 'C:\\Program Files\\WindowsApps\\Microsoft.ZuneMusic_11.2409.5.0_x64__8wekyb3d8bbwe\\Microsoft.Media.Player.exe';
    h.paths['49092'] = 'C:\\Program Files\\WindowsApps\\Microsoft.OutlookForWindows_1.2025.1.0_x64__8wekyb3d8bbwe\\olk.exe';
    desktop(DESKTOP, [...DESKTOP, W('Now playing', 'Microsoft.Media.Player', 700)]);
    const res = await settle(adapter.launchApp('Media Player', { nameOnly: true }));
    expect(spawns.map(s => s.args.join(' '))).toEqual(['shell:AppsFolder\\Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic']);
    expect(res).toMatchObject({ pid: 700, title: 'Now playing' });
  });

  it('a packaged app that is already running is focused, not launched again', async () => {
    h.installed = { appId: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', name: 'Media Player' };
    h.paths['700'] = 'C:\\Program Files\\WindowsApps\\Microsoft.ZuneMusic_11.2409.5.0_x64__8wekyb3d8bbwe\\Microsoft.Media.Player.exe';
    desktop([...DESKTOP, W('Now playing', 'Microsoft.Media.Player', 700)]);
    const res = await settle(adapter.launchApp('Media Player', { nameOnly: true }));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 700 });
  });
});

describe('open_file on Windows — the window reported is the opened program\'s, never the launcher\'s', () => {
  const EXE = { url: 'C:/Windows/System32/calc.exe', noStartMenuFallback: true, viaLauncher: true, searchTerm: 'Calculator', processNames: ['calc', 'CalculatorApp'] };

  it('explorer.exe gets the path with backslashes (it reads "/" as a switch and opens Documents instead)', async () => {
    desktop(DESKTOP, [...DESKTOP, CALC]);
    await settle(adapter.launchApp('explorer.exe', EXE));
    expect(spawns[0].opts.env?.CLAWD_PS_ARGS).toBe('C:\\Windows\\System32\\calc.exe');
  });

  it('an exe: the program\'s own window is reported', async () => {
    desktop(DESKTOP, [...DESKTOP, CALC]);
    const res = await settle(adapter.launchApp('explorer.exe', EXE));
    expect(res).toMatchObject({ pid: 400, title: 'Calculator' });
  });

  it('an exe whose window never shows: no Explorer window stands in for it, old or new', async () => {
    desktop(DESKTOP, [...DESKTOP, W('Documents - File Explorer', 'explorer', 301)]);
    const res = await settle(adapter.launchApp('explorer.exe', EXE));
    expect(res).toEqual({});
    expect(focus).not.toHaveBeenCalled();
  });

  it('a document (program unknown): no window is claimed and none is waited for', async () => {
    desktop(DESKTOP);
    const res = await adapter.launchApp('explorer.exe', { url: 'C:\\Users\\x\\report.pdf', noStartMenuFallback: true, viaLauncher: true });
    expect(spawns).toHaveLength(1);
    expect(res).toEqual({});
    expect(focus).not.toHaveBeenCalled();
  });
});
