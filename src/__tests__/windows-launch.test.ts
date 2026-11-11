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
  installed: null as null | { path?: string; appId?: string; name?: string; target?: string },
  procs: [] as Array<{ pid: number; name: string; started: number }>,
  /** What the bridge's Win32 window read answers; null = a bridge without it (the adapter falls back to listWindows). */
  fast: null as null | (() => Promise<unknown>),
  /** Exit status of a spawned PowerShell (Start-Process): 0 = started. */
  spawnExit: 0,
}));
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (c: Record<string, unknown>) => {
      h.bridge.push(c);
      if (c.cmd === 'get-process-paths') {
        return Promise.resolve({ paths: Object.fromEntries((c.pids as number[]).map(p => [String(p), h.paths[String(p)] ?? ''])) });
      }
      if (c.cmd === 'list-windows' && h.fast) return h.fast();
      return Promise.resolve(null);
    },
    start: vi.fn(), stop: vi.fn(),
  },
}));
vi.mock('../platform/win-app-resolve', () => ({ resolveInstalledWindowsApp: async () => h.installed }));
vi.mock('../platform/win-processes', () => ({
  findWindowsProcesses: async (names: string[]) => {
    const want = names.map(n => n.toLowerCase());
    return h.procs.filter(p => want.includes(p.name.toLowerCase())).map(p => ({ pid: p.pid, processName: p.name, started: p.started }));
  },
}));

