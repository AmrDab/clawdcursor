/**
 * A value-setting action succeeds only when the field holds the value that was asked for.
 *
 * Live (Windows 11, a CAD app whose fields ignore Ctrl+A, 1.5.27): set_value "30" on a field holding "100" fell back to
 * typing, left "10030" and answered ok; smart_type then left "1003300" and said "read back ✓" (the field CONTAINED the
 * text); get_value failed with code UNKNOWN. Every path now ends in one read-back that compares the whole value.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { readBackTyped, fieldRead } from '../tools/paste-guard';
import { classifyResult } from '../core/result-codes';

const setTool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
const getTool = buildUnifiedTools().find(t => t.name === 'a11y_get_value')!;
const EDIT = [{ name: 'Distance', controlType: 'Edit', bounds: { x: 60, y: 8, width: 200, height: 22 } }];

/** `invoke` answers the by-name calls (set-value, get-value); `focused` is what the focused field shows. */
function ctxWith(invoke: (q: any) => any, focused?: string) {
  const p = {
    platform: 'win32',
    invokeElement: vi.fn(async (q: any) => invoke(q)),
    findElements: vi.fn(async () => EDIT),
    getFocusedElement: vi.fn(async (): Promise<any> => (focused === undefined ? null : { value: focused })),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    getActiveWindow: vi.fn(async (): Promise<any> => ({ processId: 7, title: 'Form' })),
    focusWindow: vi.fn(async () => true),
    listDisplays: vi.fn(async () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, dpiRatio: 1 }]),
  };
  return { ctx: { platform: p, screen: { physicalWidth: 1920, physicalHeight: 1080 } } as any, p };
}
const set = (ctx: any, value = '30') => setTool.execute({ name: 'Distance', value, processId: 7 }, ctx);

