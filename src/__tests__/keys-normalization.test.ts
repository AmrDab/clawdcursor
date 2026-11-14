/**
 * Key normalization tests — verify normalizeKey handles edge cases
 * and provides clear error messages for invalid input.
 */

import { describe, it, expect } from 'vitest';
import { modifierOf, normalizeKey } from '../platform/keys';

describe('normalizeKey', () => {
  describe('valid inputs', () => {
    it('normalizes common key names', () => {
      expect(normalizeKey('enter')).toBe('Return');
      expect(normalizeKey('return')).toBe('Return');
      expect(normalizeKey('esc')).toBe('Escape');
      expect(normalizeKey('escape')).toBe('Escape');
      expect(normalizeKey('backspace')).toBe('Backspace');
      expect(normalizeKey('delete')).toBe('Delete');
      expect(normalizeKey('tab')).toBe('Tab');
    });

    it('normalizes modifier keys', () => {
      expect(normalizeKey('ctrl')).toBe('Control');
      expect(normalizeKey('control')).toBe('Control');
      expect(normalizeKey('shift')).toBe('Shift');
      expect(normalizeKey('alt')).toBe('Alt');
      expect(normalizeKey('option')).toBe('Alt');
    });

    it('normalizes function keys', () => {
      expect(normalizeKey('f1')).toBe('F1');
      expect(normalizeKey('f5')).toBe('F5');
      expect(normalizeKey('f12')).toBe('F12');
    });

    it('passes through single characters unchanged', () => {
      expect(normalizeKey('a')).toBe('a');
      expect(normalizeKey('Z')).toBe('Z');
      expect(normalizeKey('5')).toBe('5');
      expect(normalizeKey('*')).toBe('*');
    });

    it('handles arrow keys', () => {
      expect(normalizeKey('up')).toBe('Up');
      expect(normalizeKey('down')).toBe('Down');
      expect(normalizeKey('left')).toBe('Left');
      expect(normalizeKey('right')).toBe('Right');
    });
  });

  describe('invalid inputs', () => {
    it('throws on undefined', () => {
      expect(() => normalizeKey(undefined as any)).toThrow(/expected non-empty string/);
    });

    it('throws on null', () => {
      expect(() => normalizeKey(null as any)).toThrow(/expected non-empty string/);
    });

    it('throws on empty string', () => {
      expect(() => normalizeKey('')).toThrow(/expected non-empty string/);
    });

    it('throws on non-string types', () => {
      expect(() => normalizeKey(123 as any)).toThrow(/expected non-empty string/);
      expect(() => normalizeKey({} as any)).toThrow(/expected non-empty string/);
      expect(() => normalizeKey([] as any)).toThrow(/expected non-empty string/);
    });
  });
});

describe('modifierOf — one alias table for every executor', () => {
  it.each([
    ['opt', 'alt'], ['option', 'alt'], ['alt', 'alt'], ['ctrl', 'ctrl'], ['Control', 'ctrl'], ['shift', 'shift'],
    ['win', 'super'], ['windows', 'super'], ['super', 'super'], [' Super ', 'super'],
  ])('%s is %s on every OS', (token, mod) => {
    for (const os of ['darwin', 'linux', 'win32'] as const) expect(modifierOf(token, os)).toBe(mod);
  });

  it('mod is this OS\'s shortcut modifier; cmd / command / meta are Ctrl on Windows only', () => {
    expect(modifierOf('mod', 'darwin')).toBe('super');
    expect(modifierOf('mod', 'linux')).toBe('ctrl');
    expect(modifierOf('mod', 'win32')).toBe('ctrl');
    for (const t of ['cmd', 'command', 'meta']) {
      expect(modifierOf(t, 'darwin')).toBe('super');
      expect(modifierOf(t, 'linux')).toBe('super');
      expect(modifierOf(t, 'win32')).toBe('ctrl');
    }
  });

  it('anything else is no modifier (the executor refuses it rather than dropping it)', () => {
    for (const t of ['hyper', 'fn', 'x', 'enter', '']) expect(modifierOf(t, 'linux')).toBeNull();
  });
});
