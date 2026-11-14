/**
 * Every modifier / key spelling, through every executor that reads one: what each presses, or the error it throws.
 * The executors resolve aliases through one resolver (keys.ts modifierOf); this table holds them to the names they
 * accepted before that, so an alias can neither vanish nor change meaning without this diff showing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ ops: [] as string[], programs: [] as string[], execs: [] as string[] }));

vi.mock('@nut-tree-fork/nut-js', async () => {
  const { Key } = await import('@nut-tree-fork/shared/dist/lib/enums/key.enum.js');
  const name = (k: unknown) => (Key as unknown as Record<number, string>)[k as number] ?? String(k);
  return {
    mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
    keyboard: {
      config: {},
      type: async (t: string) => { h.ops.push(`type ${t}`); },
      pressKey: async (...k: unknown[]) => { h.ops.push(`down ${k.map(name).join('+')}`); },
      releaseKey: async (...k: unknown[]) => { h.ops.push(`up ${k.map(name).join('+')}`); },
    },
    screen: { grab: vi.fn(), width: async () => 1920, height: async () => 1080 },
    Button: { LEFT: 0 },
    Key,
    Point: class { constructor(public x: number, public y: number) {} },
    Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
  };
});
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: (e: unknown, r?: unknown) => void) => {
    h.execs.push(`${cmd} ${args.join(' ')}`);
    const done = (typeof opts === 'function' ? opts : cb) as (e: unknown, r?: unknown) => void;
    queueMicrotask(() => done?.(null, { stdout: '', stderr: '' }));
    return { stdin: { on: () => {}, end: (data?: string) => { if (data !== undefined) h.programs.push(data); } } };
  },
  spawn: vi.fn(),
}));

import { WindowsAdapter } from '../platform/windows';
import { MacOSAdapter } from '../platform/macos';
import { LinuxAdapter } from '../platform/linux';
import { WaylandBackend } from '../platform/wayland-backend';
import type { MacAx } from '../platform/mac-ax';
import { keysOf } from '../platform/hard-keys';
import { modifierOf } from '../platform/keys';

const TOKENS = [
  'mod', 'Mod', 'cmd', 'Cmd', 'command', 'meta', 'Meta', 'super', 'Super', 'super_l', 'win', 'Win', 'windows', 'command_l',
  'ctrl', 'Ctrl', 'CTRL', 'control', 'Control', 'shift', 'Shift', 'alt', 'Alt', 'opt', 'option', 'Option',
  'altgr', 'leftctrl', 'rightalt', 'lwin', 'fn', 'hyper', 'bogus',
];

/** One line per token: what `run` did with it (ops / AppleScript programs), or the error it threw. */
async function table(run: (t: string) => Promise<unknown>, out: () => string[]): Promise<string> {
  const lines: string[] = [];
  for (const t of TOKENS) {
    h.ops.length = 0;
    h.programs.length = 0;
    h.execs.length = 0;
    let r: string;
    try { await run(t); r = out().join(' ; ') || '(nothing)'; } catch (e) { r = `ERR ${(e as Error).message}`; }
    lines.push(`${t.padEnd(10)}${r}`);
  }
  return `\n${lines.join('\n')}\n`;
}
const ops = () => h.ops;
const execs = () => h.execs;
const programs = () => h.programs.map(p => p.replace('tell application "System Events" to ', ''));

beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '1'; process.env.XDG_SESSION_TYPE = 'x11'; });

describe('modifierOf, per OS', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('%s', async (os) => {
    expect(await table(async t => { h.ops.push(String(modifierOf(t, os))); }, ops)).toMatchSnapshot();
  });
});

describe('normalizeKey, in a process on each OS', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('%s', async (os) => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...desc, value: os });
    try {
      vi.resetModules();
      const { normalizeKey } = await import('../platform/keys');
      expect(await table(async t => { h.ops.push(normalizeKey(t)); }, ops)).toMatchSnapshot();
    } finally { Object.defineProperty(process, 'platform', desc); }
  });
});

describe('hard-keys keysOf (the Stop / hard-key guard\'s reading), per OS', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('%s', async (os) => {
    expect(await table(async t => { h.ops.push(keysOf(`${t}+a`, os).join(',')); }, ops)).toMatchSnapshot();
  });
});

describe('Windows adapter', () => {
  const win = new WindowsAdapter();
  (win as unknown as { delay: () => Promise<void> }).delay = async () => {};
  it('keyPress t+a', async () => { expect(await table(t => win.keyPress(`${t}+a`), ops)).toMatchSnapshot(); });
  it('keyPress t', async () => { expect(await table(t => win.keyPress(t), ops)).toMatchSnapshot(); });
  it('keyDown t', async () => { expect(await table(t => win.keyDown(t), ops)).toMatchSnapshot(); });
});

describe('macOS adapter', () => {
  const mac = new MacOSAdapter({ ax: { frontmost: vi.fn(), prepare: vi.fn() } as unknown as MacAx });
  it('keyPress t+a', async () => { expect(await table(t => mac.keyPress(`${t}+a`), programs)).toMatchSnapshot(); });
  it('keyPress t', async () => { expect(await table(t => mac.keyPress(t), programs)).toMatchSnapshot(); });
  it('keyDown t', async () => { expect(await table(t => mac.keyDown(t), programs)).toMatchSnapshot(); });
  it('keyUp t', async () => { expect(await table(t => mac.keyUp(t), programs)).toMatchSnapshot(); });
});

describe('Linux (X11) adapter', () => {
  const linux = new LinuxAdapter();
  it('keyPress t+a', async () => { expect(await table(t => linux.keyPress(`${t}+a`), ops)).toMatchSnapshot(); });
  it('keyPress t', async () => { expect(await table(t => linux.keyPress(t), ops)).toMatchSnapshot(); });
  it('keyDown t', async () => { expect(await table(t => linux.keyDown(t), ops)).toMatchSnapshot(); });
});

describe('Wayland backend', () => {
  const yd = new WaylandBackend('ydotool');
  const legacy = new WaylandBackend('ydotool', 'legacy');
  const wt = new WaylandBackend('wtype-keyboard-only');
  it('ydotool keyPress t+a', async () => { expect(await table(t => yd.keyPress(`${t}+a`), execs)).toMatchSnapshot(); });
  it('ydotool keyPress t', async () => { expect(await table(t => yd.keyPress(t), execs)).toMatchSnapshot(); });
  it('ydotool keyDown t', async () => { expect(await table(t => yd.keyDown(t), execs)).toMatchSnapshot(); });
  it('ydotool 0.1.x keyPress t+a', async () => { expect(await table(t => legacy.keyPress(`${t}+a`), execs)).toMatchSnapshot(); });
  it('wtype keyPress t+a', async () => { expect(await table(t => wt.keyPress(`${t}+a`), execs)).toMatchSnapshot(); });
  it('wtype keyPress t', async () => { expect(await table(t => wt.keyPress(t), execs)).toMatchSnapshot(); });
});
