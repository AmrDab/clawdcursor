/**
 * Wayland input routing via ydotool / wtype.
 *
 * The Linux adapter's nut-js path silently fails on most Wayland
 * compositors because synthetic input events are blocked at the
 * compositor layer unless injected through a privileged daemon.
 * This module provides a minimal backend that routes mouse + keyboard
 * operations through `ydotool` (requires `ydotoold` running with
 * uinput access) or `wtype` (keyboard-only).
 *
 * Detection order at construction:
 *   1. `ydotool` + socket reachable → preferred (mouse + keyboard)
 *   2. `wtype` → keyboard-only fallback
 *   3. neither → `none`; caller must return graceful error
 *
 * Two incompatible ydotool generations are in the wild and we probe which
 * one is installed (`ydotool help` works on both without the daemon):
 *
 * 1.x ("modern", needs ydotoold — Arch, Fedora, upstream):
 *   mousemove --absolute -x <x> -y <y>     mousemove -x <dx> -y <dy>  (relative)
 *   mousemove -w -x <hwheel> -y <wheel>    (REL_WHEEL: +up / REL_HWHEEL: +right)
 *   click 0xC0                  (left)   0xC1 (right)   0xC2 (middle)
 *   key <code>:1                (down)   <code>:0      (up)
 *   type --key-delay 10 --key-hold 5 --file -   (the text on stdin; 1.x has no --delay)
 *
 * 0.1.x ("legacy" — Ubuntu 24.04 / Debian ship 0.1.8):
 *   mousemove <x> <y>           (absolute; `--absolute` is an unknown option
 *                                that still EXITS 0 without moving)
 *   click 1|2|3                 (left/right/middle; `0xC1` parses as 0 = left)
 *   key CTRL+s                  (names only; `29:1` TYPES the digit 2)
 *   type --key-delay 10 --file -
 *   No wheel, no separate press/release, no relative move — those report an
 *   honest error rather than a silent no-op or stray keystrokes.
 *
 * All command construction goes through `execFile` (not shell), so
 * there is NO shell interpolation of user text — clawdcursor typing
 * a string with `$` or backticks is safe. Typed text goes on stdin, never
 * argv: argv is readable by every process (`ps`, /proc/<pid>/cmdline).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { modifierOf, type Modifier } from './keys';
import { sleep } from '../core/sleep';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5_000;

/** Which backend the LinuxAdapter should use on Wayland. */
export type WaylandInputKind = 'ydotool' | 'wtype-keyboard-only' | 'none';

/** ydotool CLI generation — see the header comment for the two syntaxes. */
export type YdotoolGeneration = 'modern' | 'legacy';

/**
 * ydotool 0.1.x `key` takes NAMES (libevdevPlus Table_ModifierKeys /
 * Table_FunctionKeys, matched case-insensitively). Single characters go
 * through as-is; anything else has no 0.1.x spelling.
 */
const LEGACY_MODIFIERS: Record<Modifier, string> = { ctrl: 'CTRL', shift: 'SHIFT', alt: 'ALT', super: 'SUPER' };
const LEGACY_KEYS: Record<string, string> = {
  return: 'ENTER', enter: 'ENTER',
  tab: 'TAB',
  escape: 'ESC', esc: 'ESC',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  insert: 'INSERT',
  home: 'HOME', end: 'END',
  pageup: 'PAGEUP', pagedown: 'PAGEDOWN',
  capslock: 'CAPSLOCK',
  left: 'LEFT', right: 'RIGHT', up: 'UP', down: 'DOWN',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
};

/**
 * A combo's modifier tokens, by the aliases keys.ts knows (opt, win, mod …). An unknown one throws before anything is
 * pressed: dropped, `opt+x` sent a plain x.
 */
function modifiersOf(tokens: string[]): Modifier[] {
  return tokens.map(t => {
    const m = modifierOf(t, 'linux');
    if (!m) throw new Error(`Unknown modifier: "${t}"`);
    return m;
  });
}

/** Run `cmd` with `input` on its stdin (typed text never goes on argv). */
function execWithStdin(cmd: string, args: string[], input: string, timeout: number, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, env }, err => (err ? reject(err) : resolve()));
    // The tool may exit (or be killed at the timeout) before it has read everything: a closed pipe is not our error.
    child.stdin?.on('error', () => { /* reported by the exit callback */ });
    child.stdin?.end(input);
  });
}

function legacyUnsupported(what: string): Error {
  return new Error(
    `${what} needs ydotool 1.x (with ydotoold running); the installed ydotool 0.1.x has no syntax for it`,
  );
}

/**
 * `ydotool help` works on both generations without the daemon. 1.x mentions
 * its YDOTOOL_SOCKET variable; 0.1.x only lists its tools (on stderr). If the
 * probe tells us nothing, keep the 1.x syntax we always used.
 */
