/**
 * WaylandBackend must speak the ydotool generation that is installed.
 *
 * Ubuntu 24.04 / Debian ship ydotool 0.1.8: `click <1|2|3>`, `key <NAME+NAME>`,
 * `mousemove <x> <y>` (absolute, no --absolute, no wheel), no scroll. The 1.x
 * syntax clawdcursor used (`mousemove --absolute -x`, `key 29:1`, `click 0xC0`)
 * either exits 0 doing nothing or types digits. Conversely 1.x has no `scroll`
 * subcommand: the wheel is `mousemove -w -x <h> -y <v>`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[][]);
const state = vi.hoisted(() => ({ help: '', helpFails: false }));

const LEGACY_HELP = 'Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  key\n  mousemove\n  recorder\n  type\n';
const MODERN_HELP = 'Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n  stdin\nUse environment variable YDOTOOL_SOCKET to specify daemon socket.\n';

vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ydotool' && args[0] === 'help') {
      if (state.helpFails) throw new Error('spawn ENOENT');
      // 0.1.8 prints usage on stderr, 1.x on stdout — either must work.
      return state.help.includes('YDOTOOL_SOCKET') ? { stdout: state.help, stderr: '' } : { stdout: '', stderr: state.help };
    }
    return { stdout: '', stderr: '' };
  };
  const execFile: any = (...a: unknown[]) => {
    const cb = a[a.length - 1] as (e: Error | null, out?: string, err?: string) => void;
    try { const r = run(a[0] as string, a[1] as string[]); cb(null, r.stdout, r.stderr); } catch (e) { cb(e as Error); }
  };
  execFile[promisify.custom] = async (cmd: string, args: string[]) => run(cmd, args);
  return { execFile, execFileSync: vi.fn(), exec: vi.fn(), spawn: vi.fn() };
});

import { WaylandBackend } from '../platform/wayland-backend';

const hasYdotool = async (name: string) => name === 'ydotool';
const ydotoolCalls = () => calls.filter(c => c[0] === 'ydotool' && c[1] !== 'help').map(c => c.slice(1));

beforeEach(() => {
  calls.length = 0;
  state.helpFails = false;
});

describe('ydotool 0.1.8 (Ubuntu/Debian)', () => {
  beforeEach(() => { state.help = LEGACY_HELP; });

  it('is detected from the help output and uses positional absolute mousemove', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    expect(be.kind).toBe('ydotool');
    await be.mouseMoveAbsolute(100, 200);
    expect(ydotoolCalls()).toEqual([['mousemove', '100', '200']]);
  });

  it('clicks with the numeric button ids 1/2/3 (0xC1 is parsed as 0 = left)', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.mouseClick('right');
    await be.mouseClick('middle');
    await be.mouseClick('left', 2);
    expect(ydotoolCalls()).toEqual([['click', '2'], ['click', '3'], ['click', '1'], ['click', '1']]);
  });

  it('refuses to scroll instead of typing digits', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await expect(be.mouseScroll('down', 3)).rejects.toThrow(/ydotool/);
    await expect(be.mouseScroll('left', 1)).rejects.toThrow(/ydotool/);
    expect(ydotoolCalls()).toEqual([]);
  });

  it('presses combos by name (key NAME+NAME), never as keycode:state', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.keyPress('ctrl+s');
    await be.keyPress('Return');
    await be.keyPress('shift+alt+F4');
    await be.keyPress('cmd+left');
    expect(ydotoolCalls()).toEqual([
      ['key', 'CTRL+s'],
      ['key', 'ENTER'],
      ['key', 'SHIFT+ALT+F4'],
      ['key', 'SUPER+LEFT'],
    ]);
  });

  it('types a bare key it has no name for, and refuses it under a modifier', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.keyPress('space');
    expect(ydotoolCalls()).toEqual([['type', '--', ' ']]);
    calls.length = 0;
    await expect(be.keyPress('ctrl+space')).rejects.toThrow(/ydotool/);
    expect(ydotoolCalls()).toEqual([]);
  });

  it('refuses separate button/key down+up and relative moves (no 0.1.x syntax exists)', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await expect(be.mouseDown('left')).rejects.toThrow(/ydotool/);
    await expect(be.mouseUp('left')).rejects.toThrow(/ydotool/);
    await expect(be.keyDown('shift')).rejects.toThrow(/ydotool/);
    await expect(be.keyUp('shift')).rejects.toThrow(/ydotool/);
    await expect(be.mouseMoveRelative(5, 5)).rejects.toThrow(/ydotool/);
    expect(ydotoolCalls()).toEqual([]);
  });

  it('types text with the 0.1.x per-key delay flag', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.typeText('hi');
    expect(ydotoolCalls()).toEqual([['type', '--key-delay', '10', '--', 'hi']]);
  });
});

describe('ydotool 1.x (ydotoold)', () => {
  beforeEach(() => { state.help = MODERN_HELP; });

  it('keeps the 1.x syntax for moves, clicks and keycodes', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.mouseMoveAbsolute(100, 200);
    await be.mouseMoveRelative(-5, 7);
    await be.mouseClick('right');
    await be.keyPress('ctrl+s');
    expect(ydotoolCalls()).toEqual([
      ['mousemove', '--absolute', '-x', '100', '-y', '200'],
      ['mousemove', '-x', '-5', '-y', '7'],
      ['click', '0xC1'],
      ['key', '29:1'],
      ['key', '31:1', '31:0'],
      ['key', '29:0'],
    ]);
  });

  it('scrolls with the wheel flag (REL_WHEEL), never `scroll` or digit keycodes', async () => {
    const be = await WaylandBackend.detect(hasYdotool);
    await be.mouseScroll('down', 3);
    await be.mouseScroll('up', 2);
    await be.mouseScroll('right', 1);
    await be.mouseScroll('left', 4);
    expect(ydotoolCalls()).toEqual([
      ['mousemove', '-w', '-x', '0', '-y', '-3'],
      ['mousemove', '-w', '-x', '0', '-y', '2'],
      ['mousemove', '-w', '-x', '1', '-y', '0'],
      ['mousemove', '-w', '-x', '-4', '-y', '0'],
    ]);
    expect(calls.some(c => c.includes('scroll') || c.includes('key'))).toBe(false);
  });

  it('assumes 1.x when the probe itself fails (unchanged behaviour)', async () => {
    state.helpFails = true;
    const be = await WaylandBackend.detect(hasYdotool);
    expect(be.kind).toBe('ydotool');
    await be.mouseMoveAbsolute(1, 2);
    expect(ydotoolCalls()).toEqual([['mousemove', '--absolute', '-x', '1', '-y', '2']]);
  });
});
