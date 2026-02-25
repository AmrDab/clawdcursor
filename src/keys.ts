/**
 * Canonical key name normalization.
 *
 * Single source of truth for mapping human-readable key names
 * to internal key identifiers used across the codebase.
 */

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
  'meta': 'Super',
  'super': 'Super',
  'super_l': 'Super',
  'win': 'Super',
  'windows': 'Super',
  'cmd': 'Super',
  'command': 'Super',
  'command_l': 'Super',

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
  return KEY_ALIASES[key.toLowerCase()] || key;
}

/**
 * Normalize a key combo string like "ctrl+shift+a" → "Control+Shift+a"
 */
export function normalizeKeyCombo(combo: string): string {
  if (!combo.includes('+')) return normalizeKey(combo);
  return combo.split('+').map(k => normalizeKey(k.trim())).join('+');
}
