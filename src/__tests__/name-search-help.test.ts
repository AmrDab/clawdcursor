/**
 * A by-name search (find / invoke / smart_click) on a Mac: an Electron app's tree is woken once before the first search, and a
 * miss says when another app's window (a system dialog) is on top of the window searched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wake = vi.hoisted(() => ({ calls: [] as Array<number | undefined> }));
vi.mock('../platform/a11y-wake', async (orig) => ({
  ...(await orig<typeof import('../platform/a11y-wake')>()),
  wakeAccessibility: async (pid: number | undefined) => { wake.calls.push(pid); },
}));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { wakeForNameSearch, onTopOfLine, resetNameSearchState } from '../tools/name-search-help';
import { getA11yTools } from '../tools/a11y';
import { buildUnifiedTools } from '../tools/projected/tools';
import { classifyResult } from '../core/result-codes';
import type { AgentToolContext } from '../tools/projected/types';

const NOTCHO = { processId: 11, processName: 'Notcho', title: 'Notcho', bounds: { x: 100, y: 100, width: 800, height: 600 }, isMinimized: false };
const DIALOG = { processId: 99, processName: 'UserNotificationCenter', title: 'Accessibility Access' };

beforeEach(() => { resetNameSearchState(); wake.calls.length = 0; });

describe('wakeForNameSearch', () => {
  it('macOS: wakes a process once, however many searches', async () => {
    const p = { getActiveWindow: async () => null };
    await wakeForNameSearch(p, 11, 'darwin');
    await wakeForNameSearch(p, 11, 'darwin');
    await wakeForNameSearch(p, 12, 'darwin');
    expect(wake.calls).toEqual([11, 12]);
  });

  it('no processId: the focused window\'s process is woken', async () => {
    await wakeForNameSearch({ getActiveWindow: async () => NOTCHO as never }, undefined, 'darwin');
    expect(wake.calls).toEqual([11]);
  });

  it('Windows and Linux: nothing is sent', async () => {
    await wakeForNameSearch({ getActiveWindow: async () => NOTCHO as never }, 11, 'win32');
    await wakeForNameSearch({ getActiveWindow: async () => NOTCHO as never }, 11, 'linux');
    expect(wake.calls).toEqual([]);
  });
});

describe('onTopOfLine', () => {
  const platform = (at: unknown) => ({
    windowAtPoint: vi.fn(async () => at as never),
    listWindows: async () => [NOTCHO] as never,
    getActiveWindow: async () => NOTCHO as never,
  });

  it('another process at the window centre: names it and the processId to read it with', async () => {
    const p = platform(DIALOG);
    await expect(onTopOfLine(p, 11)).resolves.toBe('→ "Accessibility Access" (UserNotificationCenter, pid 99) is on top of this window; pass processId:99 to read it');
    expect(p.windowAtPoint).toHaveBeenCalledWith(500, 400);
  });

  it('no processId: the focused window is the one searched', async () => {
    await expect(onTopOfLine(platform(DIALOG))).resolves.toContain('pass processId:99');
  });

  it('the same process, unknown, or no windowAtPoint: no line', async () => {
    await expect(onTopOfLine(platform({ processId: 11 }), 11)).resolves.toBeNull();
    await expect(onTopOfLine(platform(null), 11)).resolves.toBeNull();
    await expect(onTopOfLine({ listWindows: async () => [], getActiveWindow: async () => NOTCHO as never }, 11)).resolves.toBeNull();
  });
});

describe('find_element miss', () => {
  const findElement = getA11yTools().find(t => t.name === 'find_element')!;
  const ctxWith = (at: unknown) => ({
    desktop: {}, a11y: {}, cdp: { isConnected: async () => false, getBrowserPid: async () => null },
    platform: {
      getActiveWindow: async () => NOTCHO, listWindows: async () => [NOTCHO], findElements: async () => [], getUiTree: async () => [],
      windowAtPoint: async () => at,
    },
    ensureInitialized: async () => {},
  }) as never;

  it('says which window is on top, outside the untrusted block', async () => {
    const r = await findElement.handler({ name: 'Settings', processId: 11 }, ctxWith(DIALOG));
    expect(r.text).toContain('\n→ "Accessibility Access" (UserNotificationCenter, pid 99) is on top of this window; pass processId:99 to read it');
    expect(r.text.split('→')[0]).not.toMatch(/<untrusted-screen-content>(?![\s\S]*<\/untrusted-screen-content>)/);
  });

  it('nothing on top: the miss has no such line', async () => {
    const r = await findElement.handler({ name: 'Settings', processId: 11 }, ctxWith(null));
    expect(r.text).not.toContain('is on top of this window');
  });
});

describe('invoke_element miss', () => {
  const invoke = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
  const run = async (data: Record<string, unknown>, at: unknown) => {
    const platform = {
      invokeElement: vi.fn(async () => ({ success: false, data })),
      getActiveWindow: async () => NOTCHO, listWindows: async () => [NOTCHO], windowAtPoint: async () => at, listDisplays: async () => [],
    };
    return invoke.execute({ name: 'Settings', processId: 11 }, { platform, task: 't', screenshotsCaptured: { n: 0 }, screen: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 } } as unknown as AgentToolContext);
  };

  it('a plain miss names the window on top', async () => {
    const r = await run({ error: 'Element not found' }, DIALOG);
    expect(r.text).toContain('\n→ "Accessibility Access" (UserNotificationCenter, pid 99) is on top of this window; pass processId:99 to read it');
    expect(classifyResult(r.text, false, true, 'mcp')).toBeTruthy();
  });

  it('an ambiguous or hidden element is not a window on top', async () => {
    expect((await run({ reason: 'ambiguous', candidates: [] }, DIALOG)).text).not.toContain('is on top of this window');
    expect((await run({ reason: 'hidden' }, DIALOG)).text).not.toContain('is on top of this window');
  });

  it('wakes the app once before a by-name invoke on macOS only', async () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
    try { await run({ error: 'not found' }, null); await run({ error: 'not found' }, null); } finally { Object.defineProperty(process, 'platform', real); }
    expect(wake.calls).toEqual([11]);
  });
});
