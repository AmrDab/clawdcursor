/**
 * Canonical key name normalization.
 *
 * Single source of truth for mapping human-readable key names
 * to internal key identifiers used across the codebase.
 */

/**
 * `mod` — THE way clawdcursor's own code presses this OS's shortcut modifier: Cmd on macOS, Ctrl on Windows and Linux.
 * Every executor resolves it (this table, the three adapters, the Wayland backend), so a built-in combo is written once
 * as `mod+v` and is right on every OS. Never write `ctrl+` / `cmd+` in a built-in combo unless the key is that key on
 * every OS (browsers cycle tabs with Ctrl+Tab on macOS too). An agent's own `ctrl+x` is sent as Ctrl: it is a real key
 * on a Mac (terminals), so it is never translated.
 */
export const MOD = 'mod';

/**
 * One paragraph for the agent, built once when the server starts: which OS this is and which keys its shortcuts use.
 * Without it an agent guesses, and sends Windows hotkeys to a Mac.
 */
export function osKeysGuide(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'This computer runs macOS: the shortcut modifier is cmd (cmd+c, cmd+v, cmd+s, cmd+a, cmd+w, cmd+tab), not ctrl. ' +
      '`mod` always means this OS\'s modifier, so mod+s is cmd+s here. ctrl is a different key on a Mac: use it only where an app really binds Ctrl ' +
      '(a terminal\'s ctrl+c, ctrl+tab to cycle browser tabs). opt is the Alt key. Do not send Windows shortcuts (alt+f4, win+r, F5 to reload): use system shortcuts_list for this OS\'s keys. ';
  }
  const name = platform === 'win32' ? 'Windows' : 'Linux';
  const sys = platform === 'win32' ? 'win is the Windows key' : 'super is the Super (Windows-logo) key';
  return `This computer runs ${name}: the shortcut modifier is ctrl (ctrl+c, ctrl+v, ctrl+s, ctrl+a, ctrl+w), and apps are switched with alt+tab. ` +
    `\`mod\` always means this OS's modifier, so mod+s is ctrl+s here; ${sys}. ` +
    'Do not send macOS shortcuts (cmd+q, cmd+space, cmd+w): use system shortcuts_list for this OS\'s keys. ';
}
/** Canonical key name map — input (case-insensitive) → normalized name */
const KEY_ALIASES: Record<string, string> = {
  'return': 'Return',
  'enter': 'Return',

  'space': 'Space',
  'spacebar': 'Space',
  'tab': 'Tab',
  'escape': 'Escape',
  'esc': 'Escape',
  'backspace': 'Backspace',
  'delete': 'Delete',

  'up': 'Up',
  'down': 'Down',
  'left': 'Left',
  'right': 'Right',

  'home': 'Home',
  'end': 'End',
  'pageup': 'PageUp',
  'page_up': 'PageUp',
  'pagedown': 'PageDown',
  'page_down': 'PageDown',

  'shift': 'Shift',
  'control': 'Control',
  'ctrl': 'Control',
  'alt': 'Alt',
  'opt': 'Alt',
  'option': 'Alt',
  'super': 'Super',
  'super_l': 'Super',
  'win': 'Super',
  'windows': 'Super',
  'command_l': 'Super',
  // mod / cmd / command / meta are a different key per OS: normalizeKey asks modifierOf.

  'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
  'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
  'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',

  // Symbols — LLMs often send these as words instead of characters
  'asterisk': '*',
  'star': '*',
  'multiply': '*',
  'plus': '+',
  'minus': '-',
  'dash': '-',
  'slash': '/',
  'forwardslash': '/',
  'backslash': '\\',
  'equals': '=',
  'equal': '=',
  'at': '@',
  'hash': '#',
  'hashtag': '#',
  'dollar': '$',
  'percent': '%',
  'ampersand': '&',
  'underscore': '_',
  'period': '.',
  'dot': '.',
  'comma': ',',
  'colon': ':',
  'semicolon': ';',
  'exclamation': '!',
  'question': '?',
  'tilde': '~',
  'pipe': '|',
  'caret': '^',
  'leftparen': '(',
  'rightparen': ')',
  'leftbracket': '[',
  'rightbracket': ']',
  'leftbrace': '{',
  'rightbrace': '}',
  'lessthan': '<',
  'greaterthan': '>',
  'quote': "'",
  'singlequote': "'",
  'doublequote': '"',
  'backtick': '`',
  'grave': '`',
};

/**
 * Normalize a single key name to its canonical form.
 * E.g. "enter" → "Return", "ctrl" → "Control", "esc" → "Escape"
 *
 * Returns the input unchanged if no alias is found (e.g. single characters).
 */
export function normalizeKey(key: string): string {
  if (!key || typeof key !== 'string') {
    throw new Error(`normalizeKey: expected non-empty string, got ${typeof key}: ${JSON.stringify(key)}`);
  }
  const t = key.toLowerCase();
  if (OS_DEPENDENT.has(t)) return MODIFIER_KEY[modifierOf(t)!];
  return KEY_ALIASES[t] || key;
}

const OS_DEPENDENT = new Set(['mod', 'cmd', 'command', 'meta']);
const MODIFIER_KEY: Record<Modifier, string> = { ctrl: 'Control', shift: 'Shift', alt: 'Alt', super: 'Super' };

/** A modifier key, as an executor presses it. `super` is Cmd on macOS and the Super / Windows key elsewhere. */
export type Modifier = 'ctrl' | 'shift' | 'alt' | 'super';

/**
 * The modifier names macOS accepts — both Mac executors (MacOSAdapter, NativeDesktop) ask modifierOf, so they agree. win / windows /
 * super_l / command_l are not among them: there `super` is Cmd, and win+q pressed Cmd+Q (quitting the front app).
 */
const MAC_MODIFIER_NAMES = new Set(['mod', 'cmd', 'command', 'super', 'meta', 'shift', 'alt', 'option', 'opt', 'ctrl', 'control']);

/**
 * The modifier a combo's modifier token presses on `platform`, by the aliases above (opt / option = alt, win = super,
 * `mod` = this OS's shortcut modifier, cmd / command / meta = Ctrl on Windows and Super elsewhere). Null when the token is
 * no modifier: an executor refuses that combo instead of pressing the key without it (`opt+x` must never send a plain x).
 * On macOS only MAC_MODIFIER_NAMES count.
 */
export function modifierOf(token: string, platform: NodeJS.Platform = process.platform): Modifier | null {
  const t = token.trim().toLowerCase();
  if (platform === 'darwin' && !MAC_MODIFIER_NAMES.has(t)) return null;
  // cmd / command / meta are the Mac's primary modifier: Ctrl on Windows, as the Windows adapter has always pressed them.
  // As the Windows key, "cmd+l" pressed Win+L (lock screen) through one executor and Ctrl+L through the other.
  if (t === 'mod') return platform === 'darwin' ? 'super' : 'ctrl';
  if (t === 'cmd' || t === 'command' || t === 'meta') return platform === 'win32' ? 'ctrl' : 'super';
  switch (KEY_ALIASES[t]) {
    case 'Control': return 'ctrl';
    case 'Shift': return 'shift';
    case 'Alt': return 'alt';
    case 'Super': return 'super';
    default: return null;
  }
}

