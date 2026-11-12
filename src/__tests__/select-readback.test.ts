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

  it('Windows: IsSelected after Select(), and a WinForms list box is told (LBN_SELCHANGE) as a user pick tells it', () => {
    const ps = script('ps-bridge.ps1');
    const fn = ps.slice(ps.indexOf('function Select-Item'), ps.indexOf('# ── Command: invoke-element'));
    expect(fn).toMatch(/\$p\.Select\(\)[\s\S]*IsSelected[\s\S]*SendMessageTimeout\(\$dad, 0x0111/);
    // Only a WinForms list box: UIA's proxy for a plain Win32 "ListBox" (and a combo box) notifies by itself.
    const cls = new RegExp(/-match '([^']+)'/.exec(fn)![1]);
    expect(cls.test('WindowsForms10.LISTBOX.app.0.34f5582_r6_ad1')).toBe(true);
    for (const other of ['ListBox', 'ComboLBox', 'WindowsForms10.COMBOBOX.app.0.34f5582_r6_ad1', 'TListBox', 'WindowsForms10.SysListView32.app.0']) expect(cls.test(other), other).toBe(false);
    // Confined: the real parent (never GetParent, which answers with the OWNER of a popup), a child list box that
    // notifies (LBS_NOTIFY), parent and list box in one process.
    expect(ps).not.toMatch(/GetParent\(IntPtr|::GetParent\(/);
    expect(fn).toMatch(/\$dad = \[Win32UIA\]::GetAncestor\(\$h, 1\)/);
    expect(fn).toMatch(/if \(\$isChild -and \$notifies -and \$listPid -ne 0 -and \$listPid -eq \$dadPid\) \{[\s\S]*SendMessageTimeout/);
    expect(fn.match(/SendMessageTimeout/g)).toHaveLength(1);
    expect(ps).toMatch(/"select" \{\s*try \{\s*\$selected = Select-Item \$element[\s\S]{0,300}selected = \$selected/);
    // No other path selects without it.
    expect(ps.match(/\.Select\(\)/g)).toHaveLength(1);
  });

  it('macOS: AXSelected is read back on a row and on any other element', () => {
    const swift = script('mac', 'ax-helper.swift');
    const sel = swift.slice(swift.indexOf('case "select":'), swift.indexOf('default:', swift.indexOf('case "select":')));
    expect(sel).toMatch(/selectRow\(row, action: action, appName: appName\)/);
    expect(sel).toMatch(/setSelected\(el, action: action, appName: appName\)/);
    const body = (name: string) => { const at = swift.indexOf(`func ${name}(`); return swift.slice(at, swift.indexOf('\n}', at)); };
    expect(body('selectedSoon')).toMatch(/copyAttr\(el, "AXSelected"\)/);
    // A set that changed nothing is followed by ONE press and the same read; what was read is what is reported.
    expect(body('setSelected')).toMatch(/selectedSoon\(el, tries: 10\)[\s\S]*if read == false \{\s*let p = press\(el\)[\s\S]*selectedSoon\(el, tries: 10\)[\s\S]*\["selected": read!\]/);
    expect(body('setSelected').match(/press\(/g)).toHaveLength(1);
    expect(body('selectRow')).toMatch(/selectedSoon\(row, tries: 6\) == true[\s\S]*let p = press\(row\)[\s\S]*selectedSoon\(row, tries: 6\) == true[\s\S]*return miss\(/);
    expect(body('selectRow').match(/press\(/g)).toHaveLength(1);
    // selectRow keeps its own doc comment.
    expect(swift).toMatch(/\/\/\/ Select the row and check that it took[^\n]*\n\/\/\/[^\n]*\n\/\/\/[^\n]*\nfunc selectRow\(/);
  });

  it('Linux: is_child_selected after select_child', () => {
    const py = script('linux', 'atspi-bridge.py');
    const sel = py.slice(py.indexOf("elif action == 'select':"), py.indexOf("elif action in ('expand', 'collapse'):"));
    expect(sel).toMatch(/select_child\(idx\)[\s\S]*is_child_selected\(idx\)[\s\S]*out\["selected"\]/);
  });
});

/** A dropdown the pattern route cannot change: only keys typed while IT has the focus do. */
function stubborn(opts: { focusLands?: boolean; inFront?: boolean; keysWork?: boolean; role?: string; textBox?: boolean } = {}) {
  const { focusLands = true, inFront = true, keysWork = true, role = 'ComboBox', textBox = false } = opts;
  let current = 'Low';
  let focused: { name: string; controlType: string; bounds: { x: number; y: number; width: number; height: number } } | null = null;
  const combo = { name: 'Priority', controlType: role, processId: 7, bounds: { x: 10, y: 10, width: 200, height: 24 } };
  const edit = { name: 'Priority', controlType: 'Edit', processId: 7, bounds: { x: 12, y: 12, width: 170, height: 20 } };
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
    findElements: vi.fn(async (q: { name?: string }) => q.name === 'Priority' ? (textBox ? [combo, edit] : [combo])
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

describe('the keyboard is only for a list box or a dropdown list, where type-ahead selects', () => {
  it.each(['List', 'ComboBox', 'list box', 'combo box', 'AXPopUpButton'])('%s: typed into', async role => {
    const p = stubborn({ role });
    expect((await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 })).success).toBe(true);
    expect(p.sent).toEqual(['High']);
  });

  // A letter is a shortcut there, and a space toggles.
  it.each(['Tab', 'AXTabGroup', 'page tab list', 'AXRadioGroup', 'radiogroup', 'MenuButton'])('%s: an honest failure, and no key is sent', async role => {
    const p = stubborn({ role });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High' }, { settleMs: 0 });
    expect(p.sent).toEqual([]);
    expect(p.invokeElement.mock.calls.some(c => c[0].action === 'focus')).toBe(false);
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toBe('Tried to select "High" in "Priority", but it now shows "Low".');
  });

  it('an editable combo box (a text box inside it) is not typed into: the letters would be its text', async () => {
    const p = stubborn({ textBox: true });
    const r = await selectOption(p as any, { name: 'Priority', value: 'High', controlType: 'ComboBox' }, { settleMs: 0 });
    expect(p.sent).toEqual([]);
    expect(r.success).toBe(false);
  });
});

describe('the control must show EXACTLY the option (not the lenient rule of a typed value)', () => {
  const shows = (shown: string) => ({
    invokeElement: vi.fn(async (q: { action?: string }) => q.action === 'get-value' ? { success: true, data: { value: shown } } : { success: true }),
    findElements: vi.fn(async (q: { name?: string }) => [{ name: q.name, controlType: q.name === 'Size' ? 'ComboBox' : 'ListItem' }]),
  });

  it('case and outer whitespace do not matter', async () => {
    const r = await selectOption(shows('  EXTRA large ') as any, { name: 'Size', value: 'Extra large' }, { settleMs: 0 });
    expect(r).toMatchObject({ success: true, verified: true });
  });

  it.each(['10 GB', '10%', '10.0', '$10', '10,0', '100', 'Extra  large'])('"10" (or "Extra large") is not confirmed by %s', async shown => {
    const want = shown.startsWith('Extra') ? 'Extra large' : '10';
    const r = await selectOption(shows(shown) as any, { name: 'Size', value: want }, { settleMs: 0 });
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toContain(`now shows "${shown}"`);
  });
});
