/**
 * The agent-loop set_field_value — the one MCP's `accessibility set_value`
 * routes to. Live checks 2026-10-15:
 *   - Linux Chrome field: no settable value → it must type into the INPUT,
 *     not the same-named label, and never into whatever has focus;
 *   - Windows Save-As via element_id: typed after the old text ("oldnew").
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';

const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;

function ctxWith(platform: string, setOk: boolean, found: any[]) {
  const p = {
    platform,
    invokeElement: vi.fn(async () => setOk ? { success: true } : { success: false, data: { error: 'element exposes neither EditableText nor Value' } }),
    findElements: vi.fn(async () => found),
    // After the click the focus is on the input (checked before any key is sent, #363).
    getFocusedElement: vi.fn(async () => found.find(e => e.controlType === 'Edit') ?? null),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    getActiveWindow: vi.fn(async () => null),
    focusWindow: vi.fn(async () => true),
    listDisplays: vi.fn(async () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, dpiRatio: 1 }]),
  };
  return { ctx: { platform: p, screen: { physicalWidth: 1920, physicalHeight: 1080 } } as any, p };
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

// #363: the typing fallback's gaps.
describe('agent-loop set_field_value — the keyboard path is guarded and says why it did not type', () => {
  const INPUT = { name: 'City', controlType: 'Edit', bounds: { x: 60, y: 8, width: 200, height: 22 } };

  it('a clear the bridge will not set ("") is select-all + Delete, confirmed on a readable empty read', async () => {
    const { ctx, p } = ctxWith('win32', false, [INPUT]);
    p.getFocusedElement = vi.fn(async () => ({ ...INPUT, value: '', readable: true })) as any;
    const r = await tool.execute({ name: 'City', value: '' }, ctx);
    expect(p.keyPress).toHaveBeenCalledWith('mod+a');
    expect(p.keyPress).toHaveBeenCalledWith('Delete');
    expect(p.typeText).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/^Set \(read back ✓\) "City" = 0 chars/);
  });

  it('the focus did not go to the field after the click: nothing is typed, and the result says so', async () => {
    const { ctx, p } = ctxWith('linux', false, [INPUT]);
    p.getFocusedElement = vi.fn(async () => ({ name: 'Search', controlType: 'Edit', bounds: { x: 0, y: 500, width: 300, height: 22 } })) as any;
    const r = await tool.execute({ name: 'City', value: 'Lisbon' }, ctx);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/keyboard focus did not go to it, so nothing was typed/);
    expect(p.keyPress).not.toHaveBeenCalled();
    expect(p.typeText).not.toHaveBeenCalled();
  });

  it('an unnamed inner Edit of a composite field (Win11 XAML) counts as the field', async () => {
    const { ctx, p } = ctxWith('win32', false, [INPUT]);
    p.getFocusedElement = vi.fn(async () => ({ name: '', controlType: 'Edit', bounds: { x: 64, y: 10, width: 150, height: 18 } })) as any;
    await tool.execute({ name: 'City', value: 'Lisbon' }, ctx);
    expect(p.typeText).toHaveBeenCalledWith('Lisbon');
  });

  it('a Store app is in front when its frame (ApplicationFrameHost) hosts it: the field\'s pid is the hosted one', async () => {
    const { ctx, p } = ctxWith('win32', false, [{ ...INPUT, processId: 6768 }]);
    p.getActiveWindow = vi.fn(async () => ({ processId: 38636, hostedProcessId: 6768 })) as any;
    const r = await tool.execute({ name: 'City', value: 'Lisbon' }, ctx);
    expect(p.focusWindow).not.toHaveBeenCalled();
    expect(p.typeText).toHaveBeenCalledWith('Lisbon');
    expect(r.text).not.toMatch(/would not come to the front/);
  });

  it('a foreground that cannot be read or is only guessed (Linux without xdotool) does not block: the focus check guards', async () => {
    for (const front of [null, { processId: 1, guessed: true }]) {
      const { ctx, p } = ctxWith('linux', false, [INPUT]);
      p.getActiveWindow = vi.fn(async () => front) as any;
      await tool.execute({ name: 'City', value: 'Lisbon', processId: 7 }, ctx);
      expect(p.focusWindow).toHaveBeenCalledWith({ processId: 7 });
      expect(p.typeText).toHaveBeenCalledWith('Lisbon');
    }
  });

  it('a retry that was skipped says why', async () => {
    const { ctx, p } = ctxWith('win32', true, [INPUT]);
    // The direct set "worked" and the field still reads empty: no effect, so it is typed instead — but its window stays behind.
    p.invokeElement = vi.fn(async (q: any) => q.action === 'get-value' ? { success: true, data: { value: '', readable: true } } : { success: true }) as any;
    p.getActiveWindow = vi.fn(async () => ({ processId: 9 })) as any;
    const r = await tool.execute({ name: 'City', value: 'Lisbon', processId: 7 }, ctx);
    expect(r.success).toBe(false);
    expect(r.text).toContain('It was not typed into the field instead: its window would not come to the front.');
    expect(p.mouseClick).not.toHaveBeenCalled();
  });
});
