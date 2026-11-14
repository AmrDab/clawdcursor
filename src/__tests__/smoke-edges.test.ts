/**
 * Live Windows smoke test of 1.5.27, three rough edges:
 *   1. a toggle / select that read its result back was still tagged [unverified];
 *   2. by-name focus / set / toggle took a form's label ("Your name", Text) instead of its control (Edit);
 *   3. "Could not focus/select" dropped the platform's reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { classifyResult } from '../core/result-codes';
import { preferControl } from '../platform/prefer-control';

const agentTool = (n: string) => buildUnifiedTools().find(t => t.name === n)!;
const label = { name: 'Your name', controlType: 'Text', bounds: { x: 0, y: 0, width: 50, height: 16 } };
const edit = { name: 'Your name', controlType: 'Edit', bounds: { x: 60, y: 0, width: 200, height: 22 } };

function plat(found: any[], inv: (q: any) => any = () => ({ success: true })) {
  return {
    platform: 'win32',
    invokeElement: vi.fn(async (q: any) => inv(q)),
    findElements: vi.fn(async () => found),
    getActiveWindow: vi.fn(async () => null),
  };
}

describe('1. a read-back toggle / select is confirmed', () => {
  it('toggle carries the marker, and the classifier accepts it', async () => {
    const p = plat([], () => ({ success: true, data: { toggleState: 'On', toggleChanged: true } }));
    const b = await agentTool('a11y_toggle').execute({ name: 'Accept', processId: 1 }, { platform: p } as any);
    expect(b.text).toBe('Toggled (read back ✓) "Accept" → On.');
    expect(classifyResult(b.text, false, true)).toEqual({ outcome: 'confirmed' });
    expect(classifyResult('Selected (read back ✓) "Green" in "Favorite color".', false, true)).toEqual({ outcome: 'confirmed' });
  });

  it('an unconfirmed toggle stays unverified', async () => {
    const p = plat([], () => ({ success: true, data: { toggleState: 'On', toggleChanged: false } }));
    const b = await agentTool('a11y_toggle').execute({ name: 'Accept', processId: 1 }, { platform: p } as any);
    expect(b.text).toMatch(/not confirmed/);
    expect(classifyResult(b.text, false, true)).toEqual({ outcome: 'unverified' });
  });

  it('screen text can not pose as the marker', () => {
    expect(classifyResult('Toggled "Toggled (read back ✓) x" → On.', false, true)).toEqual({ outcome: 'unverified' });
    expect(classifyResult('Selected "Selected (read back ✓) "', false, true)).toEqual({ outcome: 'unverified' });
  });
});

describe('2. by-name actions prefer the control over its label', () => {
  it('focus_element sends the Edit when a Text label shares the name', async () => {
    const p = plat([label, edit]);
    await agentTool('focus_element').execute({ name: 'Your name' }, { platform: p } as any);
    expect(p.invokeElement).toHaveBeenCalledWith(expect.objectContaining({ action: 'focus', controlType: 'Edit' }));
  });

  it('set_field_value and toggle too (agent-loop)', async () => {
    const p = plat([label, edit, { name: 'Your name', controlType: 'CheckBox' }]);
    await agentTool('set_field_value').execute({ name: 'Your name', value: 'x' }, { platform: p } as any);
    expect(p.invokeElement).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-value', controlType: 'Edit' }));
    await agentTool('a11y_toggle').execute({ name: 'Your name' }, { platform: p } as any);
    expect(p.invokeElement).toHaveBeenCalledWith(expect.objectContaining({ action: 'toggle', controlType: 'CheckBox' }));
  });

  it('is unchanged for a single match, a given controlType, or no suitable role; spellings per OS', async () => {
    expect(await preferControl(plat([edit]), 'focus', { name: 'Your name' })).toBeUndefined();
    expect(await preferControl(plat([label, edit]), 'focus', { name: 'Your name', controlType: 'Text' })).toBe('Text');
    expect(await preferControl(plat([label, { ...label, controlType: 'Image' }]), 'focus', { name: 'Your name' })).toBeUndefined();
    const ax = [{ name: 'N', controlType: 'AXStaticText' }, { name: 'N', controlType: 'AXTextField' }];
    expect(await preferControl(plat(ax), 'focus', { name: 'N' })).toBe('AXTextField');
    const sw = [{ name: 'N', controlType: 'Text' }, { name: 'N', controlType: 'AXSwitch' }];
    expect(await preferControl(plat(sw), 'toggle', { name: 'N' })).toBe('AXSwitch');
  });
});

describe('3. failures keep the platform reason', () => {
  it('Could not focus / select carry the reason, so the classifier sees NOT_FOUND', async () => {
    const p = plat([], () => ({ success: false, data: { reason: 'not_found', error: 'Element not found' } }));
    const f = await agentTool('focus_element').execute({ name: 'Nope' }, { platform: p } as any);
    expect(f.text).toBe('Could not focus "Nope": Element not found.');
    expect(classifyResult(f.text, true, true)?.code).toBe('NOT_FOUND');
    const s = await agentTool('a11y_select').execute({ name: 'Nope' }, { platform: p } as any);
    expect(s.text).toBe('Could not select "Nope": Element not found.');
  });

  it('select without value on a non-item says what is wrong', async () => {
    const p = plat([label, edit], () => ({ success: false }));
    const s = await agentTool('a11y_select').execute({ name: 'Your name' }, { platform: p } as any);
    expect(s.text).toMatch(/"Your name" is not a list item or tab to select.*pass value/);
  });
});

describe('follow-ups', () => {
  it('toggle falls back to a Button (WinUI / GTK) only when no checkbox, radio or switch matches', async () => {
    const t = { name: 'Wi-Fi', controlType: 'Text' };
    expect(await preferControl(plat([t, { name: 'Wi-Fi', controlType: 'Button' }]), 'toggle', { name: 'Wi-Fi' })).toBe('Button');
    expect(await preferControl(plat([t, { name: 'Wi-Fi', controlType: 'Button' }, { name: 'Wi-Fi', controlType: 'CheckBox' }]), 'toggle', { name: 'Wi-Fi' })).toBe('CheckBox');
    expect(await preferControl(plat([t, { name: 'Wi-Fi', controlType: 'Image' }]), 'toggle', { name: 'Wi-Fi' })).toBeUndefined();
  });
});