describe('readBackTyped — whole value', () => {
  const f = (value: string) => async () => ({ value });
  const whole = async (shown: string, want: string) => (await readBackTyped(f(shown), want, { whole: true, maxMs: 0 })).result;

  it('the same text is a match: whitespace and case aside', async () => {
    expect(await whole(' 30\r\n', '30')).toBe('match');
    expect(await whole('a  b', 'a b')).toBe('match');
    expect(await whole('REPORT.TXT', 'report.txt')).toBe('match');   // the Windows bridge's own -eq ignores case too
  });

  it('a number is compared as a number: the field may format it or add a unit', async () => {
    for (const shown of ['30.0', '30.00', '30,00', '30 mm', '30mm', '+30', '$30.00', '€ 30']) expect(await whole(shown, '30')).toBe('match');
    expect(await whole('-2.50 m', '-2.5')).toBe('match');
    // old text that was not replaced, or another number: never a match, and never "starts with it"
    for (const shown of ['10030', '1003300', '300', '30.5', '30,5', '100', '30/11/2026', 'x30']) {
      expect(await whole(shown, '30')).toBe('mismatch');
    }
  });

  it('text with more after it (an autocomplete suggestion) is "suffix"; anything else a mismatch', async () => {
    expect(await whole('github.com/login', 'github.com')).toBe('suffix');
    expect(await whole('see github.com', 'github.com')).toBe('mismatch');
    expect(await whole('oldnew', 'new')).toBe('mismatch');
    expect(await whole('11/10/2026', '2026-11-10')).toBe('mismatch');
  });

  it('the same letters and digits in another format (separators, a mask) is "suffix": it cannot be told from a success', async () => {
    for (const shown of ['1,000', '1.000', '1 000']) expect(await whole(shown, '1000')).toBe('suffix');
    expect(await whole('(555) 123-4567', '5551234567')).toBe('suffix');
    expect(await whole('4111 1111 1111 1111', '4111111111111111')).toBe('suffix');
    expect(await whole('AB-12 cd', 'ab12cd')).toBe('suffix');
    expect(await whole('--', '++')).toBe('mismatch');
  });

  // An empty read with no word on whether the field could be read (the focused element) is what an unreadable field gives
  // too (Win11 RichEdit's ValuePattern is always ""): never a proof.
  it('an empty read that does not say the field is readable proves nothing; a clear fails on a field that still shows text', async () => {
    expect(await whole('', '')).toBe('unknown');
    expect(await whole('100', '')).toBe('mismatch');
    expect((await readBackTyped(async () => null, '', { whole: true, maxMs: 0 })).result).toBe('unknown');
    expect((await readBackTyped(f(''), '30', { whole: true, maxMs: 0 })).result).toBe('unknown');
  });

  // A by-name value read says `readable`: then empty means empty.
  it('a READABLE empty read confirms a clear, and is a mismatch after a set', async () => {
    const r = (value: string) => async () => ({ value, readable: true });
    expect((await readBackTyped(r(''), '', { whole: true, maxMs: 0 })).result).toBe('match');
    expect(await readBackTyped(r(''), 'Ada Lovelace', { whole: true, maxMs: 0 })).toEqual({ result: 'mismatch', value: '' });
    expect((await readBackTyped(r('  '), '', { whole: true, maxMs: 0 })).result).toBe('match');
    // a password field is never readable, whatever else the read says
    expect((await readBackTyped(async () => ({ value: '', readable: true, secure: true }), 'x', { whole: true, maxMs: 0 })).result).toBe('unknown');
    // typing into a document (not `whole`) is unchanged
    expect((await readBackTyped(r(''), 'x', { maxMs: 0 })).result).toBe('unknown');
  });

  it('fieldRead: what a by-name get-value says the field holds', () => {
    expect(fieldRead({ success: true, data: { value: '', method: 'AXValue', readable: true } })).toEqual({ value: '', readable: true });
    expect(fieldRead({ success: true, data: { value: '30' } })).toEqual({ value: '30', readable: true });      // a non-empty value was read
    expect(fieldRead({ success: true, data: { value: '' } })).toBeNull();                                      // no word: not known
    expect(fieldRead({ success: true, data: { value: 'Your name', method: 'name', readable: false } })).toBeNull();
    expect(fieldRead({ success: true, data: { value: '', readable: false, secure: true } })).toEqual({ secure: true });
    expect(fieldRead({ success: false, data: { value: 'x', readable: true } })).toBeNull();
  });

  it('without `whole` the text anywhere in the field still matches (typing into a document)', async () => {
    expect((await readBackTyped(f('10030'), '30', { maxMs: 0 })).result).toBe('match');
    expect((await readBackTyped(f(''), '', { maxMs: 0 })).result).toBe('unknown');
  });
});

