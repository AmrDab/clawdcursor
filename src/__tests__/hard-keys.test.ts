/**
 * The hard key list (platform/hard-keys.ts): the few OS-level combos clawdcursor never sends, and the only key rule left
 * after the policy gate was removed in 1.6. Everything else is allowed.
 *
 * Two advisories were bypasses of the old keyboard gate, and their inputs are replayed here against the new one:
 *   GHSA-35pc-g74h-p476 — the gate was keyed on the tool's name (the agent loop's `key` tool walked past it), and a
 *                         sequence ("esc win+l") collapsed to a string that matched nothing.
 *   GHSA-3v3f-5rwv-whc9 — a batch could carry a step past the gate (covered in batch.test.ts as well).
 * The list is now checked in the input layer, below every tool, so neither a name nor a wrapper can route around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardKeyRefusal } from '../platform/hard-keys';
import { guardInputMethods, setInputGuard, unguarded, _resetHeldKeys } from '../platform/pointer-guard';
import { normalizeKey } from '../platform/keys';
import { getDesktopTools } from '../tools/desktop';
import { getExtraTools } from '../tools/extras';
import { getShortcutTools } from '../tools/shortcuts';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { ToolContext } from '../tools/types';

const refused = (combo: unknown, os: NodeJS.Platform, held: string[] = []) => hardKeyRefusal(combo, held, os) !== null;

describe('the list, per OS — only the OS clawdcursor runs on applies', () => {
  it('Windows: lock and the secure attention sequence', () => {
    for (const c of ['win+l', 'ctrl+alt+delete', 'ctrl+alt+del']) expect(refused(c, 'win32'), c).toBe(true);
  });

  it('macOS: lock, log out, and anything with the power or eject key', () => {
    for (const c of ['ctrl+cmd+q', 'cmd+shift+q', 'cmd+opt+shift+q', 'ctrl+cmd+power', 'ctrl+opt+cmd+power', 'opt+cmd+power', 'ctrl+shift+eject', 'ctrl+power', 'power']) {
      expect(refused(c, 'darwin'), c).toBe(true);
    }
  });

  it('Linux: lock, log out / reboot, kill the display server, console switch, SysRq, power', () => {
    for (const c of ['super+l', 'ctrl+alt+l', 'ctrl+alt+delete', 'ctrl+alt+backspace', 'ctrl+alt+f1', 'ctrl+alt+f7', 'ctrl+alt+f12', 'alt+sysrq+b', 'XF86PowerOff']) {
      expect(refused(c, 'linux'), c).toBe(true);
    }
  });

  it('another OS\'s combos are not refused', () => {
    expect(refused('ctrl+cmd+q', 'win32')).toBe(false);   // Ctrl+Q on Windows
    expect(refused('ctrl+alt+l', 'win32')).toBe(false);
    expect(refused('win+l', 'darwin')).toBe(false);       // Cmd+L: the address bar
    expect(refused('ctrl+alt+delete', 'darwin')).toBe(false);
    expect(refused('cmd+shift+q', 'linux')).toBe(false);
  });

  it.each(['win32', 'darwin', 'linux'] as const)('everything else is allowed on %s — shortcuts stay useful', (os) => {
    const useful = [
      'alt+f4', 'ctrl+w', 'cmd+w', 'cmd+q', 'win+r', 'win+d', 'win+e', 'cmd+space', 'ctrl+shift+esc', 'cmd+opt+esc', 'f11', 'alt+tab',
      'ctrl+l', 'ctrl+s', 'mod+s', 'ctrl+a Delete', 'shift+tab', 'Return', 'Escape', 'Delete', 'l', 'q', 'ctrl+alt+t', 'win+shift+s',
      'ctrl+shift+delete', 'alt+delete', 'ctrl+delete', 'Down Down End', '+', 'ctrl++', 'ctrl+-',
    ];
    for (const c of useful) expect(hardKeyRefusal(c, [], os), `${c} on ${os}`).toBeNull();
  });

  it('the refusal says which combo, why, and that it is never sent', () => {
    const why = hardKeyRefusal('Esc WIN+L', [], 'win32')!;
    expect(why).toContain('dangerous key combo');   // result-codes.ts: DANGEROUS_KEY
    expect(why).toContain('super+l locks the screen');
    expect(why).toContain('pause_for_user');
  });
});

describe('normalization — no spelling gets past it (the GHSA-35pc bypass class)', () => {
  // GHSA-35pc defect 2: "esc win+l" became "escwin+l", matched nothing, and the executor pressed win+l.
  it('a whitespace-separated sequence is checked element by element', () => {
    for (const c of ['esc win+l', 'win+l esc', 'a win+l b', 'esc\twin+l', 'esc\nwin+l', 'Down Down ctrl+alt+del']) expect(refused(c, 'win32'), JSON.stringify(c)).toBe(true);
  });

  it('whitespace inside a chord, and around it', () => {
    for (const c of ['win + l', ' win+l ', 'win+ l', 'win +l', 'ctrl + alt + del', 'ctrl+alt+ delete', '\twin+l\n']) expect(refused(c, 'win32'), JSON.stringify(c)).toBe(true);
  });

  it('case', () => {
    for (const c of ['WIN+L', 'Win+L', 'wIn+l', 'CTRL+ALT+DEL', 'Ctrl+Alt+Delete']) expect(refused(c, 'win32'), c).toBe(true);
  });

  it('modifier order, repeated keys and extra keys', () => {
    for (const c of ['l+win', 'del+alt+ctrl', 'alt+ctrl+delete', 'win+l+win', 'win+win+l', 'win+shift+l', 'a+win+l', 'ctrl+alt+shift+delete']) {
      expect(refused(c, 'win32'), c).toBe(true);
    }
    expect(refused('q+cmd+ctrl', 'darwin')).toBe(true);
    expect(refused('q+shift+cmd', 'darwin')).toBe(true);
  });

  it('every alias of the Super / Windows / Command key', () => {
    for (const k of ['win', 'windows', 'super', 'meta', 'Super', 'Meta', 'LeftWin', 'RightWin', 'LeftSuper', 'RightSuper', 'LeftMeta', 'lwin', 'rwin', 'super_l', 'super_r', 'Super_L', 'meta_l', 'win_l', 'command_l', 'LeftCmd', 'RightCmd']) {
      expect(refused(`${k}+l`, 'win32'), `${k}+l`).toBe(true);
    }
    for (const k of ['cmd', 'command', 'meta', 'super', 'win', 'windows', 'mod', 'LeftCmd', 'command_l', 'super_l']) {
      expect(refused(`ctrl+${k}+q`, 'darwin'), `ctrl+${k}+q`).toBe(true);
      expect(refused(`${k}+shift+q`, 'darwin'), `${k}+shift+q`).toBe(true);
    }
    for (const k of ['cmd', 'command', 'meta', 'super', 'win', 'windows', 'Super_L']) expect(refused(`${k}+l`, 'linux'), `${k}+l`).toBe(true);
  });

  // Not a bypass: on Windows both executors press `cmd` / `command` (and `mod`) as Ctrl, so `cmd+l` is Ctrl+L.
  it('Windows: cmd / command are Ctrl there, as the executors press them — meta is not excused', () => {
    for (const c of ['cmd+l', 'command+l', 'mod+l']) expect(refused(c, 'win32'), c).toBe(false);
    expect(refused('meta+l', 'win32')).toBe(true);   // the Windows adapter's keyDown holds the Windows key for `meta`
    if (process.platform === 'win32') {
      expect(normalizeKey('cmd')).toBe('Control');
      expect(normalizeKey('command')).toBe('Control');
    }
  });

  it('every alias of Ctrl, Alt and Delete', () => {
    for (const c of [
      'control+alt+delete', 'ctrl+option+del', 'ctrl+opt+delete', 'LeftControl+LeftAlt+Delete', 'RightControl+RightAlt+Delete', 'lctrl+ralt+del',
      'ctrl_l+alt_l+delete', 'ctrl+altgr+del', 'ctrl+alt+forwarddelete', 'ctrl-alt-del', 'ctrl-alt-delete', 'ctrl_alt_del', 'CTRL-ALT-DEL',
    ]) expect(refused(c, 'win32'), c).toBe(true);
    for (const c of ['control+command+q', 'ctrl-cmd-q', 'LeftControl+LeftCmd+q', 'cmd+option+shift+q']) expect(refused(c, 'darwin'), c).toBe(true);
  });

  it('a key held with key_down counts toward the next press', () => {
    expect(refused('l', 'win32', ['super'])).toBe(true);
    expect(refused('delete', 'win32', ['ctrl', 'alt'])).toBe(true);
    expect(refused('alt+delete', 'win32', ['ctrl'])).toBe(true);
    expect(refused('q', 'darwin', ['ctrl', 'super'])).toBe(true);
    expect(refused('l', 'win32', ['ctrl'])).toBe(false);
    expect(hardKeyRefusal('l', ['super'], 'win32')).toMatch(/held super \(release it with key_up first\)/);
  });

  it('a non-string never throws and never slips through as something else', () => {
    expect(refused(['win+l'], 'win32')).toBe(true);        // String(['win+l']) is what an executor would be handed
    expect(refused(['win', 'l'], 'win32')).toBe(false);    // "win,l": one unknown key, nothing an executor can press as a chord
    for (const v of [undefined, null, 42, {}, '', '   ', '+', '++']) expect(hardKeyRefusal(v, [], 'win32')).toBeNull();
    for (const c of ['constructor+l', '__proto__+l', 'toString+q', 'hasOwnProperty+delete']) expect(hardKeyRefusal(c, [], 'win32')).toBeNull();
  });
});

// The combo that locks THIS machine's OS: the guard reads process.platform.
const LOCK = process.platform === 'darwin' ? 'ctrl+cmd+q' : 'win+l';
const [LOCK_HOLD, LOCK_KEY] = process.platform === 'darwin' ? ['ctrl+cmd', 'q'] : ['win', 'l'];

function keyboard() {
  const sent: string[] = [];
  const kb = {
    sent,
    keyPress: vi.fn(async (c: string) => { sent.push(`press ${c}`); }),
    keyDown: vi.fn(async (c: string) => { sent.push(`down ${c}`); }),
    keyUp: vi.fn(async (c: string) => { sent.push(`up ${c}`); }),
    async executeKeyboardAction(a: { key: string }) { await kb.keyPress(a.key); },   // NativeDesktop's composite action
    takeInputWarning: () => null,
  };
  return guardInputMethods(kb);
}

describe('one call site: the input layer, below every tool', () => {
  beforeEach(() => { setInputGuard(null); _resetHeldKeys(); });

  it('hardKeyRefusal is called from exactly one place in the source', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (f === '__tests__' ? [] : files(p)) : (p.endsWith('.ts') ? [p] : []);
    });
    const callers = files(src).filter(p => !p.endsWith('hard-keys.ts') && /hardKeyRefusal\(/.test(readFileSync(p, 'utf8')));
    expect(callers.map(p => p.replace(/\\/g, '/').split('/src/')[1])).toEqual(['platform/pointer-guard.ts']);
    expect(readFileSync(callers[0], 'utf8').match(/hardKeyRefusal\(/g)).toHaveLength(1);
  });

  it('keyPress and keyDown refuse it; nothing reaches the OS', async () => {
    const kb = keyboard();
    await expect(kb.keyPress(LOCK)).rejects.toThrow(/dangerous key combo/);
    await expect(kb.keyDown(LOCK)).rejects.toThrow(/dangerous key combo/);
    await expect(kb.executeKeyboardAction({ key: LOCK })).rejects.toThrow(/dangerous key combo/);
    expect(kb.sent).toEqual([]);
  });

  it('an ordinary shortcut goes through', async () => {
    const kb = keyboard();
    await kb.keyPress('ctrl+l');
    await kb.keyPress('alt+f4');
    expect(kb.sent).toEqual(['press ctrl+l', 'press alt+f4']);
  });

  it('key_down then key_press cannot assemble it, in one input layer or across the two', async () => {
    const desktop = keyboard();
    const platform = keyboard();
    await platform.keyDown(LOCK_HOLD);
    await expect(platform.keyPress(LOCK_KEY)).rejects.toThrow(/dangerous key combo/);
    await expect(desktop.keyPress(LOCK_KEY)).rejects.toThrow(/dangerous key combo/);   // one keyboard: the other layer sees the held key
    await expect(desktop.keyDown(LOCK_KEY)).rejects.toThrow(/dangerous key combo/);
    await platform.keyUp(LOCK_HOLD);
    await desktop.keyPress(LOCK_KEY);
    expect(desktop.sent).toEqual([`press ${LOCK_KEY}`]);
  });

  it('it is unconditional: clawdcursor\'s own housekeeping and a missing input guard are refused too', async () => {
    const kb = keyboard();
    await expect(unguarded(() => kb.keyPress(LOCK))).rejects.toThrow(/dangerous key combo/);
    expect(kb.sent).toEqual([]);
  });

  // GHSA-35pc defect 1: the gate recognised four tool names; the agent loop's keyboard tool is called `key`.
  describe('whatever the tool is called (GHSA-35pc-g74h-p476)', () => {
    const ctxWith = (kb: ReturnType<typeof keyboard>) => ({
      ensureInitialized: async () => {},
      desktop: kb,
      platform: kb,
      a11y: { getActiveWindow: async () => ({ processName: 'notepad', title: 'Untitled' }), invalidateCache: vi.fn() },
    }) as unknown as ToolContext;
    const sequence = `esc ${LOCK}`;

    it('MCP key_press — the chord, and the advisory\'s sequence form', async () => {
      const keyPress = getDesktopTools().find(t => t.name === 'key_press')!;
      for (const key of [LOCK, sequence, LOCK.toUpperCase(), ` ${LOCK} `]) {
        const kb = keyboard();
        await expect(keyPress.handler({ key }, ctxWith(kb))).rejects.toThrow(/dangerous key combo/);
        expect(kb.sent.filter(s => s !== 'press esc'), key).toEqual([]);
      }
    });

    it('MCP key_down', async () => {
      const kb = keyboard();
      await expect(getExtraTools().find(t => t.name === 'key_down')!.handler({ key: LOCK }, ctxWith(kb))).rejects.toThrow(/dangerous key combo/);
      expect(kb.sent).toEqual([]);
    });

    it('the agent-loop tools `key` (the advisory\'s tool name) and `key_down`, by `combo` or by `key`', async () => {
      const tools = buildUnifiedTools();
      const key = tools.find(t => t.name === 'key')!;
      const keyDown = tools.find(t => t.name === 'key_down')!;
      // `combo` wins over `key` in this tool; whichever it presses, the lock chord never reaches the OS.
      for (const args of [{ combo: LOCK }, { key: LOCK }, { combo: sequence }, { combo: 'a', key: LOCK }, { combo: LOCK, key: 'a' }]) {
        const kb = keyboard();
        const r = await key.execute(args, { platform: kb } as never).catch((e: Error) => ({ success: false, text: e.message }));
        expect(kb.sent, JSON.stringify(args)).not.toContain(`press ${LOCK}`);
        if ((args.combo ?? args.key) !== 'a') {
          expect(r.success, JSON.stringify(args)).toBe(false);
          expect(r.text).toMatch(/dangerous key combo/);
        }
      }
      const kb = keyboard();
      await expect(keyDown.execute({ key: LOCK }, { platform: kb } as never)).rejects.toThrow(/dangerous key combo/);
      expect(kb.sent).toEqual([]);
    });

    it('a named shortcut that resolves to it ("lock screen")', async () => {
      const kb = keyboard();
      const run = getShortcutTools().find(t => t.name === 'shortcuts_execute')!;
      await expect(run.handler({ intent: 'lock screen' }, ctxWith(kb))).rejects.toThrow(/dangerous key combo/);
      expect(kb.sent).toEqual([]);
    });
  });
});
