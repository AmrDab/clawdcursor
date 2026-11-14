/**
 * Canonical key name normalization.
 *
 * Single source of truth for mapping human-readable key names
 * to internal key identifiers used across the codebase.
 */

/**
 * Platform-aware "primary modifier" — `mod` resolves to Cmd on macOS and
 * Ctrl on Windows/Linux. This matches the convention used by editor
 * frameworks (CodeMirror, ProseMirror, Tiptap) and the v2 PlatformAdapter.
 * Without this alias the legacy `NativeDesktop.keyPress` would either throw
 * `Unknown key: "mod"` (Win/Linux) or silently drop the modifier on macOS.
 */
const PLATFORM_PRIMARY_MOD = process.platform === 'darwin' ? 'Super' : 'Control';

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
const CMD_MOD = process.platform === 'win32' ? 'Control' : 'Super';

/** Canonical key name map — input (case-insensitive) → normalized name */
const KEY_ALIASES: Record<string, string> = {
  // Enter / Return
  'return': 'Return',
  'enter': 'Return',

  // Whitespace & navigation
  'space': 'Space',
  'spacebar': 'Space',
  'tab': 'Tab',
  'escape': 'Escape',
  'esc': 'Escape',
  'backspace': 'Backspace',
  'delete': 'Delete',

  // Arrow keys
  'up': 'Up',
  'down': 'Down',
  'left': 'Left',
  'right': 'Right',

  // Page navigation
  'home': 'Home',
  'end': 'End',
  'pageup': 'PageUp',
  'page_up': 'PageUp',
  'pagedown': 'PageDown',
  'page_down': 'PageDown',

  // Modifiers
  'shift': 'Shift',
  'control': 'Control',
  'ctrl': 'Control',
  'alt': 'Alt',
  'opt': 'Alt',
  'option': 'Alt',
  // cmd / command / meta are the Mac's primary modifier: Ctrl on Windows, as the Windows adapter has always pressed them
  // (windows.ts keyPress). Mapping them to the Windows key here made the two executors disagree — "cmd+l" pressed
  // Ctrl+L through one and Win+L (lock screen) through the other. Linux keeps Super, as its adapter does.
  'meta': CMD_MOD,
  'super': 'Super',
  'super_l': 'Super',
  'win': 'Super',
  'windows': 'Super',
  'cmd': CMD_MOD,
  'command': CMD_MOD,
  'command_l': 'Super',

  // Platform-aware "primary" modifier — Cmd on macOS, Ctrl on Win/Linux.
  // Resolved at module load via PLATFORM_PRIMARY_MOD above.
  'mod': PLATFORM_PRIMARY_MOD,

  // Function keys
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
  return KEY_ALIASES[key.toLowerCase()] || key;
}

/** A modifier key, as an executor presses it. `super` is Cmd on macOS and the Super / Windows key elsewhere. */
export type Modifier = 'ctrl' | 'shift' | 'alt' | 'super';

/**
 * The modifier names macOS accepts — exactly MacOSAdapter.normalizeMod's, so both Mac executors agree. win / windows /
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
  // KEY_ALIASES resolves these three for the OS this process runs on; `platform` decides here.
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

