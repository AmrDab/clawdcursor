/**
 * MacOSAdapter on top of the AX client (src/platform/mac-ax.ts): what the
 * adapter does with the client's answers. The client itself is covered by
 * mac-ax.test.ts; here it is a fake, so no test touches a real Mac.
 *
 * Bugs from the 2026-10-15 blind test on a real Mac that these pin down:
 *  B1  window list: a timeout became "Windows (0)".
 *  B2  open_app: "Could not confirm … no window appeared" for apps that had
 *      launched (the pid was only learned from the slow window list).
 *  B3  window active: "Untitled 4" while the user was typing in "Untitled 7".
 *  B4  read_tree: a 12 s timeout reported as "empty a11y tree — custom-canvas".
 *  B9  invoke/find by automationId.
 *  B11 a system dialog owns the keyboard but System Events still names the app behind it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const execCalls: Array<{ cmd: string; args: string[] }> = [];
let execFail: ((cmd: string, args: string[]) => Error | null) | null = null;
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    execCalls.push({ cmd, args });
    const err = execFail?.(cmd, args) ?? null;
    if (err) cb(err);
    else cb(null, { stdout: '{}', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';
import { MacAxError, type MacAx, type AppState, type FrontmostInfo } from '../platform/mac-ax';
import type { UiElement, WindowInfo } from '../platform/types';

const RECT = { x: 0, y: 0, width: 600, height: 400 };
const WIN = (over: Partial<WindowInfo> = {}): WindowInfo =>
  ({ title: 'Untitled 7', processName: 'TextEdit', processId: 4242, bounds: RECT, isMinimized: false, handle: 4242, ...over });
const EL = (over: Partial<UiElement> = {}): UiElement => ({ name: 'One', controlType: 'Button', bounds: RECT, automationId: 'One', ...over });
const APP = (over: Partial<AppState> = {}): AppState =>
  ({ name: 'TextEdit', processId: 4242, finishedLaunching: true, active: true, activationPolicy: 'regular', windows: [WIN()], windowsKnown: true, ...over });
const FRONT = (over: Partial<NonNullable<FrontmostInfo['app']>> = {}): FrontmostInfo =>
  ({ locked: false, app: { name: 'TextEdit', processId: 4242, activationPolicy: 'regular', windows: [], ...over } });

function fakeAx(over: Partial<MacAx> = {}): MacAx & { [K in keyof MacAx]: ReturnType<typeof vi.fn> } {
  return {
    listWindows: vi.fn(async () => [WIN()]),
    activeWindow: vi.fn(async () => WIN()),
    uiTree: vi.fn(async () => ({ elements: [EL()], truncated: false })),
    find: vi.fn(async () => [EL()]),
    invoke: vi.fn(async () => ({ success: true })),
    frontmost: vi.fn(async () => FRONT()),
    appState: vi.fn(async () => null),
    prepare: vi.fn(),
    ...over,
  } as never;
}

/** Successive answers for a mocked call; the last one repeats. (`shift() ?? x` would turn a null answer into x.) */
function sequence<T>(...answers: T[]): () => Promise<T> {
  let i = 0;
  return async () => answers[Math.min(i++, answers.length - 1)];
}

/** Drive fake timers until the promise settles (the launch flow sleeps between polls). */
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

beforeEach(() => {
  execCalls.length = 0;
  execFail = null;
  process.env.CLAWD_NO_MAC_AX = '0';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  process.env.CLAWD_NO_MAC_AX = '1';
});

const osascripts = () => execCalls.filter(c => c.cmd === 'osascript');
const opens = () => execCalls.filter(c => c.cmd === 'open');