async function detectYdotoolGeneration(): Promise<YdotoolGeneration> {
  let text: string;
  try {
    const r = await execFileAsync('ydotool', ['help'], { timeout: TIMEOUT_MS });
    text = `${r.stdout}${r.stderr}`;
  } catch (err: any) {
    text = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  }
  if (text.includes('YDOTOOL_SOCKET')) return 'modern';
  return text.includes('Available commands') ? 'legacy' : 'modern';
}

/** Linux keycodes for the commonly-held modifiers + named keys we care about.
 *  Source: /usr/include/linux/input-event-codes.h
 *  Complete list isn't needed — covers the 90% case. A single character with
 *  no code is typed with `ydotool type`; any other unknown key is an error.
 */
const LINUX_KEYCODES: Record<string, number> = {
  // Modifiers
  ctrl:     29,  leftctrl:  29,
  rightctrl:97,
  shift:    42,  leftshift: 42,
  rightshift: 54,
  alt:      56,  leftalt:   56,
  rightalt: 100, altgr:     100,
  super:    125,
  rightsuper: 126,

  // Navigation / editing
  return:   28, enter: 28,
  tab:      15,
  escape:   1,  esc: 1,
  backspace:14,
  space:    57,
  delete:   111,
  home:     102,
  end:      107,
  pageup:   104,
  pagedown: 109,
  insert:   110,
  capslock: 58,

  // Arrows
  left:     105,
  right:    106,
  up:       103,
  down:     108,

  // F-keys
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64,
  f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
};

