/**
 * `computer key combo:"shift"` answered `Unknown key: "shift"` on macOS (live blind run of 2026-10-19): a modifier pressed on its
 * own is a legitimate key press (a Shift tap to wake a sleeping field, to cancel a key repeat, or as a no-op probe), and the
 * Windows/Linux adapters take it. Any other token that is neither a modifier nor a key is still refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const programs = vi.hoisted(() => [] as string[]);
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => ({
    stdin: { on: () => {}, end: (data?: string) => { if (data !== undefined) programs.push(data); queueMicrotask(() => cb(null, { stdout: '', stderr: '' })); } },
  }),
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';
import type { MacAx } from '../platform/mac-ax';

const mac = new MacOSAdapter({ ax: { frontmost: vi.fn(), prepare: vi.fn() } as unknown as MacAx });
beforeEach(() => { programs.length = 0; process.env.CLAWD_NO_MAC_AX = '1'; });

describe('a modifier pressed on its own', () => {
  it.each([
    ['shift', 56], ['Shift', 56],
    ['cmd', 55], ['command', 55], ['mod', 55], ['meta', 55],
    ['ctrl', 59], ['control', 59],
    ['alt', 58], ['option', 58], ['opt', 58],
  ])('%s is key code %i', async (name, code) => {
    await mac.keyPress(name);
    expect(programs).toEqual([`tell application "System Events" to key code ${code}`]);
  });

  it('still a modifier when it is the last token of nothing: "shift+a" and "cmd+shift+t" are unchanged', async () => {
    await mac.keyPress('shift+a');
    await mac.keyPress('cmd+shift+t');
    expect(programs).toEqual([
      'tell application "System Events" to keystroke "a" using {shift down}',
      'tell application "System Events" to keystroke "t" using {command down, shift down}',
    ]);
  });

  it('a name that is neither a modifier nor a key is still refused, and nothing is sent', async () => {
    await expect(mac.keyPress('notarealkey')).rejects.toThrow('Unknown key: "notarealkey"');
    await expect(mac.keyPress('bogusmod+a')).rejects.toThrow('Unknown modifier: "bogusmod"');
    expect(programs).toEqual([]);
  });
});
