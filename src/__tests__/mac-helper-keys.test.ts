/**
 * #240: keys through the accessibility helper's CGEvent path instead of System Events (0.3–0.6 s per call). The helper is used
 * only when it is built AND says this process may post key events; every other case runs the System Events program it always
 * ran. Runs on any OS: the helper and osascript are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { createMacAx, MacAxError, type MacAx, type MacAxDeps } from '../platform/mac-ax';
import { MacOSAdapter } from '../platform/macos';
import { pressKeyMac } from '../platform/mac-keyboard';

type Call = { args: string[]; input?: string; timeoutMs: number };
function helperAx(opts: { helper?: string | null; reply?: string | Error } = {}) {
  const calls: Call[] = [];
  const ensureHelper = vi.fn<() => Promise<string | null> | void>();
  const deps: MacAxDeps = {
    helper: () => (opts.helper === undefined ? '/fake/ax-helper' : opts.helper),
    ensureHelper,
    scriptsDir: '/fake',
    exec: async (_file, args, o) => {
      calls.push({ args, input: o.input, timeoutMs: o.timeoutMs });
      if (opts.reply instanceof Error) throw opts.reply;
      return { stdout: opts.reply ?? '{"ok":true}' };
    },
  };
  return { ax: createMacAx(deps), calls, ensureHelper };
}

const savedNoMacAx = process.env.CLAWD_NO_MAC_AX;
afterEach(() => { if (savedNoMacAx === undefined) delete process.env.CLAWD_NO_MAC_AX; else process.env.CLAWD_NO_MAC_AX = savedNoMacAx; });

describe('MacAx.postKey: the helper transport', () => {
  beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '0'; });

  it('postKey runs the key command with the code, modifiers and phase', async () => {
    const { ax, calls } = helperAx();
    expect(await ax.postKey({ code: 8, mods: ['command', 'shift'], phase: 'tap', usLayout: true })).toBe(true);
    expect(calls[0].args.slice(0, 7)).toEqual(['key', '--code', '8', '--mods', 'command,shift', '--phase', 'tap']);
    expect(calls[0].args).toContain('--us-layout');
  });

  it('helper not built: false, nothing run, the build starts for next time and is not waited for', async () => {
    const { ax, calls, ensureHelper } = helperAx({ helper: null });
    expect(await ax.postKey({ code: 36, mods: [], phase: 'tap' })).toBe(false);
    expect(await ax.postKey({ code: 0, mods: [], phase: 'tap' })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(ensureHelper).toHaveBeenCalled();
  });

  it('the helper refusing (CGPreflightPostEventAccess false) is false, and is not retried key after key', async () => {
    const { ax, calls } = helperAx({ reply: '{"ok":false,"kind":"permission","error":"may not post keyboard events"}' });
    expect(await ax.postKey({ code: 36, mods: [], phase: 'tap' })).toBe(false);
    expect(await ax.postKey({ code: 0, mods: [], phase: 'tap' })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a timeout is not a refusal: it throws, the keys may already be typed', async () => {
    const { ax } = helperAx({ reply: '{"ok":false,"kind":"timeout","acted":true,"error":"typed 3 of 9 characters"}' });
    await expect(ax.postKey({ code: 36, mods: [], phase: 'tap' })).rejects.toBeInstanceOf(MacAxError);
  });

  it('CLAWD_NO_MAC_AX=1: false, nothing run', async () => {
    const { ax, calls } = helperAx();
    process.env.CLAWD_NO_MAC_AX = '1';
    expect(await ax.postKey({ code: 36, mods: [], phase: 'tap' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('pressKeyMac: which keys the helper takes', () => {
  const postKey = vi.fn<MacAx['postKey']>();
  beforeEach(() => { postKey.mockReset().mockResolvedValue(true); });
  const ax = { postKey };

  it('a named key code goes as a key, with its modifiers', async () => {
    expect(await pressKeyMac(ax, { code: 36, mods: ['command'] })).toBe(true);
    expect(postKey).toHaveBeenCalledWith({ code: 36, mods: ['command'], phase: 'tap' });
  });
  it('a bare lowercase letter is its real key code on a US layout', async () => {
    await pressKeyMac(ax, { char: 'j', mods: [] });
    expect(postKey).toHaveBeenCalledWith({ code: 38, mods: [], phase: 'tap', usLayout: true });
  });
  it('a lowercase letter with modifiers is a US-layout key code', async () => {
    await pressKeyMac(ax, { char: 'c', mods: ['command'] });
    expect(postKey).toHaveBeenCalledWith({ code: 8, mods: ['command'], phase: 'tap', usLayout: true });
  });
  it('an uppercase letter, shifted symbol, "+" or non-ASCII character is left to System Events, with or without modifiers', async () => {
    expect(await pressKeyMac(ax, { char: 'C', mods: ['command'] })).toBe(false);
    expect(await pressKeyMac(ax, { char: '?', mods: ['command'] })).toBe(false);
    for (const c of ['J', '+', 'é']) {
      expect(await pressKeyMac(ax, { char: c, mods: [] })).toBe(false);
      expect(await pressKeyMac(ax, { char: c, mods: ['command'] })).toBe(false);
    }
    expect(postKey).not.toHaveBeenCalled();
  });
  it('false when the ax client has no key transport', async () => {
    expect(await pressKeyMac({}, { code: 36, mods: [] })).toBe(false);
  });
});

describe('MacOSAdapter routes keys: helper when it accepts, System Events otherwise', () => {
  const postKey = vi.fn<MacAx['postKey']>();
  const mac = new MacOSAdapter({ ax: { postKey, typeUnicode: vi.fn(), frontmost: vi.fn(), prepare: vi.fn() } as unknown as MacAx });
  beforeEach(() => {
    programs.length = 0;
    postKey.mockReset().mockResolvedValue(true);
   
    process.env.CLAWD_NO_MAC_AX = '1';   // no keyboard-owner probe; the fake ax answers the key calls itself
  });

  it('accepted: no osascript at all', async () => {
    await mac.keyPress('cmd+c');
    await mac.keyPress('Return');
    await mac.typeText('hello');
    expect(programs).toEqual(['tell application "System Events" to keystroke "hello"']);
    programs.length = 0;
    expect(postKey.mock.calls.map(c => c[0])).toEqual([
      { code: 8, mods: ['command'], phase: 'tap', usLayout: true },
      { code: 36, mods: [], phase: 'tap' },
    ]);
    expect(programs).toEqual([]);
  });

  it('refused: the exact programs System Events always got', async () => {
    postKey.mockResolvedValue(false);
    await mac.keyPress('cmd+c');
    await mac.keyPress('Return');
    await mac.typeText('say "hi"');
    expect(programs).toEqual([
      'tell application "System Events" to keystroke "c" using {command down}',
      'tell application "System Events" to key code 36',
      'tell application "System Events" to keystroke "say \\"hi\\""',
    ]);
  });

  it('a modifier key on its own stays on System Events', async () => {
    await mac.keyPress('shift');
    expect(postKey).not.toHaveBeenCalled();
    expect(programs).toEqual(['tell application "System Events" to key code 56']);
  });

  it('keyDown / keyUp of a named key use the helper phases; a modifier stays on System Events', async () => {
    await mac.keyDown('Down');
    await mac.keyUp('Down');
    expect(postKey.mock.calls.map(c => c[0])).toEqual([
      { code: 125, mods: [], phase: 'down' },
      { code: 125, mods: [], phase: 'up' },
    ]);
    await mac.keyDown('shift');
    expect(programs).toEqual(['tell application "System Events" to key down shift']);
  });
});