describe('set_field_value — one read-back decides every path', () => {
  const noValuePattern = { success: false, data: { error: 'element exposes neither EditableText nor Value' } };

  it('keyboard fallback that leaves "10030" is a mismatch, not a success: old text not cleared', async () => {
    const { ctx, p } = ctxWith(() => noValuePattern, '10030');
    const r = await set(ctx);
    expect(p.typeText).toHaveBeenCalledWith('30');
    expect(r.success).toBe(false);
    expect(r.text).toContain('the field shows "10030", not the value asked for ("30")');
    expect(r.text).toMatch(/was not replaced/);
    const c = classifyResult(r.text, true, true);
    expect(c?.code).toBe('READBACK_MISMATCH');
    // the hint must not send the agent back to the same call
    expect(c?.hint).toMatch(/did not replace/);
    expect(c?.hint).not.toMatch(/set it again|retry/i);
  });

  it('Linux reads a numeric field back as a float ("30.0"), a field may add a unit: confirmed', async () => {
    for (const shown of ['30.0', '30.00', '30 mm']) {
      const { ctx } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: shown } } : { success: true });
      const r = await set(ctx);
      expect(r.success).toBe(true);
      expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'confirmed' });
    }
  });

  it('a field that shows the value with more after it (autocomplete) succeeds, NOT verified, and says what it shows', async () => {
    const { ctx } = ctxWith(() => noValuePattern, 'github.com/login');
    const r = await set(ctx, 'github.com');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/NOT verified/);
    expect(r.text).toContain('"github.com/login"');
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
  });

  it('a field that shows the value in another format succeeds, NOT verified, and says what it shows', async () => {
    const { ctx } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '1,000' } } : { success: true });
    const r = await set(ctx, '1000');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/NOT verified/);
    expect(r.text).toContain('"1,000"');
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
  });

  it('a clear that reads back empty on a READABLE field is confirmed; one that cannot be told is NOT verified; text still there fails', async () => {
    const cleared = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '', readable: true } } : { success: true });
    const ok = await set(cleared.ctx, '');
    expect(ok.success).toBe(true);
    expect(ok.text).toBe('Set (read back ✓) "Distance" = 0 chars');
    expect(classifyResult(ok.text, false, true)).toEqual({ outcome: 'confirmed' });
    const empty = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '' } } : { success: true });
    const r = await set(empty.ctx, '');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/NOT verified/);
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
    const kept = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: 'old text' } } : { success: true });
    expect((await set(kept.ctx, '')).success).toBe(false);
  });

  it('keyboard fallback that leaves exactly the value is confirmed', async () => {
    const { ctx } = ctxWith(() => noValuePattern, '30');
    const r = await set(ctx);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/^Set \(read back ✓\) "Distance" = 2 chars \(keyboard fallback/);
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'confirmed' });
  });

  it('a bridge that typed but could not read the field (unverified) is read back where the keys went', async () => {
    const { ctx } = ctxWith(() => ({ success: true, data: { unverified: true } }), '10030');
    const r = await set(ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('the field shows "10030"');
  });

  it('a native set the app ignored is typed instead, ONCE; a field that still shows the old text is a mismatch', async () => {
    const { ctx, p } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '100' } } : { success: true });
    p.getFocusedElement = vi.fn(async () => ({ ...EDIT[0], value: '100' }));
    const r = await set(ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('the field shows "100", not the value asked for ("30")');
    expect(r.text).toContain('Typing it into the field (select-all + keys) after the direct set did not change that.');
    expect(p.mouseClick).toHaveBeenCalledTimes(1);
    expect(p.typeText).toHaveBeenCalledTimes(1);
    expect(classifyResult(r.text, true, true)?.code).toBe('READBACK_MISMATCH');
  });

  // Live (macOS 26.5, an empty web field in a WKWebView): the AX set returned success and did nothing; get-value answered
  // with the field's LABEL, so the result was "could not be read back: NOT verified" — 8 calls lost before smart_type.
  describe('a direct set that did nothing on an EMPTY, readable field', () => {
    const NAME = [{ name: 'Your name', controlType: 'Edit', bounds: { x: 60, y: 8, width: 200, height: 22 } }];
    /** The field's text; typing (the fallback) puts the text there when `takesKeys`. */
    function emptyField(takesKeys: boolean, found: any[] = NAME) {
      let shown = '';
      const c = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: shown, method: 'AXValue', readable: true } } : { success: true });
      c.p.findElements = vi.fn(async () => found) as any;
      c.p.typeText = vi.fn(async (t: string) => { if (takesKeys) shown = t; }) as any;
      c.p.getFocusedElement = vi.fn(async () => (found[0] ? { ...found[0], value: shown } : null));   // the click focuses the field
      return c;
    }
    const setName = (ctx: any) => setTool.execute({ name: 'Your name', value: 'Ada Lovelace', processId: 7 }, ctx);

    it('falls back to keys once and says which path set it', async () => {
      const { ctx, p } = emptyField(true);
      const r = await setName(ctx);
      expect(r.success).toBe(true);
      expect(r.text).toBe('Set (read back ✓) "Your name" = 12 chars (set via keys after the direct set had no effect)');
      expect(p.mouseClick).toHaveBeenCalledWith(160, 19);
      expect(p.keyPress).toHaveBeenCalledWith('mod+a');
      expect(p.typeText).toHaveBeenCalledWith('Ada Lovelace');
      expect(p.typeText).toHaveBeenCalledTimes(1);
      expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'confirmed' });
    });

    it('still empty after the keys: a FAILURE that says the field still shows nothing', async () => {
      const { ctx, p } = emptyField(false);
      const r = await setName(ctx);
      expect(r.success).toBe(false);
      expect(r.text).toContain('Set "Your name" failed: the field still shows nothing, not the value asked for ("Ada Lovelace")');
      expect(r.text).not.toMatch(/NOT verified/);
      expect(p.typeText).toHaveBeenCalledTimes(1);
      const c = classifyResult(r.text, true, true);
      expect(c?.code).toBe('READBACK_MISMATCH');
      expect(c?.hint).toMatch(/still empty/);
    });

    it('no such field on screen to type into: the failure stands, nothing is typed', async () => {
      const { ctx, p } = emptyField(true, []);
      const r = await setName(ctx);
      expect(r.success).toBe(false);
      expect(r.text).toContain('the field still shows nothing');
      expect(p.mouseClick).not.toHaveBeenCalled();
      expect(p.typeText).not.toHaveBeenCalled();
    });
  });

  // Review of ac30525: a direct set works on a background or covered window, so the fallback's click could land on
  // whatever is on top, and select-all + typing then replaced THAT control's contents.
  describe('the typing fallback never types anywhere but into the field', () => {
    const FIELD = { name: 'Your name', controlType: 'Edit', bounds: { x: 60, y: 8, width: 200, height: 22 } };
    function ignored(found: any[] = [FIELD]) {
      const c = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '', method: 'AXValue', readable: true } } : { success: true });
      c.p.findElements = vi.fn(async () => found) as any;
      c.p.getFocusedElement = vi.fn(async () => ({ ...FIELD, value: '' }));
      return c;
    }
    const run = (ctx: any) => setTool.execute({ name: 'Your name', value: 'Ada Lovelace', processId: 7 }, ctx);
    const nothingTyped = (p: any) => { expect(p.keyPress).not.toHaveBeenCalled(); expect(p.typeText).not.toHaveBeenCalled(); };

    it('an offscreen field is not clicked', async () => {
      const { ctx, p } = ignored([{ ...FIELD, offscreen: true }]);
      const r = await run(ctx);
      expect(r.success).toBe(false);
      expect(p.mouseClick).not.toHaveBeenCalled();
      nothingTyped(p);
    });

    it('a field whose centre is on no display is not clicked', async () => {
      const { ctx, p } = ignored([{ ...FIELD, bounds: { x: 5000, y: 8, width: 200, height: 22 } }]);
      expect((await run(ctx)).success).toBe(false);
      expect(p.mouseClick).not.toHaveBeenCalled();
      nothingTyped(p);
    });

    it('its window is raised first when another one is in front', async () => {
      const { ctx, p } = ignored();
      const order: string[] = [];
      let front = 99;
      p.getActiveWindow = vi.fn(async () => ({ processId: front, title: 'Editor' }));
      p.focusWindow = vi.fn(async () => { order.push('raise'); front = 7; return true; });
      p.mouseClick = vi.fn(async () => { order.push('click'); });
      await run(ctx);
      expect(p.focusWindow).toHaveBeenCalledWith({ processId: 7 });
      expect(order).toEqual(['raise', 'click']);
      expect(p.typeText).toHaveBeenCalledWith('Ada Lovelace');
    });

    it('a window that will not come to the front: no click, nothing typed', async () => {
      const { ctx, p } = ignored();
      p.getActiveWindow = vi.fn(async () => ({ processId: 99, title: 'Editor' }));
      const r = await run(ctx);
      expect(r.success).toBe(false);
      expect(r.text).toContain('the field still shows nothing');
      expect(p.mouseClick).not.toHaveBeenCalled();
      nothingTyped(p);
    });

    it('the click focused something else (a covering editor): no select-all, nothing typed, and the result says so', async () => {
      for (const other of [
        null,
        { name: 'Text editor', controlType: 'Document', bounds: { x: 0, y: 0, width: 1200, height: 800 }, value: 'a whole document' },
        { name: 'Your name', controlType: 'Text', bounds: FIELD.bounds },                       // the label: not editable
        { name: 'Your name', controlType: 'Edit', secure: true, bounds: FIELD.bounds },
      ]) {
        const { ctx, p } = ignored();
        p.getFocusedElement = vi.fn(async () => other);
        const r = await run(ctx);
        expect(r.success).toBe(false);
        expect(r.text).toContain('could not focus the field to type into it; nothing was typed');
        expect(r.text).not.toMatch(/set via keys|Typing it into the field/);
        nothingTyped(p);
      }
    });

    it('the focused field itself, under another role with the same bounds (a Spinner\'s inner Edit), is typed into', async () => {
      const { ctx, p } = ignored();
      p.getFocusedElement = vi.fn(async () => ({ name: '', controlType: 'Edit', bounds: { x: 61, y: 9, width: 198, height: 20 } }));
      await run(ctx);
      expect(p.typeText).toHaveBeenCalledWith('Ada Lovelace');
    });
  });

  // Typing is only for a set that had NO effect: the field still empty, or exactly what it held before.
  it('a field that holds DIFFERENT text after the set (a reformat) is a failure, with no typing', async () => {
    let shown = '100';
    const { ctx, p } = ctxWith(q => {
      if (q.action === 'get-value') return { success: true, data: { value: shown, readable: true } };
      shown = '11/10/2026';
      return { success: true };
    });
    p.getFocusedElement = vi.fn(async () => ({ ...EDIT[0] }));
    const r = await set(ctx, '2026-11-10');
    expect(r.success).toBe(false);
    expect(r.text).toContain('the field shows "11/10/2026"');
    expect(p.mouseClick).not.toHaveBeenCalled();
    expect(p.typeText).not.toHaveBeenCalled();
  });

  it('a password field stays NOT verified, and is never typed into as a fallback', async () => {
    // the read says so itself (Windows / Linux), or the helper refuses the read (macOS)
    for (const read of [{ success: true, data: { value: '', readable: false, secure: true } }, { success: false, data: { refused: true } }]) {
      const { ctx, p } = ctxWith(q => q.action === 'get-value' ? read : { success: true });
      const r = await set(ctx, 'hunter2');
      expect(r.success).toBe(true);
      expect(r.text).toMatch(/could not be read back: NOT verified/);
      expect(p.mouseClick).not.toHaveBeenCalled();
      expect(p.typeText).not.toHaveBeenCalled();
    }
    // and a field that reads empty but IS a password field on screen is not typed into either
    const { ctx, p } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '', readable: true } } : { success: true });
    p.findElements = vi.fn(async () => [{ name: 'Distance', controlType: 'Edit', secure: true, bounds: { x: 0, y: 0, width: 10, height: 10 } }]) as any;
    expect((await set(ctx, 'hunter2')).success).toBe(false);
    expect(p.typeText).not.toHaveBeenCalled();
  });

  // Live (Windows 11, Edge): <input type="number"> is a UIA Spinner. set_value failed with "no editable field named
  // Quantity to type into", and get_value answered "Quantity" (its name).
  it('a Spinner (a web number box) with no settable value is typed into: it is an editable field', async () => {
    const { ctx, p } = ctxWith(() => noValuePattern, '30');
    p.findElements = vi.fn(async () => [
      { name: 'Quantity', controlType: 'Text', bounds: { x: 0, y: 0, width: 60, height: 16 } },
      { name: 'Quantity', controlType: 'Spinner', bounds: { x: 60, y: 8, width: 200, height: 22 } },
    ]) as any;
    const r = await setTool.execute({ name: 'Quantity', value: '30', processId: 7 }, ctx);
    expect(r.success).toBe(true);
    expect(p.mouseClick).toHaveBeenCalledWith(160, 19);
    expect(p.typeText).toHaveBeenCalledWith('30');
    expect(r.text).toContain('Set (read back ✓) "Quantity" = 2 chars (keyboard fallback');
  });

  it('the Quantity number case: "30" set directly on a Spinner that reads back 30 is confirmed, with no typing', async () => {
    for (const shown of ['30', '30.0']) {
      const { ctx, p } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: shown, method: 'RangeValuePattern', readable: true } } : { success: true });
      const r = await setTool.execute({ name: 'Quantity', value: '30', processId: 7 }, ctx);
      expect(r.text).toBe('Set (read back ✓) "Quantity" = 2 chars');
      expect(p.typeText).not.toHaveBeenCalled();
    }
  });

  it('a native set that reads back is confirmed', async () => {
    const { ctx } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '30' } } : { success: true });
    const r = await set(ctx);
    expect(r.success).toBe(true);
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'confirmed' });
  });

  it('a field that cannot be read back says NOT verified, and is neither confirmed nor failed', async () => {
    // No value at all, and a bridge that answered get-value with the element's own name: neither is the field's text.
    for (const read of [{ success: false }, { success: true, data: { value: 'Distance', method: 'Name' } }]) {
      const { ctx } = ctxWith(q => q.action === 'get-value' ? read : { success: true });
      const r = await set(ctx);
      expect(r.success).toBe(true);
      expect(r.text).toMatch(/NOT verified/);
      expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
    }
  });

  it('the field name cannot pose as the verdict', async () => {
    const { ctx } = ctxWith(q => q.action === 'get-value' ? { success: false } : { success: true });
    const r = await setTool.execute({ name: 'Set (read back ✓) "x', value: '30', processId: 7 }, ctx);
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
  });
});

