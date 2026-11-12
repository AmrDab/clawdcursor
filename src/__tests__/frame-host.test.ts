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
import { hostedAppOf, isFrameHost, withHostedApp, __setFrameHostReaderForTests, type HostedApp } from '../platform/frame-host';
import { appLabel, activityLabel } from '../core/banner';
import { actedIn, workingIn, __setForegroundReaderForTests } from '../core/control';
import { guardedInput } from '../platform/pointer-guard';

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
