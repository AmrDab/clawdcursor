/**
 * The Windows bridge's control-type vocabulary, shared by its two TS clients (WindowsAdapter and AccessibilityBridge):
 * both must normalize the same way, or one of them sends "ControlType.Button" raw and the bridge drops the role filter.
 */

/**
 * UIA control types the PowerShell bridge's $ctMap accepts (ps-bridge.ps1).
 * Keep in sync with that table.
 */
const UIA_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'Button', 'CheckBox', 'ComboBox', 'Custom', 'DataGrid', 'DataItem', 'Document',
  'Edit', 'Group', 'Hyperlink', 'Image', 'List', 'ListItem', 'Menu', 'MenuBar',
  'MenuItem', 'Pane', 'RadioButton', 'ScrollBar', 'Slider', 'Spinner',
  'SplitButton', 'Tab', 'TabItem', 'Text', 'ToolBar', 'Tree', 'TreeItem', 'Window',
]);

/**
 * Normalize a caller-supplied control type to the bridge's vocabulary.
 *
 * The bridge keys $ctMap on BARE names ("CheckBox"), but everything the agent
 * READS is normalized the other way — normalizeElement strips the prefix — and
 * the tool schema's own example says to send the prefixed form
 * ("ControlType.Button"). So the documented input was the one form the bridge
 * could not match: `ContainsKey` failed, no role condition was added, and the
 * search silently ran UNFILTERED. With no role filter the bridge falls back to
 * bidirectional substring name matching, so asking for a CheckBox named
 * "Allow npm publish" could return a Text element named "npm".
 *
 * Spelling is matched case- and space-insensitively: UIA itself reports a role
 * as "ControlType.MenuItem" (ProgrammaticName) AND "menu item"
 * (LocalizedControlType), and agents copy whichever they saw. Only the exact
 * PascalCase bare name used to pass, so `controlType:"menu item"` failed closed
 * on a menu item the unfiltered invoke found (live 2026-10-14).
 *
 * Returns null for a type the bridge cannot honor, so callers can fail closed
 * rather than silently searching without the filter they asked for.
 */
const UIA_CONTROL_TYPE_BY_KEY: ReadonlyMap<string, string> =
  new Map([...UIA_CONTROL_TYPES].map(t => [t.toLowerCase(), t]));
export function normalizeControlType(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;          // no filter requested
  const key = raw.replace(/^ControlType\./i, '').replace(/\s+/g, '').toLowerCase();
  return UIA_CONTROL_TYPE_BY_KEY.get(key) ?? null;  // null = unhonorable
}