describe('windows (B1, B3)', () => {
  it('B1: listWindows returns the client\'s windows', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx() });
    await expect(mac.listWindows()).resolves.toEqual([WIN()]);
  });

  it('B1: a client timeout reaches the caller as an error — never an empty list', async () => {
    const ax = fakeAx({ listWindows: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }) });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.listWindows()).rejects.toThrow(/timed out/);
  });

  it('B3: getActiveWindow is the client\'s focused window, with its own title and bounds', async () => {
    const focused = WIN({ title: 'Untitled 7', bounds: { x: 1, y: 2, width: 603, height: 505 } });
    const mac = new MacOSAdapter({ ax: fakeAx({ activeWindow: vi.fn(async () => focused) }) });
    await expect(mac.getActiveWindow()).resolves.toEqual(focused);
  });

  it('getActiveWindow: nothing frontmost is null, a failure is an error', async () => {
    expect(await new MacOSAdapter({ ax: fakeAx({ activeWindow: vi.fn(async () => null) }) }).getActiveWindow()).toBeNull();
    const ax = fakeAx({ activeWindow: vi.fn(async () => { throw new MacAxError('locked', 'screen is locked'); }) });
    await expect(new MacOSAdapter({ ax }).getActiveWindow()).rejects.toThrow(/locked/);
  });

  it('focusWindow by process name survives a failed window list (resolves to false, not a throw)', async () => {
    const ax = fakeAx({ listWindows: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }) });
    await expect(new MacOSAdapter({ ax }).focusWindow({ processName: 'TextEdit' })).resolves.toBe(false);
  });
});

describe('getUiTree (B4, B9)', () => {
  it('returns the flattened elements for the pid', async () => {
    const ax = fakeAx();
    const tree = await new MacOSAdapter({ ax }).getUiTree(321);
    expect(ax.uiTree).toHaveBeenCalledWith(321);
    expect(tree).toEqual([EL()]);
  });

  it('exposes a time-budget cut-off through lastTreeTruncated', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ uiTree: vi.fn(async () => ({ elements: [EL()], truncated: true })) }) });
    await mac.getUiTree(1);
    expect(mac.lastTreeTruncated).toBe(true);
    const ok = new MacOSAdapter({ ax: fakeAx() });
    await ok.getUiTree(1);
    expect(ok.lastTreeTruncated).toBe(false);
  });

  it('B4: a timeout is an error that says so — not an empty tree', async () => {
    const ax = fakeAx({ uiTree: vi.fn(async () => { throw new MacAxError('timeout', 'accessibility tree read (pid 7) timed out after 12s'); }) });
    await expect(new MacOSAdapter({ ax }).getUiTree(7)).rejects.toThrow(/timed out after 12s/);
  });

  it('without a pid it asks for the frontmost app\'s tree', async () => {
    const ax = fakeAx();
    await new MacOSAdapter({ ax }).getUiTree();
    expect(ax.uiTree).toHaveBeenCalledWith(undefined);
  });
});

describe('findElements (B9)', () => {
  it('passes name, role, identifier and pid through', async () => {
    const ax = fakeAx();
    await new MacOSAdapter({ ax }).findElements({ name: 'One', controlType: 'Button', automationId: 'One', processId: 9 });
    expect(ax.find).toHaveBeenCalledWith({ name: 'One', controlType: 'Button', automationId: 'One', processId: 9 });
  });

  it('scopes an unscoped query to the active window, like Windows and the invoke path', async () => {
    const ax = fakeAx({ activeWindow: vi.fn(async () => WIN({ processId: 555 })) });
    const mac = new MacOSAdapter({ ax });
    await mac.findElements({ automationId: 'One' });
    expect(ax.find).toHaveBeenCalledWith(expect.objectContaining({ processId: 555, automationId: 'One' }));
    expect(mac.lastFindScope).toEqual([expect.objectContaining({ processId: 555, processName: 'TextEdit' })]);
  });

  it('a timeout is reported through lastFindError (what the find tool turns into "TIMED OUT")', async () => {
    const ax = fakeAx({ find: vi.fn(async () => { throw new MacAxError('timeout', 'element search timed out'); }) });
    const mac = new MacOSAdapter({ ax });
    await expect(mac.findElements({ name: 'x', processId: 1 })).resolves.toEqual([]);
    expect(mac.lastFindError).toBe('timeout');
    await mac.findElements({ name: 'x', processId: 1 }).catch(() => {});
    ax.find.mockResolvedValueOnce([EL()]);
    await mac.findElements({ name: 'x', processId: 1 });
    expect(mac.lastFindError).toBeNull();
  });

  it('a locked screen is not "no elements found": it throws', async () => {
    const ax = fakeAx({ find: vi.fn(async () => { throw new MacAxError('locked', 'screen is locked'); }) });
    await expect(new MacOSAdapter({ ax }).findElements({ name: 'x', processId: 1 })).rejects.toThrow(/locked/);
  });
});

