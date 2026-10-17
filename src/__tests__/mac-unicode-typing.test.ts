/**
 * #242: System Events' `keystroke` types key code 0 ("a") for any character the keyboard layout has no key for, so
 * `typeText('café 日本語')` left "cafa aaa" in the field and reported success. Text outside ASCII now goes through the
 * accessibility helper's Unicode key events; without the helper it is refused, never typed as "a"s. ASCII is unchanged.
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
    stdin: {
      on: () => {},
      end: (data?: string) => {
        if (data !== undefined) programs.push(data);
        queueMicrotask(() => cb(null, { stdout: '', stderr: '' }));
      },
    },
  }),
  spawn: vi.fn(),
}));

import { typeTextMac, hasNonAscii } from '../platform/mac-keyboard';
import { MacOSAdapter } from '../platform/macos';
import type { MacAx } from '../platform/mac-ax';

const typeUnicode = vi.fn<(text: string) => Promise<boolean>>();
const mac = new MacOSAdapter({ ax: { typeUnicode, frontmost: vi.fn(), prepare: vi.fn() } as unknown as MacAx });

beforeEach(() => {
  programs.length = 0;
  typeUnicode.mockReset();
  typeUnicode.mockResolvedValue(true);
  process.env.CLAWD_NO_MAC_AX = '1';   // no keyboard-owner probe here; the fake ax answers typeUnicode itself
});
afterEach(() => { process.env.CLAWD_NO_MAC_AX = '1'; });

describe('hasNonAscii', () => {
  it.each([['abc "x" \\ 123', false], ['café', true], ['日本語', true], ['😀', true], ['', false]])('%s → %s', (text, want) => {
    expect(hasNonAscii(text)).toBe(want);
  });
});

describe('typeTextMac', () => {
  it('ASCII: the same System Events program as before', async () => {
    await typeTextMac({ typeUnicode }, 'say "hi"', 5_000);
    expect(programs).toEqual(['tell application "System Events" to keystroke "say \\"hi\\""']);
    expect(typeUnicode).not.toHaveBeenCalled();
  });

  it('text outside ASCII goes to the helper whole: no keystroke program at all', async () => {
    await typeTextMac({ typeUnicode }, 'café 日本語', 5_000);
    expect(typeUnicode).toHaveBeenCalledWith('café 日本語');
    expect(programs).toEqual([]);
  });

  it('without the helper it refuses, and the error does not repeat the text', async () => {
    typeUnicode.mockResolvedValue(false);
    const err = await typeTextMac({ typeUnicode }, 'pässwörd', 5_000).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/outside ASCII/);
    expect(err.message).toMatch(/xcode-select --install/);
    expect(err.message).not.toContain('pässwörd');
    expect(programs).toEqual([]);
  });
});

describe('MacOSAdapter', () => {
  it('typeText with accents types them as themselves', async () => {
    await mac.typeText('crème brûlée');
    expect(typeUnicode).toHaveBeenCalledWith('crème brûlée');
    expect(programs).toEqual([]);
  });

  it('typeText ASCII is unchanged', async () => {
    await mac.typeText('hello');
    expect(programs).toEqual(['tell application "System Events" to keystroke "hello"']);
  });

  it.each(['é', '日', '😀'])('keyPress %s types the character', async key => {
    await mac.keyPress(key);
    expect(typeUnicode).toHaveBeenCalledWith(key);
    expect(programs).toEqual([]);
  });

  it('keyPress cmd+é is refused: System Events would press ⌘A (select all)', async () => {
    await expect(mac.keyPress('cmd+é')).rejects.toThrow(/not a key of the keyboard layout/);
    expect(typeUnicode).not.toHaveBeenCalled();
    expect(programs).toEqual([]);
  });

  it('keyPress of ASCII keys and combos is unchanged', async () => {
    await mac.keyPress('cmd+a');
    expect(programs).toEqual(['tell application "System Events" to keystroke "a" using {command down}']);
  });
});
