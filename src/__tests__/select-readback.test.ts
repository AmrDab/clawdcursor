/**
 * #396 (benchmark, native-dialog-fill, Windows): `select` on the fixture's Priority list answered ok while the fixture's
 * state stayed `priority: null`, and the agent reported done. Every select path now ends in one read-back:
 *   - an item (`select name:"High"`): the item's own selected state, read by the bridge after the act (`data.selected`);
 *   - an option in a control (`select name:"Priority" value:"High"`): the control's value, and when the pattern route
 *     left the old value, ONE try through the keyboard, into the control itself and nothing else.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { selectOption, selectedResult } from '../platform/select-option';
import { getA11yDepthTools } from '../tools/a11y_depth';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { classifyResult } from '../core/result-codes';
import type { ToolContext } from '../tools/types';

describe('select on an item: the result is what the item reads afterwards', () => {
  it('read back selected: confirmed', () => {
    const r = selectedResult({ success: true, data: { selected: true } }, 'High');
    expect(r).toEqual({ success: true, verified: true, text: 'Selected (read back ✓) "High".' });
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'confirmed' });
  });

  it('cannot be read: a success that is NOT verified', () => {
    const r = selectedResult({ success: true }, 'High');
    expect(r).toMatchObject({ success: true, verified: false });
    expect(r.text).toMatch(/^Selected "High" — .*NOT verified/);
    expect(classifyResult(r.text, false, true)).toEqual({ outcome: 'unverified' });
  });

  it('still not selected: a failure, never "Selected"', () => {
    const r = selectedResult({ success: true, data: { selected: false } }, 'High');
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toBe('Select "High" failed: it still reads as not selected.');
  });

  it.each([[true, /^Selected \(read back ✓\) "High"\.$/, false], [undefined, /NOT verified/, false], [false, /failed: it still reads as not selected/, true]] as const)(
    'both tool sets report it (selected: %s)', async (selected, text, isError) => {
      const platform = {
        invokeElement: vi.fn(async () => ({ success: true, ...(selected === undefined ? {} : { data: { selected } }) })),
        getActiveWindow: vi.fn(async () => null), findElements: vi.fn(async () => []),
      };
      const mcp = await getA11yDepthTools().find(t => t.name === 'a11y_select')!
        .handler({ name: 'High', processId: 1 }, { ensureInitialized: async () => {}, platform } as unknown as ToolContext);
      expect(mcp.text).toMatch(text);
      expect(!!mcp.isError).toBe(isError);
      const agent = await buildUnifiedTools().find(t => t.name === 'a11y_select')!.execute({ name: 'High', processId: 1 }, { platform } as any);
      expect(agent.text).toMatch(text);
      expect(agent.success).toBe(!isError);
    });
});

describe('each bridge reads the item back after a select', () => {
  const script = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', ...p), 'utf8');

  it('Windows: IsSelected after Select(), and a Win32 list box is told (LBN_SELCHANGE) as a user pick tells it', () => {
    const ps = script('ps-bridge.ps1');
    const fn = ps.slice(ps.indexOf('function Select-Item'), ps.indexOf('# ── Command: invoke-element'));
    expect(fn).toMatch(/\$p\.Select\(\)[\s\S]*IsSelected[\s\S]*SendMessageTimeout\(\[Win32UIA\]::GetParent\(\$h\), 0x0111/);
    expect(ps).toMatch(/"select" \{\s*try \{\s*\$selected = Select-Item \$element[\s\S]{0,300}selected = \$selected/);
    // No other path selects without it.
    expect(ps.match(/\.Select\(\)/g)).toHaveLength(1);
  });

  it('macOS: AXSelected is read back on a row and on any other element', () => {
    const swift = script('mac', 'ax-helper.swift');
    const sel = swift.slice(swift.indexOf('case "select":'), swift.indexOf('default:', swift.indexOf('case "select":')));
    expect(sel).toMatch(/selectRow\(row, action: action\)/);
    expect(sel).toMatch(/setSelected\(el, action: action\)/);
    const fn = swift.slice(swift.indexOf('func setSelected'), swift.indexOf('func selectRow'));
    expect(fn).toMatch(/copyAttr\(el, "AXSelected"\)[\s\S]*"selected": true[\s\S]*"selected": false/);
    expect(swift.slice(swift.indexOf('func selectRow'))).toMatch(/"selected": true/);
  });

  it('Linux: is_child_selected after select_child', () => {
    const py = script('linux', 'atspi-bridge.py');
    const sel = py.slice(py.indexOf("elif action == 'select':"), py.indexOf("elif action in ('expand', 'collapse'):"));
    expect(sel).toMatch(/select_child\(idx\)[\s\S]*is_child_selected\(idx\)[\s\S]*out\["selected"\]/);
  });
});

/** A dropdown the pattern route cannot change: only keys typed while IT has the focus do. */
function stubborn(opts: { focusLands?: boolean; inFront?: boolean; keysWork?: boolean } = {}) {
  const { focusLands = true, inFront = true, keysWork = true } = opts;
  let current = 'Low';
  let focused: { name: string; controlType: string; bounds: { x: number; y: number; width: number; height: number } } | null = null;
  const combo = { name: 'Priority', controlType: 'ComboBox', processId: 7, bounds: { x: 10, y: 10, width: 200, height: 24 } };
  const other = { name: 'Notes', controlType: 'Edit', bounds: { x: 10, y: 100, width: 200, height: 80 } };
  const sent: string[] = [];
  return {
    sent,
    value: () => current,
    invokeElement: vi.fn(async (q: { name?: string; action?: string }) => {
      if (q.action === 'get-value') return { success: true, data: { value: current, readable: true } };
      if (q.action === 'focus') { focused = focusLands ? combo : other; return { success: true }; }
      return { success: true };   // expand, collapse, select, click: accepted, and nothing changes
    }),
    findElements: vi.fn(async (q: { name?: string }) => q.name === 'Priority' ? [combo]
      : ['Low', 'High'].filter(n => n === q.name).map(n => ({ name: n, controlType: 'ListItem', bounds: { x: 0, y: 0, width: 1, height: 1 } }))),
    getActiveWindow: vi.fn(async () => ({ processId: inFront ? 7 : 99 })),
    focusWindow: vi.fn(async () => false),
    getFocusedElement: vi.fn(async () => focused),
    typeText: vi.fn(async (t: string) => { sent.push(t); if (keysWork && focused === combo) current = t; }),
    keyPress: vi.fn(async (k: string) => { sent.push(`<${k}>`); }),
  };
}