describe('invokeElement (B9)', () => {
  it('B9: forwards automationId and the action to the client', async () => {
    const ax = fakeAx();
    const res = await new MacOSAdapter({ ax }).invokeElement({ automationId: 'One', processId: 9, action: 'click' } as never);
    expect(ax.invoke).toHaveBeenCalledWith({ automationId: 'One', processId: 9, action: 'click' });
    expect(res.success).toBe(true);
  });

  it('defaults to the foreground process when no pid is given', async () => {
    const ax = fakeAx({ activeWindow: vi.fn(async () => WIN({ processId: 777 })) });
    await new MacOSAdapter({ ax }).invokeElement({ name: 'OK', action: 'click' });
    expect(ax.invoke).toHaveBeenCalledWith(expect.objectContaining({ processId: 777, name: 'OK' }));
  });

  it('returns the miss and its bounds, so the caller can click by coordinates', async () => {
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    const ax = fakeAx({ invoke: vi.fn(async () => ({ success: false, bounds, error: 'no AXPress' })) });
    await expect(new MacOSAdapter({ ax }).invokeElement({ name: 'OK', processId: 1, action: 'click' }))
      .resolves.toMatchObject({ success: false, bounds });
  });

  it('a timeout is an error, not "not found"', async () => {
    const ax = fakeAx({ invoke: vi.fn(async () => { throw new MacAxError('timeout', 'accessibility invoke timed out'); }) });
    await expect(new MacOSAdapter({ ax }).invokeElement({ name: 'OK', processId: 1, action: 'click' })).rejects.toThrow(/timed out/);
  });
});

