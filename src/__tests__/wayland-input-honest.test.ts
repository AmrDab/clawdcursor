/**
 * Linux / Wayland input is honest (audit 2026-11-19, item 25). No Linux machine here: every external tool is a double.
 *  - a Wayland session with no input tool throws, from the backend and from NativeDesktop (smart_click's coordinate fallback,
 *    smart_type), instead of nut-js sending events nothing receives and the call saying it was done;
 *  - wtype's failure is the call's failure; a modifier that could not be released is said.
 * The X11 side (a failed press is an error, the keys are released in `finally`) is in linux-adapter.test.ts.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, setPosition: vi.fn(async () => {}), click: vi.fn(async () => {}), doubleClick: vi.fn(async () => {}), rightClick: vi.fn(async () => {}) },
  keyboard: { config: {}, type: vi.fn(async () => {}), pressKey: vi.fn(async () => {}), releaseKey: vi.fn(async () => {}) },
  screen: { config: {}, grab: vi.fn(), width: vi.fn(async () => 1920), height: vi.fn(async () => 1080) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const exec = vi.hoisted(() => ({ calls: [] as string[][], fail: null as null | ((args: string[]) => boolean) }));
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => {
    exec.calls.push([cmd, ...args]);
    if (exec.fail?.([cmd, ...args])) cb(new Error(`${cmd} failed`));
    else cb(null, { stdout: '', stderr: '' });
    return { stdin: { on: () => {}, end: () => {} } };
  },
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

const platform = vi.hoisted(() => ({ adapter: null as null | Record<string, unknown> }));
vi.mock('../platform/index', () => ({ getPlatform: async () => platform.adapter }));

import { WaylandBackend } from '../platform/wayland-backend';
import { NativeDesktop } from '../platform/native-desktop';
import { mouse, keyboard } from '@nut-tree-fork/nut-js';
import type { ClawdConfig } from '../types';

beforeEach(() => { exec.calls.length = 0; exec.fail = null; });

describe('the Wayland backend says what it cannot do, and what failed', () => {
  it('no backend: key presses and typing throw, nothing is run', async () => {
    const none = new WaylandBackend('none');
    await expect(none.keyPress('ctrl+s')).rejects.toThrow(/No input backend/);
    await expect(none.typeText('hi')).rejects.toThrow(/No input backend/);
    expect(exec.calls).toEqual([]);
  });

  it('a wtype failure is the call\'s failure, not a done', async () => {
    exec.fail = a => a[0] === 'wtype';
    await expect(new WaylandBackend('wtype-keyboard-only').keyPress('ctrl+s')).rejects.toThrow(/wtype failed/);
  });

  it('a modifier whose release failed is said, and every release was still tried', async () => {
    exec.fail = a => a[0] === 'ydotool' && a.includes('29:0');     // Ctrl up
    await expect(new WaylandBackend('ydotool', 'modern').keyPress('ctrl+shift+s')).rejects.toThrow(/may still be held/);
    expect(exec.calls).toContainEqual(['ydotool', 'key', '42:0']);   // Shift was released too
    expect(exec.calls).toContainEqual(['ydotool', 'key', '29:0']);
  });
});

describe('NativeDesktop on a Wayland session: input goes through the Linux adapter, which throws when it has no tool', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const saved = { type: process.env.XDG_SESSION_TYPE };
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
    process.env.XDG_SESSION_TYPE = 'wayland';
  });
  afterAll(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    if (saved.type === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = saved.type;
  });

  const desktop = () => {
    const d = new NativeDesktop({} as ClawdConfig);
    (d as unknown as { connected: boolean }).connected = true;
    return d;
  };
  const NO_TOOL = new Error('No input backend on this Wayland session: clicking needs ydotool with ydotoold running. Nothing was sent.');

  it('with no input tool, a click, typing and a key press throw, and nut-js sends nothing', async () => {
    platform.adapter = {
      mouseClick: vi.fn(async () => { throw NO_TOOL; }),
      typeText: vi.fn(async () => { throw NO_TOOL; }),
      keyPress: vi.fn(async () => { throw NO_TOOL; }),
    };
    const d = desktop();
    await expect(d.mouseClick(10, 20)).rejects.toThrow(/No input backend/);
    await expect(d.typeText('hello')).rejects.toThrow(/No input backend/);
    await expect(d.keyPress('mod+a')).rejects.toThrow(/No input backend/);
    expect(mouse.click).not.toHaveBeenCalled();
    expect(keyboard.type).not.toHaveBeenCalled();
    expect(keyboard.pressKey).not.toHaveBeenCalled();
  });

  it('with a tool, the adapter is handed the click, the text and the keys', async () => {
    const adapter = { mouseClick: vi.fn(async () => {}), typeText: vi.fn(async () => {}), keyPress: vi.fn(async () => {}) };
    platform.adapter = adapter;
    const d = desktop();
    await d.mouseClick(10, 20);
    await d.typeText('hello');
    await d.keyPress('mod+a');
    expect(adapter.mouseClick).toHaveBeenCalledWith(10, 20, { button: 'left' });
    expect(adapter.typeText).toHaveBeenCalledWith('hello');
    expect(adapter.keyPress).toHaveBeenCalledWith('mod+a');
  });
});
