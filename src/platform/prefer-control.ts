/**
 * A by-name action with no role must land on the CONTROL, not on its label. A form's "Your name" is both a Text label and
 * the Edit next to it, and the bridges take the first match: the label, which cannot take focus or a value.
 *
 * `preferControl` looks at the elements with exactly that name and, when several share it, returns the role of the one
 * that can take the action. Without a pick (one match, a role already given, nothing suitable) it returns undefined and the
 * caller sends the same call as before. Select keeps its stricter rule: it also looks when ONE element has the name, because
 * a lone label must be reported rather than clicked.
 */
import type { PlatformAdapter } from './types';

export type ByNameAction = 'focus' | 'set-value' | 'toggle' | 'select';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
/** UIA / AX ("AXTextField") / AT-SPI (mapped to UIA names) spellings, compared letters-only without a leading "ax". */
const role = (r?: string) => norm(r).replace(/[^a-z]/g, '').replace(/^ax/, '');

/** Roles that can hold options (a label, an option or a button is not one). */
const HOLDS_OPTIONS = /^(combobox|popupbutton|menubutton|dropdown|select|list|listbox|tab|tabgroup|tablist|pagetablist|radiogroup)$/;
const EDITABLE = /^(edit|document|textfield|textarea|textbox|searchfield|securetextfield|entry|passwordtext|combobox|spinner|spinbutton|slider)$/;
const FOCUSABLE = /^(edit|document|textfield|textarea|textbox|searchfield|securetextfield|entry|passwordtext|combobox|spinner|spinbutton|slider|checkbox|radiobutton|switch|togglebutton|button|splitbutton|popupbutton|menubutton|hyperlink|link|listitem|tabitem|menuitem|treeitem|dataitem)$/;
const TOGGLES = /^(checkbox|radiobutton|switch|togglebutton|checkmenuitem|menuitemcheckbox|menuitemradio|radiomenuitem)$/;
/** Items a plain `select name:"X"` (no value) can pick. */
const SELECTABLE = /^(listitem|tabitem|tab|radiobutton|menuitem|treeitem|dataitem|row|cell|radiomenuitem|option)$/;

export const holdsOptions = (r?: string) => HOLDS_OPTIONS.test(role(r));
export const isSelectableItem = (r?: string) => SELECTABLE.test(role(r));

const WANTED: Record<ByNameAction, RegExp[]> = {
  focus: [EDITABLE, FOCUSABLE],
  'set-value': [EDITABLE, FOCUSABLE],
  toggle: [TOGGLES],
  select: [HOLDS_OPTIONS],
};

export interface NamedControls {
  /** the role to send, when one element was preferred */
  controlType?: string;
  /** the elements that have exactly this name (with a role) */
  named: Array<{ name: string; controlType?: string }>;
}

export async function findControls(
  platform: Pick<PlatformAdapter, 'findElements'>,
  action: ByNameAction,
  q: { name: string; controlType?: string; processId?: number },
): Promise<NamedControls> {
  if (q.controlType || !q.name?.trim() || typeof platform.findElements !== 'function') return { controlType: q.controlType, named: [] };
  const hits = await platform.findElements({ name: q.name, processId: q.processId }).catch(() => []);
  const named = (Array.isArray(hits) ? hits : []).filter(h => norm(h.name) === norm(q.name) && h.controlType);
  if (named.length < (action === 'select' ? 1 : 2)) return { named };
  for (const re of WANTED[action]) {
    const pick = named.find(h => re.test(role(h.controlType)));
    if (pick) return { controlType: pick.controlType, named };
  }
  return { named };
}

/** The role to send for a by-name `action`, or undefined to send it unchanged. */
export async function preferControl(
  platform: Pick<PlatformAdapter, 'findElements'>,
  action: Exclude<ByNameAction, 'select'>,
  q: { name: string; controlType?: string; processId?: number },
): Promise<string | undefined> {
  return (await findControls(platform, action, q)).controlType ?? q.controlType;
}

/**
 * Why a plain `select name:"X"` (no value) failed when X is no item: names the roles that matched and how to pick an
 * option inside a dropdown. undefined when X is a selectable item or nothing by that name was found.
 */
export async function notSelectableReason(
  platform: Pick<PlatformAdapter, 'findElements'>,
  q: { name: string; controlType?: string; processId?: number },
): Promise<string | undefined> {
  const { named } = await findControls(platform, 'select', q);
  if (!named.length || named.some(h => isSelectableItem(h.controlType))) return undefined;
  return `"${q.name}" is not a list item or tab to select (it is a ${[...new Set(named.map(h => h.controlType))].join(', ')}); to pick an option inside a dropdown, pass value`;
}