describe('launchApp (B2 — confirm the launch from the process, not the window list)', () => {
  it('open → the app registers with a window → Opened, with no window-list round trip and no Spotlight typing', async () => {
    const ax = fakeAx({ appState: vi.fn(sequence<AppState | null>(null, null, APP())) });
    const mac = new MacOSAdapter({ ax });
    const res = await settle(mac.launchApp('TextEdit'));
    expect(res).toEqual({ pid: 4242, title: 'Untitled 7', handle: 4242 });
    expect(opens().map(c => c.args)).toEqual([['-a', 'TextEdit']]);
    expect(ax.listWindows).not.toHaveBeenCalled();
    expect(osascripts()).toHaveLength(0);
  });

  it('an app whose window has no title (Calculator) is named after the app', async () => {
    const calc = APP({ name: 'Calculator', processId: 88, windows: [WIN({ title: '', processName: 'Calculator', processId: 88, handle: 88 })] });
    // not running before the launch, running after
    const ax = fakeAx({ appState: vi.fn(sequence<AppState | null>(null, calc)) });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('Calculator'));
    expect(res).toMatchObject({ pid: 88, title: 'Calculator' });
  });

  it('already running with a window: focus it, do not launch again', async () => {
    const ax = fakeAx({ appState: vi.fn(async () => APP()) });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('TextEdit'));
    expect(res).toMatchObject({ pid: 4242, title: 'Untitled 7' });
    expect(opens()).toHaveLength(0);
    // focused by pid through the focus script
    expect(osascripts().some(c => c.args.join(' ').includes('focus-window.jxa') && c.args.includes('4242'))).toBe(true);
  });

  it('running but no window within the budget: report the pid (still loading), not a failure, and do not touch Spotlight', async () => {
    // not running before the launch, then up but windowless for the whole budget
    const ax = fakeAx({ appState: vi.fn(sequence<AppState | null>(null, APP({ finishedLaunching: false, windows: [] }))) });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('Slow App'));
    expect(res).toEqual({ pid: 4242 });
    expect(osascripts().filter(c => c.args.includes('-e'))).toHaveLength(0);
  });

  it('alwaysNewInstance uses open -n and waits for a NEW pid', async () => {
    const first = APP({ processId: 1, windows: [] });
    const second = APP({ processId: 2, windows: [WIN({ processId: 2, handle: 2 })] });
    const ax = fakeAx({ appState: vi.fn(sequence<AppState | null>(first, first, second)) });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('TextEdit', { alwaysNewInstance: true }));
    expect(opens()[0].args).toEqual(['-n', '-a', 'TextEdit']);
    expect(res.pid).toBe(2);
  });

  it('when the process state cannot be read it falls back to the old window-diff, and still finds the window', async () => {
    const before = [WIN({ title: 'Other', processName: 'Other', processId: 1, handle: 1 })];
    const lists = [before, before, [...before, WIN({ title: 'New Doc', processName: 'Pages', processId: 5, handle: 5 })]];
    const ax = fakeAx({
      appState: vi.fn(async () => { throw new MacAxError('timeout', 'app state lookup timed out'); }),
      listWindows: vi.fn(async () => lists.shift() ?? lists[0] ?? before),
    });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('Pages'));
    expect(res).toMatchObject({ pid: 5, title: 'New Doc' });
  });

  it('never launched and no system dialog in the way: the old empty result (the tool then says it could not confirm)', async () => {
    const ax = fakeAx({ appState: vi.fn(async () => null), listWindows: vi.fn(async () => []) });
    await expect(settle(new MacOSAdapter({ ax }).launchApp('Nope'))).resolves.toEqual({});
  });

  it('B11: never launched because a system dialog owns the keyboard — the error says so', async () => {
    const ax = fakeAx({
      appState: vi.fn(async () => null),
      listWindows: vi.fn(async () => []),
      frontmost: vi.fn(async () => FRONT({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory' })),
    });
    await expect(settle(new MacOSAdapter({ ax }).launchApp('Nope'))).rejects.toThrow(/UserNotificationCenter/);
  });

  it('rejects control characters in the name before anything runs', async () => {
    const ax = fakeAx();
    await expect(new MacOSAdapter({ ax }).launchApp('Text\nEdit')).rejects.toThrow(/illegal characters/);
    expect(ax.appState).not.toHaveBeenCalled();
  });
});

describe('keyboard guard (B11)', () => {
  const alert = FRONT({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory', windows: [{ title: 'Foo wants access', subrole: 'AXSystemDialog' }] });

  it('typeText is refused while a system dialog owns the keyboard, and nothing is sent', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => alert) }) });
    await expect(mac.typeText('hello')).rejects.toThrow(/UserNotificationCenter/);
    expect(osascripts()).toHaveLength(0);
  });

  it('keyPress is refused too — a Return here could press "Allow"', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => alert) }) });
    await expect(mac.keyPress('Return')).rejects.toThrow(/system dialog/i);
    expect(osascripts()).toHaveLength(0);
  });

  it('a locked screen refuses keys with an unlock hint', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => ({ locked: true, app: null })) }) });
    await expect(mac.typeText('x')).rejects.toThrow(/unlock/i);
  });

  it('a normal frontmost app lets keys through', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx() });
    await mac.typeText('hello');
    await mac.keyPress('Return');
    expect(osascripts().length).toBeGreaterThanOrEqual(2);
  });

  it('a failed probe never blocks input (fail open)', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => { throw new MacAxError('timeout', 'x'); }) }) });
    await mac.typeText('hello');
    expect(osascripts()).toHaveLength(1);
  });

  it('probes once for a burst of keystrokes, but re-probes every time while blocked', async () => {
    const ok = fakeAx();
    const mac = new MacOSAdapter({ ax: ok });
    await mac.keyPress('a');
    await mac.keyPress('b');
    await mac.keyPress('c');
    expect(ok.frontmost).toHaveBeenCalledTimes(1);

    const blocked = fakeAx({ frontmost: vi.fn(async () => alert) });
    const mac2 = new MacOSAdapter({ ax: blocked });
    await mac2.keyPress('a').catch(() => {});
    await mac2.keyPress('b').catch(() => {});
    expect(blocked.frontmost).toHaveBeenCalledTimes(2);
  });

  it('CLAWD_NO_MAC_AX=1 turns the guard off along with the helper', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    const ax = fakeAx({ frontmost: vi.fn(async () => alert) });
    await new MacOSAdapter({ ax }).typeText('hello');
    expect(ax.frontmost).not.toHaveBeenCalled();
    expect(osascripts()).toHaveLength(1);
  });
});
