/**
 * One state rule on every OS: a tickbox's state is UiElement.checked (true / false / 'mixed'), a radio's tick is
 * `checked` too, and an expandable control says `expanded`.
 *
 * Audit 2026-11-05: Linux read only SELECTED (a ticked Chrome checkbox came back selected:false, no `checked`); Windows
 * put the tick only on `find` results, never on the tree or the focused element, and a radio (SelectionItem) never had
 * one; macOS never set `checked` at all. The bridges now report the raw states (atspi-bridge.py checked_state,
 * ps-bridge.ps1 Add-StateFields, the AXValue the mac helper already sends); this pins how each adapter maps them.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {}, Button: {}, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: vi.fn(), start: vi.fn(), stop: vi.fn() } }));

import { WindowsAdapter } from '../platform/windows';
import { LinuxAdapter } from '../platform/linux';
import { toUiElement } from '../platform/mac-ax';

const win = (raw: object) => (new WindowsAdapter() as any).normalizeElement(raw);
const lin = (raw: object) => (new LinuxAdapter() as any).normalizeAtspiElement(raw);
const mac = (raw: object) => toUiElement(raw);

// [case, Windows bridge node, Linux bridge node, macOS helper node, expected checked]
const CASES: Array<[string, object, object, object, boolean | 'mixed' | undefined]> = [
  ['ticked checkbox', { controlType: 'ControlType.CheckBox', toggleState: 'On' },
    { controlType: 'check box', checked: true }, { role: 'AXCheckBox', value: '1' }, true],
  ['clear checkbox', { controlType: 'ControlType.CheckBox', toggleState: 'Off' },
    { controlType: 'check box', checked: false }, { role: 'AXCheckBox', value: '0' }, false],
  ['mixed checkbox', { controlType: 'ControlType.CheckBox', toggleState: 'Indeterminate' },
    { controlType: 'check box', checked: 'mixed' }, { role: 'AXCheckBox', value: '2' }, 'mixed'],
  ['chosen radio', { controlType: 'ControlType.RadioButton', selected: true },
    { controlType: 'radio button', checked: true }, { role: 'AXRadioButton', value: '1' }, true],
  ['slider at 1 is not a tick', { controlType: 'ControlType.Slider', value: '1' },
    { controlType: 'slider', value: '1' }, { role: 'AXSlider', value: '1' }, undefined],
];

describe('UiElement.checked means the same on Windows, Linux and macOS', () => {
  it.each(CASES)('%s', (_name, w, l, m, want) => {
    expect(win(w).checked).toBe(want);
    expect(lin(l).checked).toBe(want);
    expect(mac(m).checked).toBe(want);
  });

  it('an expandable control says whether it is open, on all three', () => {
    expect(win({ controlType: 'ControlType.ComboBox', expandable: true, expanded: false })).toMatchObject({ expandable: true, expanded: false });
    expect(lin({ controlType: 'combo box', expandable: true, expanded: true })).toMatchObject({ expandable: true, expanded: true });
    expect(mac({ role: 'AXPopUpButton', expandable: true, expanded: false })).toMatchObject({ expandable: true, expanded: false });
  });
});
