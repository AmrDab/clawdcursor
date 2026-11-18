/**
 * open_app "Google Chrome" with two Chromes running (Mac test session on test/rc-2.2, 2026-11-18): the user's everyday
 * Chrome (pid 935, with a window) and clawdcursor's own (pid 1866, --remote-debugging-port=9333, its own profile, no
 * window: a macOS app keeps running after its last window closes).
 *
 * open_app looked the app up by name and took the newest copy, clawdcursor's windowless one; `open -a "Google Chrome"`
 * then raised the user's copy, as LaunchServices picks it. The reply named pid 1866 "still loading", the agent's next key
 * met FOREGROUND_CHANGED, and it went on in the user's real profile (window focus {processId:935}).
 *
 * Real open_app, real MacOSAdapter and real CDPDriver; the accessibility helper, `open`, Playwright and the debug port
 * are faked over one small model of the two processes. No test touches a real desktop or browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const USER = 935;
const AGENT = 1866;
const OTHER_APP = 500;   // what was in front before open_app (the user's Terminal)

/** The desktop: who is in front, and the windows each process has. */
const world = {
  front: OTHER_APP,
  windows: new Map<number, string[]>(),
  /** Is clawdcursor's own browser up on its debug port, and what does it say it is. */
  agentUp: true,
  agentUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** A browser the USER put on the wire (port 9223), which the driver may be attached to. */
  userCdpUp: false,
  focused: [] as number[],
  newWindowCalls: 0,
};

const execCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    execCalls.push({ cmd, args });
    // `open -a "Google Chrome"` goes by the app, not by a pid: LaunchServices raises the user's copy.
    if (cmd === 'open' && args.includes('Google Chrome')) world.front = USER;
    cb(null, { stdout: '{}', stderr: '' });
  },
  spawn: vi.fn(),
}));

/** A page as Playwright shows it. */
const fakePage = (url: string) => ({
  url: () => url, isClosed: () => false, title: async () => url, evaluate: async () => {}, bringToFront: async () => {},
});

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: vi.fn(async (endpoint: string) => {
      const port = Number(new URL(endpoint).port);
      const pid = port === 9333 && world.agentUp ? AGENT : port === 9223 && world.userCdpUp ? USER : 0;
      if (!pid) throw new Error(`ECONNREFUSED ${port}`);
      return {
        contexts: () => [{ pages: () => (world.windows.get(pid) ?? []).map(fakePage), newPage: async () => fakePage('about:blank') }],
        isConnected: () => true,
        newBrowserCDPSession: async () => ({
          send: async () => ({ processInfo: [{ type: 'renderer', id: pid + 1 }, { type: 'browser', id: pid }] }),
          detach: async () => {},
        }),
        close: async () => {},
      };
    }),
  },
}));