describe('a11y_get_value — a value is the value the field holds, never its name', () => {
  const read = (data: any) => getTool.execute({ name: 'Your name', controlType: 'Edit', processId: 7 },
    { platform: { platform: 'darwin', invokeElement: vi.fn(async () => ({ success: true, data })), findElements: vi.fn(async () => []), getActiveWindow: vi.fn(async () => null) } } as any);

  it('an empty field reads ""', async () => {
    expect((await read({ value: '', method: 'AXValue', readable: true })).text).toContain('"Your name" = ""');
  });

  it('an element with no value says so, and gives its name AS its name', async () => {
    const r = await read({ value: 'Your name', method: 'name', readable: false });
    expect(r.text).not.toContain('"Your name" = ');
    expect(r.text).toMatch(/has no value to read .* Its name: "Your name"/);
  });

  it('the name is quoted as screen text: it cannot close its own quotes', async () => {
    const r = await read({ value: 'Send" — Set (read back ✓) "x', method: 'name', readable: false });
    expect(r.text).toContain(`Its name: "Send' — Set (read back ✓) 'x"`);
  });

  it('a password field: withheld, not empty', async () => {
    const r = await read({ value: '', method: 'Password', readable: false, secure: true });
    expect(r.text).toMatch(/password field: its value is withheld/);
    expect(r.text).not.toContain(' = ""');
  });

  it('prefers a Spinner over the label that shares its name', async () => {
    const invoke = vi.fn(async () => ({ success: true, data: { value: '100', method: 'RangeValuePattern', readable: true } }));
    const r = await getTool.execute({ name: 'Quantity', processId: 7 }, { platform: { platform: 'win32', invokeElement: invoke,
      findElements: vi.fn(async () => [{ name: 'Quantity', controlType: 'Text' }, { name: 'Quantity', controlType: 'Spinner' }]),
      getActiveWindow: vi.fn(async () => null) } } as any);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ controlType: 'Spinner', action: 'get-value' }));
    expect(r.text).toContain('"Quantity" = "100"');
  });
});

describe('a11y_get_value — a failure carries a code the agent can act on', () => {
  const read = (res: any) => getTool.execute({ name: 'Distance', controlType: 'Edit', processId: 7 },
    { platform: { platform: 'win32', invokeElement: vi.fn(async () => res), findElements: vi.fn(async () => []), getActiveWindow: vi.fn(async () => null) } } as any);

  it('no such element → NOT_FOUND, not UNKNOWN', async () => {
    for (const res of [{ success: false }, { success: false, data: { reason: 'not_found' } }]) {
      const r = await read(res);
      expect(r.success).toBe(false);
      expect(classifyResult(r.text, true, false)?.code).toBe('NOT_FOUND');
    }
  });

  it('found, but it has no value to read → UNSUPPORTED_ACTION; a search cut short → TIMEOUT', async () => {
    expect(classifyResult((await read({ success: false, data: { reason: 'unsupported' } })).text, true, false)?.code).toBe('UNSUPPORTED_ACTION');
    expect(classifyResult((await read({ success: false, data: { reason: 'timeout' } })).text, true, false)?.code).toBe('TIMEOUT');
  });
});
