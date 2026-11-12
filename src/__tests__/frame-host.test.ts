/**
 * A Store (UWP) app's window belongs to ApplicationFrameHost. The app it hosts is resolved in ONE place
 * (platform/frame-host.ts), and the window list, the foreground read, the pill, the session log and the test fence all
 * name the app by it: "Calculator", not "Application Frame Host".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { freshHostedAppOf, hostedAppOf, isFrameHost, withHostedApp, withHostedApps, __setFrameHostReaderForTests, type HostedApp } from '../platform/frame-host';
import { actTarget, SessionLog, readSession } from '../surface/session-log';
import { buildSessionReport } from '../surface/report';
import * as os from 'os';
import { appLabel, activityLabel } from '../core/banner';
import { actedIn, workingIn, __setForegroundReaderForTests } from '../core/control';
import { guardedInput, guardInputMethods } from '../platform/pointer-guard';

const isGuardRefusalLike = (m: unknown) => typeof m === 'string' && m.startsWith('foreground changed: ');

const run = vi.mocked(psRunner.run);
const CALC: HostedApp = { processId: 6768, processName: 'CalculatorApp', appName: 'Calculator' };
const SETTINGS: HostedApp = { processId: 7100, processName: 'SystemSettings', appName: 'Settings' };
const frame = (handle: number, extra: object = {}) => ({ processId: 38636, processName: 'ApplicationFrameHost', appName: 'Application Frame Host', handle, ...extra });

let reads = 0;
beforeEach(() => {
  reads = 0;
  run.mockReset();
  __setFrameHostReaderForTests(async () => { reads++; return new Map([['7003', CALC], ['7004', SETTINGS]]); });
});
afterEach(() => { __setFrameHostReaderForTests(null); __setForegroundReaderForTests(async () => null); });

describe('which app a frame hosts', () => {
  it('knows the frame host by its process name', () => {
    expect(['ApplicationFrameHost', 'applicationframehost.exe', ' ApplicationFrameHost '].every(isFrameHost)).toBe(true);
    expect(['CalculatorApp', 'explorer', '', undefined, 'ApplicationFrameHostX'].some(isFrameHost)).toBe(false);
  });

  it('is looked up by the window\'s handle: two frames of one host are two apps', async () => {
    expect(await hostedAppOf(frame(7003))).toEqual(CALC);
    expect(await hostedAppOf(frame(7004))).toEqual(SETTINGS);
    expect(await hostedAppOf(frame(7999))).toBeUndefined();          // a frame whose app has not come up
  });

  it('is asked for once per handle, not once per call', async () => {
    for (let i = 0; i < 5; i++) { await hostedAppOf(frame(7003)); await hostedAppOf(frame(7004)); }
    expect(reads).toBe(1);
  });

  it('a window that already says what it hosts is taken at its word, with no lookup', async () => {
    expect(await hostedAppOf(frame(7003, { hostedProcessId: 111, hostedProcessName: 'PhotosApp', hostedAppName: 'Photos' })))
      .toEqual({ processId: 111, processName: 'PhotosApp', appName: 'Photos' });
    expect(reads).toBe(0);
  });

  it('only a frame-host window is looked up: another app cannot be given a hosted app', async () => {
    expect(await hostedAppOf({ processName: 'OUTLOOK', handle: 7003 })).toBeUndefined();
    expect(await hostedAppOf({ processName: 'OUTLOOK', handle: 7003, hostedProcessId: 6768 })).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('with no handle, or a bridge that fails, there is no answer (and no throw)', async () => {
    expect(await hostedAppOf({ processName: 'ApplicationFrameHost' })).toBeUndefined();
    __setFrameHostReaderForTests(async () => { throw new Error('bridge down'); });
    expect(await hostedAppOf(frame(7003))).toBeUndefined();
  });
});

describe('for a decision: always a fresh read', () => {
  it('asks the bridge every time, whatever is remembered', async () => {
    await hostedAppOf(frame(7003));
    expect(reads).toBe(1);
    for (let i = 0; i < 4; i++) expect(await freshHostedAppOf(frame(7003))).toEqual(CALC);
    expect(reads).toBe(5);
  });

  it('a handle that now hosts another app: the fresh read says so while the display answer is still the old one', async () => {
    expect(await hostedAppOf(frame(7003))).toEqual(CALC);
    __setFrameHostReaderForTests(async () => new Map([['7003', SETTINGS]]), { keepCache: true });
    expect(await hostedAppOf(frame(7003, { hostedProcessId: undefined }))).toEqual(CALC);   // display: remembered
    expect(await freshHostedAppOf(frame(7003))).toEqual(SETTINGS);                           // decision: now
    // What a decision just read is also the newest thing to show.
    expect(await hostedAppOf(frame(7003))).toEqual(SETTINGS);
  });

  it('ignores what the window object carries, and gives no answer rather than a remembered one', async () => {
    expect(await freshHostedAppOf(frame(7003, { hostedProcessId: 111, hostedProcessName: 'PhotosApp' }))).toEqual(CALC);
    await hostedAppOf(frame(7003));
    __setFrameHostReaderForTests(async () => { throw new Error('bridge down'); }, { keepCache: true });
    expect(await freshHostedAppOf(frame(7003))).toBeUndefined();
    __setFrameHostReaderForTests(async () => new Map(), { keepCache: true });
    expect(await freshHostedAppOf(frame(7003))).toBeUndefined();        // the frame is gone, or hosts nothing now
    expect(await freshHostedAppOf({ processName: 'ApplicationFrameHost' })).toBeUndefined();
    expect(await freshHostedAppOf({ processName: 'OUTLOOK', handle: 7003 })).toBeUndefined();
  });
});

describe('a window list is resolved with one bridge read', () => {
  const five = () => [7003, 7004, 7005, 7006, 7007].map(h => frame(h, { title: `w${h}` }));
  const slow = () => {
    __setFrameHostReaderForTests(async () => { reads++; await new Promise(r => setTimeout(r, 30)); return new Map([['7003', CALC], ['7004', SETTINGS]]); });
  };

  it('five Store app frames, none known yet: 1 read', async () => {
    slow();
    const list = await withHostedApps([...five(), { processName: 'notepad', handle: 55, appName: 'Notepad' }]);
    expect(reads).toBe(1);
    expect(list.map(w => w.appName)).toEqual(['Calculator', 'Settings', 'Application Frame Host', 'Application Frame Host', 'Application Frame Host', 'Notepad']);
  });

  it('the same list again right away: no read (three of its frames host nothing yet, and that is remembered too)', async () => {
    slow();
    await withHostedApps(five());
    await withHostedApps(five());
    expect(reads).toBe(1);
  });

  it('five frames resolved one by one at the same moment share that one read', async () => {
    slow();
    await Promise.all(five().map(w => withHostedApp(w)));
    expect(reads).toBe(1);
  });

  it('a list with no Store app frame, or whose frames already say what they host, asks nothing', async () => {
    await withHostedApps([{ processName: 'notepad', handle: 55 }, { processName: 'explorer', handle: 56 }]);
    await withHostedApps([frame(7003, { hostedProcessId: 6768, hostedProcessName: 'CalculatorApp' })]);
    expect(reads).toBe(0);
  });

  it('the Windows adapter lists windows with one frame read', async () => {
    slow();
    run.mockResolvedValue({ windows: [7003, 7004, 7005, 7006, 7007].map(h => ({ title: `w${h}`, processName: 'ApplicationFrameHost', processId: 38636, handle: h,
      bounds: { x: 0, y: 0, width: 1, height: 1 } })) });
    const list = await new WindowsAdapter().listWindows();
    expect(list).toHaveLength(5);
    expect(reads).toBe(1);
  });

  it('a bridge that fails leaves the list as it was', async () => {
    __setFrameHostReaderForTests(async () => { throw new Error('bridge down'); });
    expect((await withHostedApps(five())).every(w => w.appName === 'Application Frame Host')).toBe(true);
  });
});

describe('the input lease is on the app, not on the window\'s process', () => {
  // Both windows belong to ApplicationFrameHost (38636). With no fence at all.
  const calcWindow = { processId: 38636, processName: 'ApplicationFrameHost', appName: 'Calculator', title: 'Calculator', handle: 7003, hostedProcessId: 6768 };
  const settingsWindow = { processId: 38636, processName: 'ApplicationFrameHost', appName: 'Settings', title: 'Settings', handle: 7004, hostedProcessId: 7100 };
  const sent: string[] = [];
  const type = (text: string) => guardedInput('typeText', [text], async () => { sent.push(text); return 'sent'; });
  beforeEach(() => { sent.length = 0; });

  it('the user switches from Calculator to Settings between two calls: the next input is refused as a foreground change', async () => {
    let front = calcWindow;
    __setForegroundReaderForTests(async () => front);
    await type('47*89=');
    await new Promise(r => setTimeout(r, 0));
    // Not the agent's doing: no focus call, and its last input was not one that moves the focus.
    front = settingsWindow;
    await expect(type('into settings')).rejects.toThrow(/^foreground changed: you were working in "Calculator" \(pid 6768\), but "Settings" \(pid 7100\) is in front now/);
    expect(sent).toEqual(['47*89=']);
    expect(isGuardRefusalLike(await type('again').catch((e: Error) => e.message))).toBe(true);
    expect(sent).toEqual(['47*89=']);
  });

  it('staying in Calculator goes on working', async () => {
    __setForegroundReaderForTests(async () => ({ ...calcWindow }));
    await type('1');
    await type('2');
    expect(sent).toEqual(['1', '2']);
  });

  it('the same window whose app was not resolved yet at the first call is not a switch', async () => {
    let front: typeof calcWindow | Omit<typeof calcWindow, 'hostedProcessId'> = { processId: 38636, processName: 'ApplicationFrameHost', appName: 'Application Frame Host', title: 'Calculator', handle: 7003 };
    __setForegroundReaderForTests(async () => front);
    await type('1');
    front = calcWindow;
    await type('2');
    expect(sent).toEqual(['1', '2']);
  });

  it('two ordinary apps are told apart as before', async () => {
    let front = { processId: 42, processName: 'notepad', handle: 55 };
    __setForegroundReaderForTests(async () => front);
    await type('a');
    front = { processId: 43, processName: 'winword', handle: 56 };
    await expect(type('b')).rejects.toThrow(/^foreground changed: you were working in "notepad" \(pid 42\)/);
  });

  it('an act by name on the Store app in front counts, by the app\'s process or the frame\'s', async () => {
    let front = calcWindow;
    __setForegroundReaderForTests(async () => front);
    const bridge = guardInputMethods({ invokeElement: async (_q: object) => 'invoked' });
    await bridge.invokeElement({ processId: 6768, name: 'Zero', action: 'click' });
    expect(appLabel(actedIn()!.processName, actedIn()!.appName)).toBe('Calculator');
    await type('0');                                   // the lease is Calculator's: typing goes on
    front = settingsWindow;                            // (setting the reader again would reset the lease)
    await expect(type('x')).rejects.toThrow(/foreground changed/);
  });
});

describe('the act line of the session log says who the act went to, as numbers', () => {
  it('the app\'s process (for a Store app, the hosted one) and the window handle', () => {
    expect(actTarget({ processId: 38636, hostedProcessId: 6768, handle: 18814450 })).toEqual({ appPid: 6768, appHandle: 18814450 });
    expect(actTarget({ processId: 42, handle: 55 })).toEqual({ appPid: 42, appHandle: 55 });
    expect(actTarget({ processId: 42, handle: 'AXWindow-3' })).toEqual({ appPid: 42 });   // a handle that is not a number is left out
    expect(actTarget({ processId: 0 })).toEqual({});
    expect(actTarget(undefined)).toEqual({});
  });

  it('is written to the session file, and only numbers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-host-session-'));
    const before = process.env.CLAWDCURSOR_SESSION_DIR;
    process.env.CLAWDCURSOR_SESSION_DIR = dir;
    try {
      const log = new SessionLog({ version: 't', surface: 'compact' });
      log.record('accessibility', 'invoke', true, 12, undefined, undefined, { app: 'Calculator', appPid: 6768, appHandle: 18814450 });
      log.record('accessibility', 'read_tree', true, 5);
      log.record('computer', 'type', true, 5, undefined, undefined, { app: 'Calculator', appPid: 'Calculator' as never, appHandle: 1.5 });
      const { calls } = readSession(log.file!);
      expect(calls[0]).toMatchObject({ app: 'Calculator', appPid: 6768, appHandle: 18814450 });
      expect('appPid' in calls[1]).toBe(false);
      expect('appPid' in calls[2] || 'appHandle' in calls[2]).toBe(false);          // not numbers: not written
      // `clawdcursor report` sends a summary of this file: neither number, and no app name, is in it.
      const report = JSON.stringify(buildSessionReport(log.file!));
      expect(report).toContain('invoke');
      expect(report).not.toMatch(/appPid|appHandle|6768|18814450|Calculator/);
    } finally {
      if (before === undefined) delete process.env.CLAWDCURSOR_SESSION_DIR; else process.env.CLAWDCURSOR_SESSION_DIR = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the window, resolved', () => {
  it('a Store app is named as the app: its display name, its process as the hosted process; the window stays the host\'s', async () => {
    expect(await withHostedApp(frame(7003, { title: 'Calculator' }))).toEqual({ processId: 38636, processName: 'ApplicationFrameHost', handle: 7003,
      title: 'Calculator', appName: 'Calculator', hostedProcessId: 6768, hostedProcessName: 'CalculatorApp' });
  });

  it('an app with no display name is named after its process, without the "App" on its end', async () => {
    __setFrameHostReaderForTests(async () => new Map([['7003', { processId: 6768, processName: 'CalculatorApp' }], ['7005', { processId: 9, processName: 'Spotify.exe' }]]));
    expect((await withHostedApp(frame(7003))).appName).toBe('Calculator');
    expect((await withHostedApp(frame(7005))).appName).toBe('Spotify');
  });

  it('any other window, and a frame that cannot be resolved, is returned as it is', async () => {
    const notepad = { processId: 5, processName: 'Notepad', appName: 'Notepad', handle: 1 };
    expect(await withHostedApp(notepad)).toBe(notepad);
    const empty = frame(7999);
    expect(await withHostedApp(empty)).toBe(empty);
  });
});

describe('what the pill and the session log call it', () => {
  it('"Calculator", not "Application Frame Host"', async () => {
    const w = await withHostedApp(frame(7003));
    expect(appLabel(w.processName, w.appName)).toBe('Calculator');
    expect(activityLabel('mouseClick', w.processName, w.appName)).toBe('Clicking in Calculator');
    // Unresolved, it is what it was: the host's own name.
    const bare = frame(7999);
    expect(appLabel(bare.processName, bare.appName)).toBe('Application Frame Host');
  });

  it('the app an input acted in (the session log\'s `app`, the pill\'s name) is the hosted app', async () => {
    const adapter = new WindowsAdapter();
    run.mockImplementation(async (cmd: { cmd?: string }) => cmd.cmd === 'get-foreground-window'
      ? { success: true, handle: 7003, processId: 38636, processName: 'ApplicationFrameHost', appName: 'Application Frame Host', title: 'Calculator',
        className: 'ApplicationFrameWindow', bounds: { x: 0, y: 0, width: 400, height: 600 }, isMinimized: false }
      : {});
    __setForegroundReaderForTests(async () => {
      const w = await adapter.getActiveWindow();
      return w ? { processId: w.processId, processName: w.processName, appName: w.appName, title: w.title, handle: w.handle, hostedProcessId: w.hostedProcessId } : null;
    });
    await guardedInput('keyPress', ['4'], async () => 'sent');
    const acted = actedIn()!;
    expect(appLabel(acted.processName, acted.appName)).toBe('Calculator');
    const working = workingIn()!;
    expect(activityLabel('keyPress', working.processName, working.appName)).toBe('Pressing keys in Calculator');
  });
});

describe('the Windows adapter', () => {
  const fg = (extra: object = {}) => ({ success: true, handle: 7003, processId: 38636, processName: 'ApplicationFrameHost', appName: 'Application Frame Host',
    title: 'Calculator', className: 'ApplicationFrameWindow', bounds: { x: 10, y: 10, width: 400, height: 600 }, isMinimized: false, ...extra });

  it('the window in front: a bridge that names the hosted app is used as it is, with no second read', async () => {
    run.mockResolvedValue(fg({ hostedProcessId: 6768, hostedProcessName: 'CalculatorApp', hostedAppName: 'Calculator' }));
    const w = await new WindowsAdapter().getActiveWindow();
    expect(w).toMatchObject({ processId: 38636, processName: 'ApplicationFrameHost', appName: 'Calculator', hostedProcessId: 6768, hostedProcessName: 'CalculatorApp', handle: 7003 });
    expect(reads).toBe(0);
  });

  it('the window in front: a bridge that does not (an older one) is completed by the handle lookup', async () => {
    run.mockResolvedValue(fg());
    const w = await new WindowsAdapter().getActiveWindow();
    expect(w).toMatchObject({ appName: 'Calculator', hostedProcessId: 6768 });
    expect(reads).toBe(1);
  });

  it('another Store app in front is that app, not Calculator', async () => {
    run.mockResolvedValue(fg({ handle: 7004, title: 'Settings' }));
    expect(await new WindowsAdapter().getActiveWindow()).toMatchObject({ appName: 'Settings', hostedProcessId: 7100 });
  });

  it('an ordinary window in front is untouched', async () => {
    run.mockResolvedValue({ success: true, handle: 55, processId: 42, processName: 'notepad', appName: 'Notepad', title: 'Untitled', bounds: { x: 0, y: 0, width: 300, height: 200 } });
    const w = await new WindowsAdapter().getActiveWindow();
    expect(w).toMatchObject({ processName: 'notepad', appName: 'Notepad' });
    expect(w!.hostedProcessId).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('the window list says which app each Store app frame hosts', async () => {
    run.mockResolvedValue({ windows: [
      { title: 'Calculator', processName: 'ApplicationFrameHost', processId: 38636, handle: 7003, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { title: 'Settings', processName: 'ApplicationFrameHost', processId: 38636, handle: 7004, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { title: 'Untitled - Notepad', processName: 'notepad', processId: 42, handle: 55, bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ] });
    const list = await new WindowsAdapter().listWindows();
    expect(list.map(w => [w.title, w.appName, w.hostedProcessId])).toEqual([['Calculator', 'Calculator', 6768], ['Settings', 'Settings', 7100], ['Untitled - Notepad', undefined, undefined]]);
  });
});

describe('the bridge', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
  const body = (name: string) => { const i = bridge.indexOf(`function ${name}`); return bridge.slice(i, bridge.indexOf('\nfunction ', i + 10)); };

  it('resolves the hosted app in one function: the owner of the frame\'s CoreWindow, its process name and display name', () => {
    const fn = body('Get-HostedApp');
    expect(fn).toContain("if ($cls -ne 'ApplicationFrameWindow') { return $null }");
    expect(fn).toContain('[LaunchWin]::CoreOf($h)');
    expect(fn).toContain('appName = (Get-AppName ([int]$cp) $n)');
    expect(bridge.match(/CoreOf\(\$/g)).toHaveLength(1);   // nowhere else
  });

  it('the window list and the foreground read both use it', () => {
    expect(body('Cmd-ListWindows')).toContain('Get-HostedApp $h $cls');
    expect(body('Cmd-ListWindows')).toContain('$w.hostedAppName = $hosted.appName');
    expect(body('Cmd-GetForegroundWindow')).toContain('Get-HostedApp $fgWin $cls');
    expect(body('Cmd-GetForegroundWindow')).toContain('$fg.hostedAppName = $hosted.appName');
  });
});
