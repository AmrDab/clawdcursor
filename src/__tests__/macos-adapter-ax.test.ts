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
import { logger } from '../core/observability/logger';
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
  const ax = {
    listWindows: vi.fn(async () => [WIN()]),
    activeWindow: vi.fn(async () => WIN()),
    uiTree: vi.fn(async () => ({ elements: [EL()], truncated: false })),
    find: vi.fn(async () => [EL()]),
    invoke: vi.fn(async () => ({ success: true })),
    frontmost: vi.fn(async () => FRONT()),
    appState: vi.fn(async () => null),
    focusedElement: vi.fn(async () => EL({ name: 'Body', controlType: 'Edit' })),
    prepare: vi.fn(),
    ...over,
  } as Record<string, unknown>;
  // The adapter asks for the detailed list; a test that only fakes `listWindows` gets a complete list built from it.
  ax.listWindowsDetailed ??= vi.fn(async () => ({ windows: await (ax.listWindows as () => Promise<WindowInfo[]>)(), skipped: [] }));
  return ax as never;
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

  // Review finding 1: a list the time budget cut short is a partial list — and says so.
  describe('a window list the time budget cut short', () => {
    const slow = [{ processId: 9, processName: 'Slow App' }, { processId: 10, processName: 'Other Late App' }];

    it('lastWindowListPartial names the apps that were not read', async () => {
      const ax = fakeAx({ listWindowsDetailed: vi.fn(async () => ({ windows: [WIN()], skipped: slow })) });
      const mac = new MacOSAdapter({ ax });
      await expect(mac.listWindows()).resolves.toEqual([WIN()]);
      expect(mac.lastWindowListPartial).toMatch(/partial/i);
      expect(mac.lastWindowListPartial).toContain('Slow App');
      expect(mac.lastWindowListPartial).toContain('Other Late App');
    });

    it('a following complete list clears it', async () => {
      const detailed = vi.fn()
        .mockResolvedValueOnce({ windows: [WIN()], skipped: slow })
        .mockResolvedValueOnce({ windows: [WIN()], skipped: [] });
      const mac = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: detailed }) });
      await mac.listWindows();
      expect(mac.lastWindowListPartial).toBeTruthy();
      await mac.listWindows();
      expect(mac.lastWindowListPartial).toBeNull();
    });

    it('a failed list leaves no stale note behind', async () => {
      const detailed = vi.fn()
        .mockResolvedValueOnce({ windows: [WIN()], skipped: slow })
        .mockRejectedValueOnce(new MacAxError('timeout', 'window list timed out'));
      const mac = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: detailed }) });
      await mac.listWindows();
      await expect(mac.listWindows()).rejects.toThrow(/timed out/);
      expect(mac.lastWindowListPartial).toBeNull();
    });

    it('a long list of skipped apps stays one readable line', async () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ processId: 100 + i, processName: `App ${i}` }));
      const mac = new MacOSAdapter({ ax: fakeAx({ listWindowsDetailed: vi.fn(async () => ({ windows: [WIN()], skipped: many })) }) });
      await mac.listWindows();
      expect(mac.lastWindowListPartial).toContain('30');
      expect(mac.lastWindowListPartial!.length).toBeLessThan(300);
      expect(mac.lastWindowListPartial).not.toContain('\n');
    });
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

  it('without the helper (lsappinfo knows the process, not its windows) an app that is up is still focused, not launched again', async () => {
    const ax = fakeAx({
      appState: vi.fn(async () => APP({ windows: [], windowsKnown: false })),
      listWindows: vi.fn(async () => [WIN({ title: 'Other', processId: 1, handle: 1 }), WIN()]),
    });
    const res = await settle(new MacOSAdapter({ ax }).launchApp('TextEdit'));
    expect(res).toMatchObject({ pid: 4242, title: 'Untitled 7' });
    expect(opens()).toHaveLength(0);
    expect(osascripts().some(c => c.args.join(' ').includes('focus-window.jxa'))).toBe(true);
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

  it('the Spotlight fallback leaves a system dialog alone: not even its warm-up Escape is sent (that could answer "Don\'t Allow" for the user)', async () => {
    // Escape is let through when an agent asks for it; the launch fallback is plumbing the user never asked to dismiss anything with.
    const ax = fakeAx({
      appState: vi.fn(async () => null),
      listWindows: vi.fn(async () => []),
      frontmost: vi.fn(async () => FRONT({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory', windows: [{ title: 'Foo wants access', subrole: 'AXSystemDialog' }] })),
    });
    await expect(settle(new MacOSAdapter({ ax }).launchApp('Nope'))).rejects.toThrow();
    expect(osascripts()).toHaveLength(0);
  });

  // Review of 4ee6279, finding 4: a modal dialog of a non-system app is typed into when an AGENT asks (a warning), but the
  // launch fallback is plumbing — Escape, Cmd+Space, the app's name and Return all went into that dialog, Return pressing its
  // default button.
  it('the Spotlight fallback does not type into a modal dialog of another app either — and the error names it', async () => {
    const ax = fakeAx({
      appState: vi.fn(async () => null),
      listWindows: vi.fn(async () => []),
      frontmost: vi.fn(async () => FRONT({ name: 'SomeAgent', bundleId: 'com.example.agent', processId: 9, activationPolicy: 'accessory', windows: [{ title: 'Delete everything?', subrole: 'AXDialog', modal: true }] })),
    });
    await expect(settle(new MacOSAdapter({ ax }).launchApp('Nope'))).rejects.toThrow(/SomeAgent/);
    expect(osascripts()).toHaveLength(0);
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

  // Review finding 4: with a real permission / Gatekeeper alert up even Escape was refused, so the agent could not
  // dismiss the very thing that blocked it. Escape cancels — it never grants (a stray Return is what presses "Allow").
  it.each(['Escape', 'esc', 'ESCAPE'])('%s always goes through, even while a system dialog owns the keyboard', async key => {
    const ax = fakeAx({ frontmost: vi.fn(async () => alert) });
    const mac = new MacOSAdapter({ ax });
    await mac.keyPress(key);
    expect(osascripts()).toHaveLength(1);
    expect(ax.frontmost).not.toHaveBeenCalled();
  });

  it('Escape goes through on a locked screen as well (nothing to protect there)', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => ({ locked: true, app: null })) }) });
    await mac.keyPress('Escape');
    expect(osascripts()).toHaveLength(1);
  });

  it('but Escape inside a combo is not the bare key: cmd+Escape is still guarded', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => alert) }) });
    await expect(mac.keyPress('cmd+Escape')).rejects.toThrow(/system dialog/i);
  });

  it('and Return, Tab and typed text stay refused while the dialog is up', async () => {
    const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => alert) }) });
    for (const key of ['Return', 'Tab', 'space']) await expect(mac.keyPress(key)).rejects.toThrow(/system dialog/i);
    await expect(mac.typeText('y')).rejects.toThrow(/system dialog/i);
    expect(osascripts()).toHaveLength(0);
  });

  describe('a modal dialog of an unknown accessory app (1Password Quick Access, a launcher panel)', () => {
    const modal = FRONT({ name: 'SomeAgent', bundleId: 'com.example.agent', processId: 9, activationPolicy: 'accessory', windows: [{ title: 'Allow access?', subrole: 'AXDialog', modal: true }] });
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());

    it('is typed into — and the warning names whose dialog it is', async () => {
      const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => modal) }) });
      await mac.typeText('hello');
      await mac.keyPress('Return');
      expect(osascripts().length).toBeGreaterThanOrEqual(2);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls[0])).toContain('SomeAgent');
    });

    it('warns once per dialog, not once per keystroke burst', async () => {
      const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => modal) }) });
      await mac.typeText('a');
      await vi.advanceTimersByTimeAsync(300);        // past the 250 ms probe cache: a new probe, same dialog
      await mac.typeText('b');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a system dialog is still refused, warning or not', async () => {
      const mac = new MacOSAdapter({ ax: fakeAx({ frontmost: vi.fn(async () => alert) }) });
      await expect(mac.typeText('hello')).rejects.toThrow(/system dialog/i);
      expect(warn).not.toHaveBeenCalled();
    });
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