/** Map an ASCII alphanumeric character to its Linux keycode. */
function charToKeycode(ch: string): number | null {
  if (ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  const lettersMap: Record<string, number> = {
    a:30,b:48,c:46,d:32,e:18,f:33,g:34,h:35,i:23,j:36,
    k:37,l:38,m:50,n:49,o:24,p:25,q:16,r:19,s:31,t:20,
    u:22,v:47,w:17,x:45,y:21,z:44,
  };
  if (lower in lettersMap) return lettersMap[lower];
  const digitsMap: Record<string, number> = {
    '1':2,'2':3,'3':4,'4':5,'5':6,'6':7,'7':8,'8':9,'9':10,'0':11,
  };
  if (lower in digitsMap) return digitsMap[lower];
  return null;
}

export class WaylandBackend {
  readonly kind: WaylandInputKind;
  readonly generation: YdotoolGeneration;

  constructor(kind: WaylandInputKind, generation: YdotoolGeneration = 'modern') {
    this.kind = kind;
    this.generation = generation;
  }

  static async detect(hasBinary: (name: string) => Promise<boolean>): Promise<WaylandBackend> {
    const [hasYd, hasWt] = await Promise.all([hasBinary('ydotool'), hasBinary('wtype')]);
    if (hasYd) return new WaylandBackend('ydotool', await detectYdotoolGeneration());
    if (hasWt) return new WaylandBackend('wtype-keyboard-only');
    return new WaylandBackend('none');
  }

  canMouse(): boolean { return this.kind === 'ydotool'; }
  canKeyboard(): boolean { return this.kind === 'ydotool' || this.kind === 'wtype-keyboard-only'; }

  // ── Mouse ───────────────────────────────────────────────────

  async mouseMoveAbsolute(x: number, y: number): Promise<void> {
    if (this.kind !== 'ydotool') return;
    // 0.1.x `mousemove <x> <y>` jumps to the corner first, so it is absolute.
    const args = this.generation === 'legacy'
      ? ['mousemove', String(x), String(y)]
      : ['mousemove', '--absolute', '-x', String(x), '-y', String(y)];
    await execFileAsync('ydotool', args, { timeout: TIMEOUT_MS });
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    if (this.kind !== 'ydotool') return;
    if (this.generation === 'legacy') throw legacyUnsupported('relative mouse move');
    await execFileAsync('ydotool', ['mousemove', '-x', String(dx), '-y', String(dy)], {
      timeout: TIMEOUT_MS,
    });
  }

  /** `click` is a down+up in one ydotool call. For separate down/up, use mouseDown/mouseUp. */
  async mouseClick(button: 'left' | 'right' | 'middle' = 'left', count = 1): Promise<void> {
    if (this.kind !== 'ydotool') return;
    const code = this.generation === 'legacy'
      ? (button === 'left' ? '1' : button === 'right' ? '2' : '3')
      : (button === 'left' ? '0xC0' : button === 'right' ? '0xC1' : '0xC2');
    for (let i = 0; i < count; i++) {
      await execFileAsync('ydotool', ['click', code], { timeout: TIMEOUT_MS });
      if (i < count - 1) await sleep(50);
    }
  }

  async mouseDown(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (this.kind !== 'ydotool') return;
    if (this.generation === 'legacy') throw legacyUnsupported('holding a mouse button');
    // 1.x `key` accepts the raw BTN_* code with a :1 suffix.
    const code = button === 'left' ? '0x110' : button === 'right' ? '0x111' : '0x112';
    await execFileAsync('ydotool', ['key', `${code}:1`], { timeout: TIMEOUT_MS });
  }

  async mouseUp(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (this.kind !== 'ydotool') return;
    if (this.generation === 'legacy') throw legacyUnsupported('releasing a mouse button');
    const code = button === 'left' ? '0x110' : button === 'right' ? '0x111' : '0x112';
    await execFileAsync('ydotool', ['key', `${code}:0`], { timeout: TIMEOUT_MS });
  }

  async mouseScroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3): Promise<void> {
    if (this.kind !== 'ydotool') return;
    if (this.generation === 'legacy') throw legacyUnsupported('scrolling');
    // 1.x has no `scroll` subcommand: the wheel is `mousemove -w`, where -y is
    // REL_WHEEL (+ = up) and -x is REL_HWHEEL (+ = right). Never fall back to
    // `key 0x04..0x07` — those are KEY_3..KEY_6 and type digits.
    const h = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const v = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
    await execFileAsync('ydotool', ['mousemove', '-w', '-x', String(h), '-y', String(v)], {
      timeout: TIMEOUT_MS,
    });
  }

  // ── Keyboard ────────────────────────────────────────────────

  /**
   * Press a key combo. On ydotool we map each component to a Linux
   * keycode and emit paired down/up events. On wtype we use wtype's
   * native combo syntax (e.g. `wtype -M ctrl -k s`).
   */
  async keyPress(combo: string): Promise<void> {
    if (this.kind === 'none') return;

    // Special case: literal "+"
    if (combo === '+') {
      if (this.kind === 'ydotool') {
        await execFileAsync('ydotool', ['type', '--', '+'], { timeout: TIMEOUT_MS });
      } else {
        await execFileAsync('wtype', ['+'], { timeout: TIMEOUT_MS });
      }
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;

    if (this.kind === 'wtype-keyboard-only') {
      // wtype: -M <mod> repeatable, then -k <keyname> or bare text.
      const args: string[] = [];
      const key = parts[parts.length - 1];
      for (const m of modifiersOf(parts.slice(0, -1))) args.push('-M', WTYPE_MODIFIERS[m]);
      // wtype named keys (Return, Tab, etc.) go via `-k`.
      const wtypeKey = wtypeKeyName(key);
      if (wtypeKey) {
        args.push('-k', wtypeKey);
      } else if (key.length === 1) {
        args.push(key);
      } else {
        // An unknown key name is an error, as on X11, Windows and macOS — never typed as text: with Super held (in
        // this chord, or by an earlier key_down) "ll" is Super+L twice, past the hard key list, which knows no key "ll".
        throw new Error(`Unknown key: "${key}"`);
      }
      await execFileAsync('wtype', args, { timeout: TIMEOUT_MS }).catch(() => {});
      return;
    }

    if (this.generation === 'legacy') {
      // 0.1.x: one `key NAME+NAME` call presses everything and releases in reverse.
      const mods = modifiersOf(parts.slice(0, -1)).map(m => LEGACY_MODIFIERS[m]);
      const key = parts[parts.length - 1];
      const name = LEGACY_KEYS[key.toLowerCase()] ?? (key.length === 1 ? key : null);
      if (name !== null) {
        await execFileAsync('ydotool', ['key', [...mods, name].join('+')], { timeout: TIMEOUT_MS });
        return;
      }
      // "space" has no 0.1.x name ("space" would be read as "s") — type it bare. Any other unknown name is an error.
      if (key.toLowerCase() !== 'space') throw new Error(`Unknown key: "${key}"`);
      if (mods.length === 0) {
        const text = ' ';
        await execFileAsync('ydotool', ['type', '--', text], { timeout: TIMEOUT_MS });
        return;
      }
      throw legacyUnsupported(`the key combo "${combo}"`);
    }

    const modCodes = modifiersOf(parts.slice(0, -1)).map(m => LINUX_KEYCODES[m]);
    const mainName = parts[parts.length - 1];
    const mainCode = this.keyToCode(mainName);
    // An unknown key name is an error, as on X11, Windows and macOS, and before any modifier goes down. Typed as text
    // with Super held (in this chord, or by an earlier key_down), "ll" is Super+L twice — past the hard key list, which
    // knows no key called "ll". Only a single character with no key code is typed, and only on its own.
    if (mainCode === null && (parts.length > 1 || [...mainName].length !== 1)) throw new Error(`Unknown key: "${mainName}"`);

    try {
      for (const c of modCodes) {
        await execFileAsync('ydotool', ['key', `${c}:1`], { timeout: TIMEOUT_MS });
      }
      if (mainCode !== null) {
        await execFileAsync('ydotool', ['key', `${mainCode}:1`, `${mainCode}:0`], {
          timeout: TIMEOUT_MS,
        });
      } else if (mainName.length > 0) {
        // No keycode mapping — type it as text (ydotool type handles the layout).
        await execFileAsync('ydotool', ['type', '--', mainName], { timeout: TIMEOUT_MS });
      }
    } finally {
      for (let i = modCodes.length - 1; i >= 0; i--) {
        await execFileAsync('ydotool', ['key', `${modCodes[i]}:0`], { timeout: TIMEOUT_MS })
          .catch(() => {});
      }
    }
  }

  async keyDown(key: string): Promise<void> {
    if (this.kind !== 'ydotool') throw cannotHold('holding a key');
    if (this.generation === 'legacy') throw legacyUnsupported('holding a key');
    const code = this.oneKeyCode(key);
    await execFileAsync('ydotool', ['key', `${code}:1`], { timeout: TIMEOUT_MS });
  }

  async keyUp(key: string): Promise<void> {
    if (this.kind !== 'ydotool') throw cannotHold('releasing a held key');
    if (this.generation === 'legacy') throw legacyUnsupported('releasing a key');
    const code = this.oneKeyCode(key);
    await execFileAsync('ydotool', ['key', `${code}:0`], { timeout: TIMEOUT_MS });
  }

  /**
   * key_down / key_up take ONE known key. A chord or an unknown name throws instead of doing nothing: the caller (the
   * held-key record in pointer-guard.ts) must never believe a key was held or released when it was not.
   */
  private oneKeyCode(key: string): number {
    const name = String(key ?? '').trim().toLowerCase();
    if (name.includes('+') && name !== '+') throw new Error(`key_down / key_up take one key, not a chord: "${key}"`);
    const code = name ? this.keyToCode(name) : null;
    if (code === null) throw new Error(`Unknown key: "${key}"`);
    return code;
  }

  async typeText(text: string): Promise<void> {
    if (this.kind === 'none' || !text) return;
    if (this.kind === 'ydotool') {
      // Small delay so fast apps don't drop chars. 0.1.x (boost options) rejects the unknown --key-hold; 1.x knows it
      // (1.0.4) or skips it (older 1.x getopt, which in --file mode ignores the stray value).
      const hold = this.generation === 'legacy' ? [] : ['--key-hold', '5'];
      // `--file -`: the text on stdin (both generations), never argv.
      await execWithStdin('ydotool', ['type', '--key-delay', '10', ...hold, '--file', '-'], text, TIMEOUT_MS + text.length * 15);
      return;
    }
    // wtype: `-` reads the text from stdin, decoded by the locale: under C / POSIX non-ASCII is dropped with exit 0.
    await execWithStdin('wtype', ['-'], text, TIMEOUT_MS + text.length * 15, { ...process.env, LC_ALL: 'C.UTF-8' });
  }

  // ── Internals ───────────────────────────────────────────────

  private keyToCode(name: string): number | null {
    const low = name.toLowerCase();
    if (low in LINUX_KEYCODES) return LINUX_KEYCODES[low];
    const mod = modifierOf(low, 'linux');
    if (mod) return LINUX_KEYCODES[mod];
    const ch = charToKeycode(name);
    if (ch !== null) return ch;
    return null;
  }
}

const WTYPE_MODIFIERS: Record<Modifier, string> = { ctrl: 'ctrl', shift: 'shift', alt: 'alt', super: 'logo' };

/**
 * wtype taps keys (`-M` / `-m` hold a modifier only within one call), so a key held across calls needs ydotool. Said,
 * not skipped: the held-key record (pointer-guard.ts) must never believe a key is down that is not.
 */
function cannotHold(what: string): Error {
  return new Error(`${what} needs ydotool (with ydotoold running) on Wayland; wtype, the only input tool found, cannot hold a key`);
}

function wtypeKeyName(k: string): string | null {
  const lo = k.toLowerCase();
  const map: Record<string, string> = {
    return: 'Return', enter: 'Return',
    tab: 'Tab',
    space: 'space',
    escape: 'Escape', esc: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    home: 'Home', end: 'End',
    pageup: 'Page_Up', pagedown: 'Page_Down',
    insert: 'Insert',
    left: 'Left', right: 'Right', up: 'Up', down: 'Down',
    f1:'F1',f2:'F2',f3:'F3',f4:'F4',f5:'F5',f6:'F6',
    f7:'F7',f8:'F8',f9:'F9',f10:'F10',f11:'F11',f12:'F12',
  };
  return map[lo] ?? null;
}