// The debug port's HTTP side, for clawdcursor's own browser only.
const fetchStub = vi.fn(async (url: string, init?: { method?: string }) => {
  const u = new URL(url);
  if (u.port !== '9333' || !world.agentUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  if (u.pathname === '/json/version') {
    return json({ Browser: 'Chrome/131.0.6778.86', 'User-Agent': world.agentUserAgent, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/x' });
  }
  if (u.pathname === '/json/list') return json((world.windows.get(AGENT) ?? []).map(t => ({ type: 'page', url: t })));
  if (u.pathname === '/json/new' && init?.method === 'PUT') {
    // A browser with no window opens one for a new tab.
    world.newWindowCalls++;
    world.windows.set(AGENT, [...(world.windows.get(AGENT) ?? []), 'about:blank']);
    return json({ type: 'page', url: 'about:blank' });
  }
  return { ok: false, json: async () => null };
});

import { getOrchestrationTools } from '../tools/orchestration';
import { getExtraTools } from '../tools/extras';
import { MacOSAdapter } from '../platform/macos';
import { CDPDriver } from '../platform/cdp-driver';
import type { AppState, MacAx } from '../platform/mac-ax';
import type { WindowInfo } from '../platform/types';
import type { ToolContext } from '../tools/types';

const RECT = { x: 0, y: 0, width: 1200, height: 800 };
const win = (pid: number): WindowInfo | null => {
  const titles = world.windows.get(pid);
  if (!titles?.length) return null;
  return { title: titles[0], processName: pid === OTHER_APP ? 'Terminal' : 'Google Chrome', processId: pid, bounds: RECT, isMinimized: false, handle: pid };
};
const chrome = (pid: number, launchDate: number): AppState => ({
  name: 'Google Chrome', names: ['google chrome'], bundleId: 'com.google.Chrome', processId: pid, finishedLaunching: true,
  active: world.front === pid, activationPolicy: 'regular', launchDate, windows: win(pid) ? [win(pid)!] : [], windowsKnown: true,
});

/** The accessibility helper over `world`. appState by name answers as mac-ax does: the newest launch among equal names. */
function fakeAx(): MacAx {
  return {
    appState: vi.fn(async (name: string) => (name === 'Google Chrome' ? chrome(AGENT, 2) : null)),
    focusWindow: vi.fn(async (pid: number) => {
      const w = win(pid);
      if (!w) return null;
      world.front = pid;
      world.focused.push(pid);
      return { title: w.title, processId: pid, processName: w.processName };
    }),
    activeWindow: vi.fn(async () => win(world.front)),
    listWindows: vi.fn(async () => [OTHER_APP, USER, AGENT].map(win).filter(Boolean) as WindowInfo[]),
    listWindowsDetailed: vi.fn(async () => ({ windows: [OTHER_APP, USER, AGENT].map(win).filter(Boolean) as WindowInfo[], skipped: [] })),
    frontmost: vi.fn(async () => ({ locked: false, app: { name: 'x', processId: world.front, activationPolicy: 'regular', windows: [] } })),
    prepare: vi.fn(),
  } as unknown as MacAx;
}

const openApp = getOrchestrationTools().find(t => t.name === 'open_app')!;

function ctxWith(cdp: CDPDriver): ToolContext {
  return {
    ensureInitialized: async () => {},
    platform: new MacOSAdapter({ ax: fakeAx() }),
    a11y: { invalidateCache: () => {} },
    cdp,
  } as unknown as ToolContext;
}

/** Drive fake timers until the promise settles (the launch flow polls). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then(v => { value = v; done = true; }, e => { error = e; done = true; });
  for (let i = 0; i < 600 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  if (!done) throw new Error('promise did not settle');
  if (error) throw error;
  return value as T;
}

const realPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.env.CLAWD_NO_MAC_AX = '0';
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchStub);
  execCalls.length = 0;
  Object.assign(world, { front: OTHER_APP, agentUp: true, userCdpUp: false, focused: [], newWindowCalls: 0 });
  world.agentUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  world.windows = new Map([[OTHER_APP, ['zsh']], [USER, ['Inbox - Gmail']], [AGENT, []]]);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.env.CLAWD_NO_MAC_AX = '1';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('open_app "Google Chrome" while the user\'s Chrome and clawdcursor\'s own both run', () => {
  it('opens a window in clawdcursor\'s own Chrome and focuses it by pid; the user\'s Chrome is never raised', async () => {
    const r = await settle(openApp.handler({ name: 'Google Chrome' }, ctxWith(new CDPDriver())));

    expect(world.front).toBe(AGENT);
    expect(world.focused).not.toContain(USER);
    expect(world.newWindowCalls).toBe(1);
    // Activation by app name is what raised the user's copy.
    expect(execCalls.filter(c => c.cmd === 'open')).toEqual([]);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`pid=${AGENT}`);
    expect(r.text).toMatch(/clawdcursor's own/);
    expect(r.text).toMatch(/not the user's/);
    expect(r.text).not.toContain(String(USER));
  });

  it('clawdcursor\'s Chrome already has a window: focus that one, open no other', async () => {
    world.windows.set(AGENT, ['Example Domain']);
    const r = await settle(openApp.handler({ name: 'chrome' }, ctxWith(new CDPDriver())));
    expect(world.front).toBe(AGENT);
    expect(world.newWindowCalls).toBe(0);
    expect(r.text).toContain('Example Domain');
  });

  it('only the user\'s Chrome runs: open_app opens it, as for any running app (nothing on clawdcursor\'s port)', async () => {
    world.agentUp = false;
    world.windows.delete(AGENT);
    const ax = fakeAx();
    (ax.appState as ReturnType<typeof vi.fn>).mockImplementation(async (n: string) => (n === 'Google Chrome' ? chrome(USER, 1) : null));
    const ctx = { ...ctxWith(new CDPDriver()), platform: new MacOSAdapter({ ax }) } as ToolContext;
    const r = await settle(openApp.handler({ name: 'Google Chrome' }, ctx));
    expect(world.front).toBe(USER);
    expect(r.text).toContain(`pid=${USER}`);
    expect(world.newWindowCalls).toBe(0);
  });

  it('clawdcursor\'s own browser is Edge: open_app "Google Chrome" does not open it', async () => {
    world.agentUserAgent += ' Edg/131.0.2903.70';
    const r = await settle(openApp.handler({ name: 'Google Chrome' }, ctxWith(new CDPDriver())));
    expect(world.newWindowCalls).toBe(0);
    expect(r.text).not.toMatch(/clawdcursor's own/);
  });
});

describe('CDPDriver.showOwnBrowser', () => {
  it('nothing on clawdcursor\'s port: null, and nothing is launched', async () => {
    world.agentUp = false;
    const d = new CDPDriver();
    expect(await d.showOwnBrowser('chrome')).toBeNull();
    expect(d.getConnectionMode()).toBe('unknown');
  });

  it('leaves a connection to a browser the user put on the wire alone', async () => {
    world.userCdpUp = true;
    world.agentUp = false;
    const d = new CDPDriver();
    expect(await d.connect(9223)).toBe(true);
    world.agentUp = true;
    expect(await d.showOwnBrowser('chrome')).toBeNull();
    expect(d.getConnectionMode()).toBe('attached');
    expect(world.newWindowCalls).toBe(0);
  });
});

describe('open_url refuses file:// (open_file / open_uri are the destructive openers) and says where a local page goes', () => {
  it('points at browser navigate, clawdcursor\'s own browser, not at open_app', async () => {
    const openUrl = getExtraTools().find(t => t.name === 'open_url')!;
    const r = await openUrl.handler({ url: 'file:///Users/x/page.html' }, ctxWith(new CDPDriver()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/http:\/\/ or https:\/\//);
    expect(r.text).toContain('browser {"action":"navigate"');
    expect(execCalls).toEqual([]);
  });
});