// Review of 4ee6279, finding 3: the agent loop reads `res.data?.error`; this adapter returned the reason top-level only (Linux
// copies it into data.error), so every refusal — ambiguous role, secure field, the candidate list — read "element not found
// or not actionable".
describe('invokeElement — the reason a call failed reaches the caller', () => {
  it('a failure puts its reason in data.error, next to the refusal flag', async () => {
    const ax = fakeAx({ invoke: vi.fn(async () => ({ success: false, error: 'role="AXTextField" matches 2 elements — "a", "b"', data: { refused: true } })) });
    const res = await new MacOSAdapter({ ax }).invokeElement({ processId: 7, controlType: 'Edit', action: 'set-value', value: 'x' });
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ error: 'role="AXTextField" matches 2 elements — "a", "b"', refused: true });
  });

  it('keeps the bounds a refused click hands back', async () => {
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    const ax = fakeAx({ invoke: vi.fn(async () => ({ success: false, error: 'does not support AXPress', bounds })) });
    const res = await new MacOSAdapter({ ax }).invokeElement({ processId: 7, name: 'Switch', action: 'click' });
    expect(res.bounds).toEqual(bounds);
    expect(res.data).toMatchObject({ error: 'does not support AXPress' });
  });

  it('a success carries no error and its data is untouched', async () => {
    const ax = fakeAx({ invoke: vi.fn(async () => ({ success: true, data: { value: 'abc' } })) });
    const res = await new MacOSAdapter({ ax }).invokeElement({ processId: 7, name: 'Display', action: 'get-value' });
    expect(res).toEqual({ success: true, data: { value: 'abc' } });
  });
});

