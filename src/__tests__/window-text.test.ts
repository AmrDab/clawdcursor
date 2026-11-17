/**
 * window-text normalization (#bug 2026-06-11): batch window/element guards
 * falsely failed because real titles carry invisible Unicode (Edge's NBSP in
 * "Microsoft Edge"). The normalizer must fold those so a human-written guard
 * matches the live title.
 */
import { describe, it, expect } from 'vitest';
import { normalizeWindowText, windowTextIncludes } from '../platform/window-text';

const NBSP = String.fromCharCode(0x00a0);   // NO-BREAK SPACE (Edge title separator)
const NNBSP = String.fromCharCode(0x202f);  // NARROW NO-BREAK SPACE
const ZWSP = String.fromCharCode(0x200b);   // ZERO WIDTH SPACE

describe('normalizeWindowText', () => {
  it('folds NBSP and narrow-NBSP to a normal space', () => {
    expect(normalizeWindowText(`Microsoft${NBSP}Edge`)).toBe('microsoft edge');
    expect(normalizeWindowText(`Foo${NNBSP}Bar`)).toBe('foo bar');
  });
  it('strips zero-width characters', () => {
    expect(normalizeWindowText(`Foo${ZWSP}Bar`)).toBe('foobar');
  });
  it('collapses whitespace runs, trims, lower-cases', () => {
    expect(normalizeWindowText('  Untitled   -   Notepad  ')).toBe('untitled - notepad');
  });
  it('handles null/undefined/empty', () => {
    expect(normalizeWindowText(undefined)).toBe('');
    expect(normalizeWindowText(null)).toBe('');
    expect(normalizeWindowText('')).toBe('');
  });
});

describe('windowTextIncludes', () => {
  it('matches "Microsoft Edge" against a real NBSP-laden Edge title', () => {
    const live = `Device Activation and 6 more pages - Personal - Microsoft${NBSP}Edge`;
    expect(windowTextIncludes(live, 'Microsoft Edge')).toBe(true);   // the bug: was false
    expect(windowTextIncludes(live, 'Edge')).toBe(true);
    expect(windowTextIncludes(live, 'Device Activation')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(windowTextIncludes('Untitled - Notepad', 'notepad')).toBe(true);
  });
  it('does not match an absent needle', () => {
    expect(windowTextIncludes('Untitled - Notepad', 'chrome')).toBe(false);
  });
  it('empty needle never matches', () => {
    expect(windowTextIncludes('anything', '')).toBe(false);
    expect(windowTextIncludes('anything', undefined)).toBe(false);
  });
});
