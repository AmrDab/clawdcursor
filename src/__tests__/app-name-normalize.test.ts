/**
 * Tests for `normalizeAppName` and the alias-resolution path that consumes it.
 *
 * The original symptom: user typed `open outlook app`, the router stripped
 * only quotes/case, the alias lookup missed (`APP_ALIASES` keys on `'outlook'`,
 * not `'outlook app'`), and the launch fell through to "type the literal
 * phrase into Start Menu" — which Windows Search couldn't resolve correctly.
 *
 * These tests pin down the rules so future tweaks don't quietly regress
 * common phrasings.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAppName } from '../core/router/normalize';
import { resolveAlias } from '../core/router/aliases';

describe('normalizeAppName', () => {
  it('lowercases and trims', () => {
    expect(normalizeAppName('  Outlook  ')).toBe('outlook');
    expect(normalizeAppName('OUTLOOK')).toBe('outlook');
  });

  it('strips trailing filler suffixes', () => {
    expect(normalizeAppName('outlook app')).toBe('outlook');
    expect(normalizeAppName('outlook application')).toBe('outlook');
    expect(normalizeAppName('edge browser')).toBe('edge');
    expect(normalizeAppName('chrome window')).toBe('chrome');
    expect(normalizeAppName('paint program')).toBe('paint');
  });

  it('strips leading articles', () => {
    expect(normalizeAppName('the outlook')).toBe('outlook');
    expect(normalizeAppName('a calculator')).toBe('calculator');
    expect(normalizeAppName('an excel sheet')).toBe('excel sheet');
  });

  it('strips article + suffix together', () => {
    expect(normalizeAppName('the outlook app')).toBe('outlook');
    expect(normalizeAppName('the edge browser')).toBe('edge');
    expect(normalizeAppName('a calculator app')).toBe('calculator');
  });

  it('strips repeated suffixes (bounded loop)', () => {
    expect(normalizeAppName('outlook app application')).toBe('outlook');
    expect(normalizeAppName('chrome browser app')).toBe('chrome');
  });

  it('keeps brand-qualified canonical names intact', () => {
    expect(normalizeAppName('Microsoft Outlook')).toBe('microsoft outlook');
    expect(normalizeAppName('Google Chrome')).toBe('google chrome');
    expect(normalizeAppName('Microsoft Word')).toBe('microsoft word');
  });

  it('strips quotes (straight + smart)', () => {
    expect(normalizeAppName('"outlook"')).toBe('outlook');
    expect(normalizeAppName("'chrome'")).toBe('chrome');
    expect(normalizeAppName('“calculator”')).toBe('calculator');
    expect(normalizeAppName('‘edge’')).toBe('edge');
  });

  it('handles empty / whitespace input', () => {
    expect(normalizeAppName('')).toBe('');
    expect(normalizeAppName('   ')).toBe('');
    expect(normalizeAppName('\t\n')).toBe('');
  });

  it('does NOT strip filler words from the middle of names', () => {
    // "Application" mid-name is not a suffix — only trailing filler words match.
    expect(normalizeAppName('app store')).toBe('app store');
    // "Word" alias (for Microsoft Word) keeps its meaning even though "Word" alone is short.
    expect(normalizeAppName('word')).toBe('word');
  });

  it('is idempotent — normalize(normalize(x)) === normalize(x)', () => {
    const inputs = [
      'the Outlook app',
      'Microsoft Outlook',
      'Edge browser',
      'calc',
      '"chrome"',
      'a calculator program',
    ];
    for (const input of inputs) {
      const once = normalizeAppName(input);
      const twice = normalizeAppName(once);
      expect(twice).toBe(once);
    }
  });
});

describe('resolveAlias picks up normalization', () => {
  it('"open outlook app" → resolves to outlook alias', () => {
    const alias = resolveAlias('outlook app');
    expect(alias?.key).toBe('outlook');
    expect(alias?.searchTerm).toBe('Outlook');
  });

  it('"the Outlook app" → resolves to outlook alias', () => {
    const alias = resolveAlias('the Outlook app');
    expect(alias?.key).toBe('outlook');
  });

  it('"Edge browser" → resolves to edge alias', () => {
    const alias = resolveAlias('Edge browser');
    expect(alias?.key).toBe('edge');
    expect(alias?.searchTerm).toBe('Edge');
  });

  it('"the calculator app" → resolves to calculator alias (with UWP id)', () => {
    const alias = resolveAlias('the calculator app');
    expect(alias?.key).toBe('calculator');
    expect(alias?.uwpAppId).toMatch(/Microsoft\.WindowsCalculator/);
  });

  it('"Microsoft Outlook" → resolves to microsoft outlook alias (no false match)', () => {
    const alias = resolveAlias('Microsoft Outlook');
    expect(alias?.key).toBe('microsoft outlook');
  });

  it('unknown app returns null', () => {
    expect(resolveAlias('blender app')).toBeNull();
    expect(resolveAlias('frobnicator browser')).toBeNull();
  });

  it('quoted user input still resolves', () => {
    expect(resolveAlias('"chrome"')?.key).toBe('chrome');
    expect(resolveAlias("'edge'")?.key).toBe('edge');
  });
});

describe('Windows Settings launches directly', () => {
  // Live Win11 re-test 2026-10-15: open_app "Settings" took 16.8 s. The alias
  // had no launcher, so `Start-Process -FilePath Settings` failed, its 4 s
  // window wait ran out, and only then did the Start-Menu search open it.
  it('the settings alias carries the Settings AppsFolder id', () => {
    expect(resolveAlias('settings')?.uwpAppId).toBe('windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel');
  });
});