// Review of 4ee6279, finding 5: the old placeholder "(not responding)" window made `focus_window processName:X` work for an app
// the window list had not reached. With no placeholder the lookup found nothing, and said so without a hint.
describe('focusWindow by process name when the window list is partial or failed', () => {
  const slowApp = APP({ name: 'Slow App', processId: 9, windows: [] });

  it('an app the list skipped is found through NSWorkspace instead', async () => {
    const ax = fakeAx({
      listWindowsDetailed: vi.fn(async () => ({ windows: [WIN()], skipped: [{ processId: 9, processName: 'Slow App' }] })),
      appState: vi.fn(async () => slowApp),
    });
    await new MacOSAdapter({ ax }).focusWindow({ processName: 'Slow App' });
    expect(ax.appState).toHaveBeenCalledWith('Slow App');
    const focus = osascripts().find(c => c.args.some(a => /focus-window\.jxa$/.test(a)));
    expect(focus?.args).toEqual(expect.arrayContaining(['-processId', '9']));
  });

  it('a window list that failed outright does not stop the lookup either', async () => {
    const ax = fakeAx({
      listWindows: vi.fn(async () => { throw new MacAxError('timeout', 'window list timed out'); }),
      appState: vi.fn(async () => slowApp),
    });
    await new MacOSAdapter({ ax }).focusWindow({ processName: 'Slow App' });
    expect(osascripts().find(c => c.args.includes('9'))).toBeTruthy();
  });

  it('an app found in the list is not looked up twice', async () => {
    const ax = fakeAx({ listWindows: vi.fn(async () => [WIN({ processName: 'TextEdit', processId: 4242 })]) });
    await new MacOSAdapter({ ax }).focusWindow({ processName: 'TextEdit' });
    expect(ax.appState).not.toHaveBeenCalled();
  });

  it('unknown to both: false, and no script is run', async () => {
    const ax = fakeAx({ listWindows: vi.fn(async () => []), appState: vi.fn(async () => null) });
    await expect(new MacOSAdapter({ ax }).focusWindow({ processName: 'Nope' })).resolves.toBe(false);
    expect(osascripts()).toHaveLength(0);
  });
});

describe('getFocusedElement', () => {
  it('is the client\'s focused element', async () => {
    const ax = fakeAx();
    await expect(new MacOSAdapter({ ax }).getFocusedElement()).resolves.toMatchObject({ name: 'Body', controlType: 'Edit' });
  });

  it('a failed read is "nothing focused" (callers treat it as optional), as before', async () => {
    const ax = fakeAx({ focusedElement: vi.fn(async () => { throw new MacAxError('timeout', 'x'); }) });
    await expect(new MacOSAdapter({ ax }).getFocusedElement()).resolves.toBeNull();
  });
});