type Call = { cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };
const spawns: Call[] = [];
vi.mock('child_process', () => ({
  execFile: (_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }),
  spawn: (cmd: string, args: string[], opts: Call['opts']) => {
    spawns.push({ cmd, args, opts });
    return { unref: () => {}, on: (ev: string, cb: (code: number) => void) => { if (ev === 'exit') void Promise.resolve().then(() => cb(h.spawnExit)); } };
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
  spawns.length = 0; h.bridge.length = 0; h.paths = {}; h.installed = null; h.procs = []; h.fast = null; h.spawnExit = 0;
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
    expect(spawns[0].opts.env?.CLAWD_PS_ARGS).toBe('"C:\\Windows\\System32\\calc.exe"');
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

describe('open_file on Windows — any valid path opens; a refused one says why', () => {
  const OPEN = { noStartMenuFallback: true, viaLauncher: true };
  const script = () => spawns[0].args.join(' ');

  it.each([
    ["C:\\Users\\x\\Sam's notes.txt"],
    ['C:\\$Recycle.Bin\\S-1-5\\$I1.txt'],
    ['C:\\Users\\x\\a `b` & (c); echo.txt'],
  ])('%s reaches the launcher as data ($env:), never as script text', async (p) => {
    desktop(DESKTOP);
    await adapter.launchApp('explorer.exe', { ...OPEN, url: p });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].opts.env?.CLAWD_PS_ARGS).toBe(`"${p}"`);
    expect(script()).toContain('-ArgumentList $env:CLAWD_PS_ARGS');
    expect(script()).not.toContain('notes');
    expect(script()).not.toContain('Recycle');
    expect(script()).not.toContain('echo');
    expect((spawns[0].opts as { shell?: unknown }).shell).toBeFalsy();
  });

  it.each([['C:\\x\\a"b.txt'], ['C:\\x\\a\nb.txt']])('%j is refused with the reason, and nothing is started (it used to open the bare launcher)', async (p) => {
    desktop(DESKTOP);
    await expect(adapter.launchApp('explorer.exe', { ...OPEN, url: p })).rejects.toThrow(/double quote or a control character/);
    expect(spawns).toHaveLength(0);
  });
});


describe('open_file on Windows — the path is ONE argument, whatever it contains', () => {
  // `Start-Process -ArgumentList` hands its string to the program as written: unquoted, a path with spaces split.
  const OPEN = { noStartMenuFallback: true, viaLauncher: true };
  it.each([
    ['C:\\Users\\x\\My Documents\\Q3 report (final).pdf', '"C:\\Users\\x\\My Documents\\Q3 report (final).pdf"'],
    ['C:/Program Files/My App/', '"C:\\Program Files\\My App"'],          // no backslash left to escape the closing quote
    ['\\\\server\\share\\Team Docs\\a b.txt', '"\\\\server\\share\\Team Docs\\a b.txt"'],
    ['//server/share/Team Docs/', '"\\\\server\\share\\Team Docs"'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:\\'],
    ['C:\\plain\\path.txt', '"C:\\plain\\path.txt"'],
  ])('%s → %s', async (given, sent) => {
    desktop(DESKTOP);
    await adapter.launchApp('explorer.exe', { ...OPEN, url: given });
    expect(spawns[0].opts.env?.CLAWD_PS_ARGS).toBe(sent);
    expect(spawns[0].args.join(' ')).toContain('-ArgumentList $env:CLAWD_PS_ARGS');
  });

  it('a URL is left as it is', async () => {
    desktop(DESKTOP);
    await settle(adapter.launchApp('msedge.exe', { url: 'https://example.com/a?b=c&d=e', noStartMenuFallback: true }));
    expect(spawns[0].opts.env?.CLAWD_PS_ARGS).toBe('https://example.com/a?b=c&d=e');
  });
});

describe('open_app on Windows — a slow starter whose process is up but whose window is not', () => {
  // Live: open_app "Designcenter" (NX, ugraf.exe) took 39 s and answered "Could not confirm … no window appeared"
  // while the app was starting.
  const NX = { appId: 'Siemens.NX.Designcenter', name: 'Designcenter', target: 'C:\\Program Files\\Siemens\\NX2506\\NXBIN\\ugraf.exe' };
  const NX_EXE = { path: 'C:\\Program Files\\Siemens\\NX2506\\NXBIN\\ugraf.exe' };
  const fresh = () => Date.now() + 500;
  const old = () => Date.now() - 3_600_000;

  it('reports the process this launch started (pid + process name), not a failure, within the launch budget', async () => {
    h.installed = NX;
    h.procs = [{ pid: 5150, name: 'ugraf', started: fresh() }];
    desktop(DESKTOP);
    const t0 = Date.now();
    const res = await settle(adapter.launchApp('Designcenter', { nameOnly: true }));
    expect(res).toEqual({ pid: 5150, processName: 'ugraf' });
    expect(Date.now() - t0).toBeLessThanOrEqual(9_000);
    expect(focus).not.toHaveBeenCalled();          // there is no window to bring forward yet
  });

  it('neither a window nor a process: still the empty result', async () => {
    h.installed = NX;
    desktop(DESKTOP);
    expect(await settle(adapter.launchApp('Designcenter', { nameOnly: true }))).toEqual({});
  });

  it('name-only: a process that was there BEFORE this launch is not "started" (a tray app whose launch did nothing)', async () => {
    h.installed = NX;
    h.procs = [{ pid: 5150, name: 'ugraf', started: old() }];
    desktop(DESKTOP);
    expect(await settle(adapter.launchApp('Designcenter', { nameOnly: true }))).toEqual({});
  });

  it('name-only: a launch Windows refused is a failure with the reason, even with an older process of that name running', async () => {
    h.installed = NX_EXE;
    h.spawnExit = 1;
    h.procs = [{ pid: 5150, name: 'ugraf', started: old() }];
    desktop(DESKTOP);
    await expect(settle(adapter.launchApp('Designcenter', { nameOnly: true }))).rejects.toThrow(/Windows could not start "Designcenter"/);
  });

  it('a known app whose process started with this launch: reported, and the Start menu is not typed into (that would launch it twice)', async () => {
    desktop(DESKTOP);
    h.procs = [{ pid: 6000, name: 'OUTLOOK', started: fresh() }];
    const res = await settle(adapter.launchApp('Excel', { searchTerm: 'Excel', processNames: ['EXCEL', 'OUTLOOK'] }));
    expect(res).toEqual({ pid: 6000, processName: 'OUTLOOK' });
    expect(adapter.typeText).not.toHaveBeenCalled();
  });

  it('a known app, Start-Process succeeded, the app handed the launch to its running process: reported, no Start-menu search', async () => {
    desktop(DESKTOP);
    h.procs = [{ pid: 6001, name: 'msedge', started: old() }];
    const res = await settle(adapter.launchApp('msedge.exe', { searchTerm: 'Edge', processNames: ['msedge'] }));
    expect(res).toEqual({ pid: 6001, processName: 'msedge', alreadyRunning: true });
    expect(adapter.typeText).not.toHaveBeenCalled();
  });

  it('a known app, Start-Process FAILED: background processes of that name prove nothing — the Start-menu search is the recovery', async () => {
    desktop(DESKTOP);
    h.spawnExit = 1;
    h.procs = [{ pid: 6001, name: 'msedge', started: old() }];
    const res = await settle(adapter.launchApp('msedge.exe', { searchTerm: 'Edge', processNames: ['msedge'] }));
    expect(adapter.typeText).toHaveBeenCalledWith('Edge');
    expect(res).toEqual({});
  });
});

describe('open_app on Windows — the wait ends with its budget, and the process answer survives a stuck window read', () => {
  const NX = { appId: 'Siemens.NX.Designcenter', name: 'Designcenter', target: 'C:\\Program Files\\Siemens\\NX2506\\NXBIN\\ugraf.exe' };

  /** The bridge as it behaves while an app is starting: one read answers, the next hangs 20 s and then the bridge is torn down. */
  function wedgedBridge() {
    let first = true;
    h.fast = () => {
      if (first) { first = false; return Promise.resolve({ windows: DESKTOP }); }
      return new Promise((_, reject) => setTimeout(() => reject(new Error('PSRunner bridge restarted after a command timeout')), 20_000));
    };
  }

  it('the launch reads windows through the bridge\'s Win32 read, not the UI Automation one', async () => {
    h.fast = async () => ({ windows: spawns.length ? [...DESKTOP, CALC] : DESKTOP });
    const uia = vi.spyOn(adapter, 'listWindows');
    const res = await settle(adapter.launchApp('Calculator', CALC_ALIAS));
    expect(res).toMatchObject({ pid: 400, title: 'Calculator' });
    expect(uia).not.toHaveBeenCalled();
    expect(h.bridge.some(c => c.cmd === 'get-screen-context')).toBe(false);
  });

  it('name-only (the NX case): "started, window not up yet" within the budget, although the window read is stuck', async () => {
    h.installed = NX;
    h.procs = [{ pid: 5150, name: 'ugraf', started: Date.now() + 500 }];
    wedgedBridge();
    const t0 = Date.now();
    const res = await settle(adapter.launchApp('Designcenter', { nameOnly: true }));
    expect(res).toEqual({ pid: 5150, processName: 'ugraf' });
    expect(Date.now() - t0).toBeLessThanOrEqual(9_000);
  });

  it('a known app: the same, and no Start-menu search launches it a second time', async () => {
    h.procs = [{ pid: 6000, name: 'OUTLOOK', started: Date.now() + 500 }];
    wedgedBridge();
    const t0 = Date.now();
    const res = await settle(adapter.launchApp('Outlook', { searchTerm: 'Outlook', processNames: ['OUTLOOK', 'olk'], alwaysNewInstance: true }));
    expect(res).toEqual({ pid: 6000, processName: 'OUTLOOK' });
    expect(adapter.typeText).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThanOrEqual(5_000);
  });

  it('a first window read that never answers does not hold the launch: it starts from an empty snapshot', async () => {
    h.installed = NX;
    h.procs = [{ pid: 5150, name: 'ugraf', started: Date.now() + 6_000 }];
    h.fast = () => new Promise(() => {});
    const t0 = Date.now();
    const res = await settle(adapter.launchApp('Designcenter', { nameOnly: true }));
    expect(res).toEqual({ pid: 5150, processName: 'ugraf' });
    expect(Date.now() - t0).toBeLessThanOrEqual(5_000 + 9_000);
  });
});

describe('open_app on Windows — a UWP app in its frame window is known by the app it hosts, on any Windows language', () => {
  const frame = (title: string, pid: number, hosted?: { id: number; name: string }): WindowInfo =>
    ({ ...W(title, 'ApplicationFrameHost', pid), ...(hosted ? { hostedProcessId: hosted.id, hostedProcessName: hosted.name } : {}) });
  const fast = (before: WindowInfo[]) => { h.fast = async () => ({ windows: before }); };

  it('a German Calculator ("Rechner") that is open is found by its hosted process and focused, not launched twice', async () => {
    fast([...DESKTOP, frame('Rechner', 500, { id: 501, name: 'CalculatorApp' })]);
    const res = await settle(adapter.launchApp('Calculator', CALC_ALIAS));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 500, title: 'Rechner' });
  });

  it('…or by the hosted process\'s package family, whatever that process is called', async () => {
    h.paths['501'] = 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2502.2.0_x64__8wekyb3d8bbwe\\Renamed.exe';
    fast([...DESKTOP, frame('Rechner', 500, { id: 501, name: 'Renamed' })]);
    const res = await settle(adapter.launchApp('Calculator', { uwpAppId: CALC_ALIAS.uwpAppId, searchTerm: 'Calculator' }));
    expect(spawns).toHaveLength(0);
    expect(res).toMatchObject({ pid: 500 });
  });

  it('a frame hosting ANOTHER app is not Calculator, even if its title says "Calculator"', async () => {
    h.paths['601'] = 'C:\\Program Files\\WindowsApps\\Contoso.Notes_1.0.0.0_x64__abcdefgh12345\\Notes.exe';
    fast([...DESKTOP, frame('Calculator', 600, { id: 601, name: 'Notes' })]);
    const res = await settle(adapter.launchApp('Calculator', { ...CALC_ALIAS, noStartMenuFallback: true }));
    expect(spawns).toHaveLength(1);
    expect(res).toEqual({});
  });
});

describe('open_file on Windows — Explorer starting says nothing about the file it was given', () => {
  // Re-review of #350: open_file "D:\gone\python.exe" (missing) with an older python.exe running answered
  // "Started python.exe (pid=old) … do not launch it again". The Start-Process that succeeded was explorer.exe's.
  const MISSING = { url: 'D:\\gone\\python.exe', noStartMenuFallback: true, viaLauncher: true, processNames: ['python'] };

  it('a missing program with an OLDER process of that name running: nothing is claimed', async () => {
    desktop(DESKTOP);
    h.procs = [{ pid: 7000, name: 'python', started: Date.now() - 3_600_000 }];
    expect(await settle(adapter.launchApp('explorer.exe', MISSING))).toEqual({});
  });

  it('a program whose process began with this launch is still reported', async () => {
    desktop(DESKTOP);
    h.procs = [{ pid: 7001, name: 'python', started: Date.now() + 500 }];
    expect(await settle(adapter.launchApp('explorer.exe', MISSING))).toEqual({ pid: 7001, processName: 'python' });
  });
});