describe('select an option: the keyboard is tried once when the pattern route left the old value', () => {
  it('types the option into the control, reads it back, and says how', async () => {
    const p = stubborn();
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(r.text).toBe('Selected (read back ✓) "High" in "Priority" (via keys after the direct select had no effect).');
    // The option's text and nothing else: Return on a list or a closed dropdown presses the dialog's default button.
    expect(p.sent).toEqual(['High']);
  });

  it('never types when the focus is on another control', async () => {
    const p = stubborn({ focusLands: false });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(p.sent).toEqual([]);
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toMatch(/^Tried to select "High" in "Priority", but it now shows "Low"\./);
    expect(r.text).toMatch(/could not focus the control to type into it; nothing was typed/);
  });

  it('never types when its window cannot be brought to the front', async () => {
    const p = stubborn({ inFront: false });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(p.sent).toEqual([]);
    expect(p.invokeElement.mock.calls.some(c => c[0].action === 'focus')).toBe(false);
    expect(r.success).toBe(false);
  });

  it('a control that still shows the old value after the keys is a failure that quotes it, once', async () => {
    const p = stubborn({ keysWork: false });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(p.sent).toEqual(['High']);
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toBe('Tried to select "High" in "Priority", but it now shows "Low". Typing it into the control did not change that.');
  });

  it('is not tried when the pattern route worked, or when the control cannot be read', async () => {
    const p = stubborn();
    p.invokeElement.mockImplementation(async (q: { action?: string }) => q.action === 'get-value' ? { success: false } : { success: true });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(r).toMatchObject({ success: true, verified: false });
    expect(p.sent).toEqual([]);
  });
});

describe('the value is compared as every value read-back compares it (holdsValue)', () => {
  const shows = (shown: string) => ({
    invokeElement: vi.fn(async (q: { action?: string }) => q.action === 'get-value' ? { success: true, data: { value: shown } } : { success: true }),
    findElements: vi.fn(async (q: { name?: string }) => [{ name: q.name, controlType: q.name === 'Size' ? 'ComboBox' : 'ListItem' }]),
  });

  it('case and runs of spaces do not matter', async () => {
    const r = await selectOption(shows('  extra   LARGE ') as any, { name: 'Size', value: 'Extra large' }, { settleMs: 0 });
    expect(r).toMatchObject({ success: true, verified: true });
  });

  it('another option that merely starts with it is not it', async () => {
    const r = await selectOption(shows('Extra large (sold out)') as any, { name: 'Size', value: 'Extra large' }, { settleMs: 0 });
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toMatch(/now shows "Extra large \(sold out\)"/);
  });
});
