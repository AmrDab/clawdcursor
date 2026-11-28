/**
 * Typing through the clipboard on a Mac saved the user's clipboard as text only (pbpaste), so an image or a file on it was
 * replaced by the typed text and lost. A clipboard of non-text data is never pasted over: the text is typed as keys when
 * that is safe, else the call is refused. When it did paste and put the clipboard back, the result says so.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { clipboardInfoHoldsNonText } from '../platform/mac-clipboard';
import { pasteChoice, NON_TEXT_KEYS_MAX } from '../tools/paste-guard';
import { buildCoreTools } from '../tools/core-tools';
import { classifyResult } from '../core/result-codes';
import type { AgentToolContext } from '../tools/types';
import { makeMockPlatform } from './helpers/mock-platform';

describe('clipboardInfoHoldsNonText (osascript clipboard info)', () => {
  it.each([
    ['{{string, 5}, {«class utf8», 5}}', false],
    ['{{«class utf8», 5}, {Unicode text, 10}, {«class RTF », 120}, {«class HTML», 300}}', false],
    ['{{«class utf8», 5}, {«class dyn.ah62d4rv4gu8y6y4grf0gn5xbrzw1gydcr7u1e3cytf2gn», 5}}', false],
    ['{{«class PNGf», 912}, {«class TIFF», 4096}}', true],
    ['{{«class furl», 40}, {«class utf8», 40}}', true],
    ['{{«class RTFD», 900}, {«class RTF », 100}}', true],
    ['{{PDF picture, 2000}}', true],
    // What osascript really prints (Mac check 2026-11-17): a flat list, no braces.
    ['«class PNGf», 116278, «class AVIF», 6905, «class 8BPS», 1176926, GIF picture, 23460, «class jp2 », 1126402, JPEG picture, 140932, TIFF picture, 4198020, «class BMPf», 4198470, «class TPIC», 23006', true],
    ['«class utf8», 0, «class ut16», 2, string, 0, Unicode text, 0', false],
    ['«class furl», 40, «class utf8», 40', true],
    ['«class RTF », 1200, «class utf8», 10, «class ut16», 22, string, 10, scrap styles, 22, Unicode text, 20, styled Clipboard text, 22', false],
    ['', false],
    ['missing value', false],
  ])('%s → %s', (info, expected) => {
    expect(clipboardInfoHoldsNonText(info)).toBe(expected);
  });
});

describe('pasteChoice', () => {
  const o = (nonTextClipboard: boolean, privateTyping = true) => ({ nonTextClipboard, privateTyping });
  it('a text clipboard (or one that cannot be told): paste, as before', () => {
    expect(pasteChoice('x'.repeat(5000), o(false))).toBe('paste');
  });
  it('non-text clipboard: printable ASCII up to the limit is typed as keys', () => {
    expect(pasteChoice('x'.repeat(NON_TEXT_KEYS_MAX), o(true))).toBe('keys');
  });
  it('non-text clipboard: too long, a line break or tab, non-ASCII, or typing not private is refused', () => {
    expect(pasteChoice('x'.repeat(NON_TEXT_KEYS_MAX + 1), o(true))).toBe('refuse');
    expect(pasteChoice('a\nb', o(true))).toBe('refuse');
    expect(pasteChoice('a\tb', o(true))).toBe('refuse');
    expect(pasteChoice('café', o(true))).toBe('refuse');
    expect(pasteChoice('hunter2', o(true, false))).toBe('refuse');
  });
});

describe('the type tool with an image on the clipboard', () => {
  const typeTool = buildCoreTools().find(t => t.name === 'type_text')!;
  const LONG = 'Lorem ipsum dolor sit amet, '.repeat(6);
  function ctxWith(nonText: boolean | undefined): AgentToolContext {
    const platform = makeMockPlatform();
    if (nonText !== undefined) (platform as { clipboardHoldsNonText?: () => Promise<boolean> }).clipboardHoldsNonText = vi.fn(async () => nonText);
    return { platform, _platform: 'darwin', screen: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 }, cdp: null } as unknown as AgentToolContext;
  }

  it('long ASCII text is typed as keys: the clipboard is not written, not even to be restored', async () => {
    const ctx = ctxWith(true);
    const r = await typeTool.execute({ text: LONG }, ctx);
    expect(ctx.platform.typeText).toHaveBeenCalledWith(LONG);
    expect(ctx.platform.writeClipboard).not.toHaveBeenCalled();
    expect(ctx.platform.keyPress).not.toHaveBeenCalledWith('mod+v');
    expect(r.text).toMatch(/^Typed \d+ chars \(keys/);
  });

  it('text that cannot be typed safely is refused with nothing typed, nothing written, and its own result code', async () => {
    const ctx = ctxWith(true);
    const r = await typeTool.execute({ text: 'line one\nline two' }, ctx);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/^refused: the clipboard holds an image, file or other non-text data/);
    expect(ctx.platform.typeText).not.toHaveBeenCalled();
    expect(ctx.platform.writeClipboard).not.toHaveBeenCalled();
    expect(classifyResult(r.text, true, true, 'mcp')).toMatchObject({ outcome: 'refused', code: 'CLIPBOARD_HELD' });
  });

  it('a text clipboard (or a platform that cannot say): pasted and put back, and the result says so', async () => {
    for (const nonText of [false, undefined]) {
      const ctx = ctxWith(nonText);
      const r = await typeTool.execute({ text: 'line one\nline two' }, ctx);
      expect(r.text).toContain('(paste, clipboard restored');
      expect(ctx.platform.keyPress).toHaveBeenCalledWith('mod+v');
    }
  });

  it('short ASCII text never asks about the clipboard', async () => {
    const ctx = ctxWith(true);
    await typeTool.execute({ text: 'hello' }, ctx);
    expect((ctx.platform as unknown as { clipboardHoldsNonText: ReturnType<typeof vi.fn> }).clipboardHoldsNonText).not.toHaveBeenCalled();
  });
});

describe('the read-back verdict with the restore note', () => {
  it('"(paste, clipboard restored, read back ✓)" is still confirmed', () => {
    expect(classifyResult('Typed 5 chars (paste, clipboard restored, read back ✓): "hello"', false, true, 'mcp')).toMatchObject({ outcome: 'confirmed' });
  });
});
