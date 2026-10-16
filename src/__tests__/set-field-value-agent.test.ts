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

  // Mac review of 4ee6279: a refusal is not "no settable value" — the widest-Edit-field heuristic must not route around it.
  it('a REFUSAL is final: no field is guessed, nothing is clicked or typed, and the reason reaches the agent', async () => {
    const reason = 'role="AXTextField" matches 2 elements — "nameField", "secretField" — add a name or id to pick one';
    const { ctx, p } = ctxWith('darwin', false, [
      { name: 'nameField', controlType: 'Edit', bounds: { x: 0, y: 0, width: 300, height: 20 } },
      { name: 'secretField', controlType: 'Edit', bounds: { x: 0, y: 40, width: 100, height: 20 } },
    ]);
    p.invokeElement = vi.fn(async () => ({ success: false, data: { refused: true, error: reason } })) as any;
    const r = await tool.execute({ controlType: 'Edit', value: 'typed by mistake' }, ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('matches 2 elements');
    expect(p.findElements).not.toHaveBeenCalled();
    expect(p.mouseClick).not.toHaveBeenCalled();
    expect(p.keyPress).not.toHaveBeenCalled();
    expect(p.typeText).not.toHaveBeenCalled();
  });

  it('a settable value is set directly, with no typing', async () => {
    const { ctx, p } = ctxWith('win32', true, []);
    const r = await tool.execute({ name: 'File name', value: 'a.txt' }, ctx);
    expect(r.success).toBe(true);
    expect(p.typeText).not.toHaveBeenCalled();
  });
});

describe('agent-loop a11y_get_value', () => {
  const getTool = buildUnifiedTools().find(t => t.name === 'a11y_get_value')!;

  it('reads the field, not the same-named label (live Linux Chrome: "City" = "City")', async () => {
    const invoke = vi.fn(async (q: any) => ({ success: true, data: { value: q.controlType === 'Edit' ? 'Porto' : 'City' } }));
    const ctx = { platform: {
      platform: 'linux',
      invokeElement: invoke,
      findElements: vi.fn(async () => [
        { name: 'City', controlType: 'Text', bounds: { x: 1, y: 1, width: 30, height: 10 } },
        { name: 'City', controlType: 'Edit', bounds: { x: 40, y: 1, width: 200, height: 20 } },
      ]),
      getActiveWindow: vi.fn(async () => null),
    } } as any;
    const r = await getTool.execute({ name: 'City', processId: 7 }, ctx);
    expect(r.text).toContain('"City" = "Porto"');
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ controlType: 'Edit', action: 'get-value' }));
  });

  it('an explicit controlType is respected as given', async () => {
    const invoke = vi.fn(async () => ({ success: true, data: { value: 'x' } }));
    const find = vi.fn(async () => []);
    const ctx = { platform: { platform: 'win32', invokeElement: invoke, findElements: find, getActiveWindow: vi.fn(async () => null) } } as any;
    await getTool.execute({ name: 'File name', controlType: 'ComboBox', processId: 7 }, ctx);
    expect(find).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ controlType: 'ComboBox' }));
  });
});
