/**
 * The agent-loop set_field_value — the one MCP's `accessibility set_value`
 * routes to. Live checks 2026-10-15:
 *   - Linux Chrome field: no settable value → it must type into the INPUT,
 *     not the same-named label, and never into whatever has focus;
 *   - Windows Save-As via element_id: typed after the old text ("oldnew").
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';

const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;

function ctxWith(platform: string, setOk: boolean, found: any[]) {
  const p = {
    platform,
    invokeElement: vi.fn(async () => setOk ? { success: true } : { success: false, data: { error: 'element exposes neither EditableText nor Value' } }),
    findElements: vi.fn(async () => found),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    getActiveWindow: vi.fn(async () => null),
  };
  return { ctx: { platform: p } as any, p };
}

describe('agent-loop set_field_value', () => {
  it('no settable value → types into the input (not the same-named label), replacing its text', async () => {
    const { ctx, p } = ctxWith('linux', false, [
      { name: 'City', controlType: 'Text', bounds: { x: 10, y: 10, width: 40, height: 16 } },   // the label
      { name: 'City', controlType: 'Edit', bounds: { x: 60, y: 8, width: 200, height: 22 } },   // the input
    ]);
    const r = await tool.execute({ name: 'City', value: 'Lisbon' }, ctx);
    expect(r.success).toBe(true);
    expect(p.mouseClick).toHaveBeenCalledWith(160, 19);
    expect(p.keyPress).toHaveBeenCalledWith('mod+a');
    expect(p.typeText).toHaveBeenCalledWith('Lisbon');
  });

  it('no editable field to type into → fails and types nothing', async () => {
    const { ctx, p } = ctxWith('linux', false, [
      { name: 'City', controlType: 'Text', bounds: { x: 10, y: 10, width: 40, height: 16 } },
    ]);
    const r = await tool.execute({ name: 'City', value: 'secret' }, ctx);
    expect(r.success).toBe(false);
    expect(p.typeText).not.toHaveBeenCalled();
  });

  it('a settable value is set directly, with no typing', async () => {
    const { ctx, p } = ctxWith('win32', true, []);
    const r = await tool.execute({ name: 'File name', value: 'a.txt' }, ctx);
    expect(r.success).toBe(true);
    expect(p.typeText).not.toHaveBeenCalled();
  });
});
