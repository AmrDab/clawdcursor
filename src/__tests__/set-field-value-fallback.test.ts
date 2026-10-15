/**
 * set_field_value's keyboard fallback (live Linux re-test 2026-10-15: a Chrome
 * text field exposes neither EditableText nor Value, so set_value by name
 * failed while the element-ref route typed). The fallback now runs on every OS,
 * and only when the field was really focused or located — it must never type
 * into whatever happens to have focus.
 */
import { describe, it, expect, vi } from 'vitest';
import { getA11yDepthTools } from '../tools/a11y_depth';
import type { ToolContext } from '../tools/types';

const tool = getA11yDepthTools().find(t => t.name === 'set_field_value')!;

function ctxWith(platform: string, invoke: (args: any) => any, found: any[] = []) {
  const p = {
    platform,
    invokeElement: vi.fn(async (args: any) => invoke(args)),
    findElements: vi.fn(async () => found),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
  };
  const ctx = { ensureInitialized: async () => {}, platform: p, a11y: { getActiveWindow: async () => null } } as unknown as ToolContext;
  return { ctx, p };
}

describe('set_field_value keyboard fallback', () => {
  it('Linux: no value pattern, field focused → select-all and type', async () => {
    const { ctx, p } = ctxWith('linux', a => a.action === 'set-value'
      ? { success: false, data: { error: 'element exposes neither EditableText nor Value' } }
      : { success: true });
    const r = await tool.handler({ name: 'City', value: 'Lisbon', processId: 42 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/keyboard fallback/);
    expect(p.keyPress).toHaveBeenCalledWith('mod+a');
    expect(p.typeText).toHaveBeenCalledWith('Lisbon');
  });

  it('never types when the field could not be focused or located', async () => {
    const { ctx, p } = ctxWith('win32', () => ({ success: false, data: { error: 'not found' } }), []);
    const r = await tool.handler({ name: 'Nope', value: 'secret', processId: 42 }, ctx);
    expect(r.isError).toBe(true);
    expect(p.typeText).not.toHaveBeenCalled();
    expect(p.keyPress).not.toHaveBeenCalled();
  });
});
