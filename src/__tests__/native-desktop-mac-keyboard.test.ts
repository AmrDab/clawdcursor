/**
 * NativeDesktop on macOS — the keyboard behind the MCP tools `type_text`, `key_press` and `smart_type` (ctx.desktop).
 *
 * It is a SECOND macOS keyboard, next to MacOSAdapter's, and the "a system dialog owns the keyboard" guard (B11) was written
 * into the adapter only: with a permission prompt up, the MCP `key_press Return` went straight to System Events and could
 * press "Allow" while every tool reported success. Both keyboards now ask the same MacKeyboardGuard; and neither puts the typed
 * text on argv (visible to every process on the Mac) any more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClawdConfig } from '../types';
import type { FrontmostInfo } from '../platform/mac-ax';

vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real.default, platform: () => 'darwin' }, platform: () => 'darwin' };
});
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} },
  keyboard: { config: {}, type: vi.fn() },
  screen: { config: {}, grab: vi.fn(), width: vi.fn(async () => 2240), height: vi.fn(async () => 1260) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('../platform/ps-runner', () => ({ psRunner: { start: vi.fn(), run: vi.fn() } }));
const helper = vi.hoisted(() => ({ type: vi.fn(async () => {}) }));
vi.mock('../platform/native-helper', () => ({ getNativeHelper: () => helper, captureScreenViaHelper: vi.fn() }));
vi.mock('../platform/mac-screen', () => ({ readMainScreenInfo: vi.fn(async () => null) }));

const spawned: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
let osascriptFails = false;
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], a3: unknown, a4?: (e: unknown, r?: unknown) => void) => {
    const cb = (typeof a3 === 'function' ? a3 : a4) as (e: unknown, r?: unknown) => void;
    const rec: { cmd: string; args: string[]; stdin?: string } = { cmd, args };
    spawned.push(rec);
    // An argv-style call (osascript -e …) finishes by itself. A program-on-stdin call finishes when its stdin is closed — like
    // osascript reading to EOF; without this the tests would hang instead of failing.
    if (args.length > 0) { cb(null, { stdout: '', stderr: '' }); return undefined; }
    return {
      stdin: {
        on: () => {},
        end: (data?: string) => { rec.stdin = data; queueMicrotask(() => (osascriptFails ? cb(new Error('osascript failed')) : cb(null, { stdout: '', stderr: '' }))); },
      },
    };
  },
  spawn: vi.fn(),
}));

const fake = vi.hoisted(() => ({ frontmost: vi.fn() }));
vi.mock('../platform/mac-ax', async (orig) => ({ ...(await orig<typeof import('../platform/mac-ax')>()), defaultMacAx: () => ({ frontmost: fake.frontmost }) }));

import { NativeDesktop } from '../platform/native-desktop';
import { logger } from '../core/observability/logger';

const front = (over: Record<string, unknown> = {}): FrontmostInfo => ({
  locked: false,
  app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 1, activationPolicy: 'regular', windows: [], ...over } as FrontmostInfo['app'],
});
const ALERT = front({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory', windows: [{ title: 'Foo wants access', subrole: 'AXSystemDialog' }] });
const MODAL = front({ name: 'SomeAgent', bundleId: 'com.example.agent', processId: 9, activationPolicy: 'accessory', windows: [{ title: 'Allow access?', subrole: 'AXDialog', modal: true }] });

function desktop(): NativeDesktop {
  const d = new NativeDesktop({} as ClawdConfig);
  (d as unknown as { connected: boolean }).connected = true;
  return d;
}
const programs = () => spawned.filter(c => c.cmd === 'osascript').map(c => c.stdin);

beforeEach(() => {
  spawned.length = 0;
  osascriptFails = false;
  helper.type.mockClear();
  fake.frontmost.mockReset();
  fake.frontmost.mockResolvedValue(front());
  process.env.CLAWD_NO_MAC_AX = '0';
});
afterEach(() => { process.env.CLAWD_NO_MAC_AX = '1'; vi.restoreAllMocks(); });

describe('typed text never reaches argv', () => {
  it('typeText sends the program on stdin; osascript has no arguments', async () => {
    await desktop().typeText('my password is hunter2');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual([]);
    expect(spawned[0].stdin).toBe('tell application "System Events" to keystroke "my password is hunter2"');
  });

  it('quotes and backslashes are escaped as before', async () => {
    await desktop().typeText('say "hi" \\ there');
    expect(programs()).toEqual(['tell application "System Events" to keystroke "say \\"hi\\" \\\\ there"']);
  });

  it.each([
    ['mod+v', 'tell application "System Events" to keystroke "v" using {command down}'],
    ['Return', 'tell application "System Events" to key code 36'],
    ['q', 'tell application "System Events" to keystroke "q"'],
    ['+', 'tell application "System Events" to keystroke "+"'],
  ])('keyPress %s: the same program as before, now on stdin', async (combo, program) => {
    await desktop().keyPress(combo);
    expect(programs()).toEqual([program]);
    expect(spawned[0].args).toEqual([]);
  });
});

describe('the keyboard guard covers the MCP route too', () => {
  it('typeText is refused while a system dialog owns the keyboard — nothing is typed, and the CGEvent helper fallback is not used', async () => {
    fake.frontmost.mockResolvedValue(ALERT);
    await expect(desktop().typeText('hello')).rejects.toThrow(/UserNotificationCenter/);
    expect(spawned).toHaveLength(0);
    expect(helper.type).not.toHaveBeenCalled();
  });

  it('keyPress Return is refused too — a Return here could press "Allow"', async () => {
    fake.frontmost.mockResolvedValue(ALERT);
    await expect(desktop().keyPress('Return')).rejects.toThrow(/system dialog/i);
    await expect(desktop().keyPress('mod+v')).rejects.toThrow(/system dialog/i);
    expect(spawned).toHaveLength(0);
  });

  it('a locked screen refuses with an unlock hint', async () => {
    fake.frontmost.mockResolvedValue({ locked: true, app: null });
    await expect(desktop().keyPress('a')).rejects.toThrow(/unlock/i);
  });

  it('a bare Escape is sent regardless: it is how an agent dismisses the dialog', async () => {
    fake.frontmost.mockResolvedValue(ALERT);
    await desktop().keyPress('Escape');
    expect(programs()).toEqual(['tell application "System Events" to key code 53']);
    expect(fake.frontmost).not.toHaveBeenCalled();
  });

  it('a normal app lets everything through, and a burst of keys probes once', async () => {
    const d = desktop();
    await d.keyPress('a'); await d.keyPress('b'); await d.typeText('cd');
    expect(spawned).toHaveLength(3);
    expect(fake.frontmost).toHaveBeenCalledTimes(1);
  });

  it('CLAWD_NO_MAC_AX=1 turns the guard off along with the helper', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    fake.frontmost.mockResolvedValue(ALERT);
    await desktop().keyPress('Return');
    expect(fake.frontmost).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });

  it('a failed probe never blocks input', async () => {
    fake.frontmost.mockRejectedValue(new Error('timed out'));
    await desktop().typeText('x');
    expect(spawned).toHaveLength(1);
  });

  it('when osascript itself fails, the CGEvent helper is still the fallback for typing (guard passed)', async () => {
    osascriptFails = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await desktop().typeText('abc');
    expect(helper.type).toHaveBeenCalledWith('abc');
  });
});

describe('a modal dialog of another app: typed into, and the agent is told', () => {
  beforeEach(() => { vi.spyOn(logger, 'warn').mockImplementation(() => {}); });

  it('the keys are sent and takeInputWarning() says whose dialog has the keyboard — once', async () => {
    fake.frontmost.mockResolvedValue(MODAL);
    const d = desktop();
    await d.keyPress('Return');
    expect(programs()).toHaveLength(1);
    const w = d.takeInputWarning();
    expect(w).toMatch(/SomeAgent/);
    expect(w).toMatch(/Allow access\?/);
    expect(d.takeInputWarning()).toBeNull();
  });

  it('a sequence of keystrokes keeps the warning until it is taken (the cached probe carries it)', async () => {
    fake.frontmost.mockResolvedValue(MODAL);
    const d = desktop();
    await d.keyPress('mod+v');
    await d.keyPress('Return');
    expect(fake.frontmost).toHaveBeenCalledTimes(1);
    expect(d.takeInputWarning()).toMatch(/SomeAgent/);
  });

  it('a clean desktop leaves no warning', async () => {
    const d = desktop();
    await d.typeText('x');
    expect(d.takeInputWarning()).toBeNull();
  });
});
