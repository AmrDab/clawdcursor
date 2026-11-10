/**
 * A value-setting action succeeds only when the field holds the value that was asked for.
 *
 * Live (Windows 11, a CAD app whose fields ignore Ctrl+A, 1.5.27): set_value "30" on a field holding "100" fell back to
 * typing, left "10030" and answered ok; smart_type then left "1003300" and said "read back ✓" (the field CONTAINED the
 * text); get_value failed with code UNKNOWN. Every path now ends in one read-back that compares the whole value.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { readBackTyped } from '../tools/paste-guard';
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
    getFocusedElement: vi.fn(async () => (focused === undefined ? null : { value: focused })),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    getActiveWindow: vi.fn(async () => null),
  };
  return { ctx: { platform: p } as any, p };
}
const set = (ctx: any) => setTool.execute({ name: 'Distance', value: '30', processId: 7 }, ctx);

describe('readBackTyped — whole value', () => {
  const f = (value: string) => async () => ({ value });
  const whole = async (shown: string, want: string) => (await readBackTyped(f(shown), want, { whole: true, maxMs: 0 })).result;

  it('text that merely CONTAINS the value is not a match', async () => {
    expect(await whole('10030', '30')).toBe('suffix');
    expect(await whole('1003300', '30')).toBe('suffix');
    expect(await whole('30.00', '30')).toBe('suffix');
    expect(await whole('100', '30')).toBe('mismatch');
  });

  it('only trivial whitespace is normalized', async () => {
    expect(await whole(' 30\r\n', '30')).toBe('match');
    expect(await whole('a  b', 'a b')).toBe('match');
    expect(await whole('3 0', '30')).toBe('mismatch');
  });

  it('without `whole` the text anywhere in the field still matches (typing into a document)', async () => {
    expect((await readBackTyped(f('10030'), '30', { maxMs: 0 })).result).toBe('match');
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
    expect(classifyResult(r.text, true, true)?.code).toBe('READBACK_MISMATCH');
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

  it('a native set the app ignored (the bridge said success) is a mismatch', async () => {
    const { ctx, p } = ctxWith(q => q.action === 'get-value' ? { success: true, data: { value: '100' } } : { success: true });
    const r = await set(ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('the field shows "100", not the value asked for ("30")');
    expect(p.typeText).not.toHaveBeenCalled();
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
