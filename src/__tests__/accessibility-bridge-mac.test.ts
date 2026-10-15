/**
 * The legacy AccessibilityBridge (ctx.a11y — what smart_click / smart_type use)
 * on macOS. It had its own osascript paths next to MacOSAdapter's, so fixing the
 * adapter alone left `smart_click` warning "matched outside focused window" for
 * menu-bar items (B7): its getActiveWindow() took the pid of the frontmost app
 * and then the FIRST window of that pid from the window list — "Untitled 4" while
 * the user was typing in "Untitled 7" (B3).
 *
 * The bridge now asks the same AX client as the adapter. `os.platform()` is
 * mocked to darwin so this runs on any OS; the client is a fake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, default: { ...actual, platform: () => 'darwin' }, platform: () => 'darwin' };
});

const fake = vi.hoisted(() => ({
  ax: {
    listWindows: vi.fn(),
    activeWindow: vi.fn(),
    uiTree: vi.fn(),
    find: vi.fn(),
    invoke: vi.fn(),
    frontmost: vi.fn(),
    appState: vi.fn(),
    prepare: vi.fn(),
  },
}));
vi.mock('../platform/mac-ax', async (orig) => ({ ...(await orig<typeof import('../platform/mac-ax')>()), defaultMacAx: () => fake.ax }));

const execFileCalls: string[][] = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => {
    execFileCalls.push([cmd, ...args]);
    cb(null, { stdout: '{}', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { AccessibilityBridge } from '../platform/accessibility';
import { MacAxError } from '../platform/mac-ax';

const R = { x: 5, y: 6, width: 100, height: 40 };
const win = (over: Record<string, unknown> = {}) =>
  ({ title: 'Untitled 7', processName: 'TextEdit', processId: 4242, bounds: R, isMinimized: false, handle: 4242, ...over });

let bridge: AccessibilityBridge;
beforeEach(() => {
  vi.clearAllMocks();
  execFileCalls.length = 0;
  bridge = new AccessibilityBridge();
});

describe('windows', () => {
  it('getWindows reads the AX client, not get-windows.jxa', async () => {
    fake.ax.listWindows.mockResolvedValue([win(), win({ title: 'Docs', processName: 'Safari', processId: 7, handle: 7 })]);
    const wins = await bridge.getWindows(true);
    expect(wins.map(w => w.title)).toEqual(['Untitled 7', 'Docs']);
    expect(wins[0]).toMatchObject({ handle: 4242, processName: 'TextEdit', processId: 4242, bounds: R, isMinimized: false });
    expect(execFileCalls).toHaveLength(0);
  });

  it('B3/B7: getActiveWindow is the FOCUSED window, not the first window of the frontmost pid', async () => {
    // Two documents of one app; the list order says "Untitled 4" first (and it is bigger).
    fake.ax.listWindows.mockResolvedValue([
      win({ title: 'Untitled 4', bounds: { x: 0, y: 0, width: 2257, height: 1140 } }),
      win({ title: 'Untitled 7', bounds: { x: 10, y: 20, width: 603, height: 505 } }),
    ]);
    fake.ax.activeWindow.mockResolvedValue(win({ title: 'Untitled 7', bounds: { x: 10, y: 20, width: 603, height: 505 } }));
    const active = await bridge.getActiveWindow();
    expect(active).toMatchObject({ title: 'Untitled 7', bounds: { x: 10, y: 20, width: 603, height: 505 } });
  });

  it('an active-window failure is null — never a window picked from the list to look plausible', async () => {
    fake.ax.activeWindow.mockRejectedValue(new MacAxError('timeout', 'active window lookup timed out'));
    fake.ax.listWindows.mockResolvedValue([win()]);
    await expect(bridge.getActiveWindow()).resolves.toBeNull();
  });
});

describe('findElement (B9)', () => {
  it('passes the identifier to the client and keeps pid and value for the callers that read them', async () => {
    fake.ax.find.mockResolvedValue([{ name: 'One', controlType: 'Button', automationId: 'One', bounds: R, processId: 321, value: undefined, enabled: true }]);
    const hits = await bridge.findElement({ automationId: 'One', processId: 321 });
    expect(fake.ax.find).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'One', processId: 321 }));
    expect(hits[0]).toMatchObject({ name: 'One', automationId: 'One', controlType: 'Button', bounds: R, processId: 321 });
    expect(execFileCalls).toHaveLength(0);
  });

  it('defaults to the foreground window (an unscoped search must not hit whatever app is walked first)', async () => {
    fake.ax.activeWindow.mockResolvedValue(win({ processId: 555 }));
    fake.ax.find.mockResolvedValue([]);
    await bridge.findElement({ name: 'Save' });
    expect(fake.ax.find).toHaveBeenCalledWith(expect.objectContaining({ name: 'Save', processId: 555 }));
  });

  it('a client failure still reaches the caller (as before)', async () => {
    fake.ax.find.mockRejectedValue(new MacAxError('timeout', 'element search timed out'));
    await expect(bridge.findElement({ name: 'x', processId: 1 })).rejects.toThrow(/timed out/);
  });
});

describe('invokeElement (B9)', () => {
  it('invoke by automationId alone goes to the client with it', async () => {
    fake.ax.invoke.mockResolvedValue({ success: true });
    const res = await bridge.invokeElement({ automationId: 'One', action: 'click', processId: 321 });
    expect(fake.ax.invoke).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'One', action: 'click', processId: 321 }));
    expect(res.success).toBe(true);
  });

  it('keeps the value of a get-value and the click point of a refused click', async () => {
    fake.ax.invoke.mockResolvedValueOnce({ success: true, data: { value: '6,223' } });
    expect((await bridge.invokeElement({ name: 'Display', action: 'get-value', processId: 1 })).value).toBe('6,223');

    fake.ax.invoke.mockResolvedValueOnce({ success: false, bounds: { x: 100, y: 200, width: 50, height: 20 }, error: 'no AXPress' });
    const miss = await bridge.invokeElement({ name: 'Switch', action: 'click', processId: 1 });
    expect(miss).toMatchObject({ success: false, error: 'no AXPress', clickPoint: { x: 125, y: 210 } });
  });
});

describe('getScreenContext', () => {
  it('lists the windows and the focused window\'s tree from the AX client', async () => {
    fake.ax.listWindows.mockResolvedValue([win()]);
    fake.ax.uiTree.mockResolvedValue({
      truncated: false,
      elements: [
        { name: '', controlType: 'Window', bounds: R, depth: 0, automationId: undefined },
        { name: 'One', controlType: 'Button', bounds: { x: 10, y: 20, width: 30, height: 30 }, depth: 1, automationId: 'One' },
      ],
    });
    const ctx = await bridge.getScreenContext(4242);
    expect(ctx).toContain('WINDOWS:');
    expect(ctx).toContain('[TextEdit] "Untitled 7" pid:4242');
    expect(ctx).toContain('FOCUSED WINDOW UI TREE (pid:4242)');
    expect(ctx).toContain('"One"');
    expect(ctx).toContain('id:One');
    expect(fake.ax.uiTree).toHaveBeenCalledWith(4242);
    expect(execFileCalls).toHaveLength(0);
  });
});
