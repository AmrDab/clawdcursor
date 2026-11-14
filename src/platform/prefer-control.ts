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
import { missText, untrusted } from '../core/miss-text';
import { quoteScreenText } from '../core/untrusted-screen-content';

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

/** `: <reason>` from an adapter's failed result (`error` or `data.error`), or '' when it gave none. */
export function failReason(res: { error?: unknown; data?: Record<string, unknown> }): string {
  // A bridge reply with a reason is told in our words (the app's detail inside an untrusted block); one without is shown
  // inside an untrusted block, so nothing the screen or the app said can pass for clawdcursor's own words.
  if (typeof res.data?.reason === 'string') return `: ${missText(res.data)}`;
  const e = res.error ?? res.data?.error;
  return typeof e === 'string' && e.trim() ? `: ${untrusted(e.trim().replace(/[.\s]+$/, ''))}` : '';
}

/** A list box or a dropdown list: where typing an option's text moves the selection to it. Not a tab strip, a radio group or a menu: there a letter is a shortcut. */
export const typeAheadSelects = (r?: string) => /^(list|listbox|combobox|popupbutton)$/.test(role(r));
/** An item of such a list. */
export const isListItem = (r?: string) => /^(listitem|option)$/.test(role(r));
/** A text box: what an editable combo box holds. */
export const isTextBox = (r?: string) => /^(edit|textfield|textbox|entry|searchfield)$/.test(role(r));
export const isSelectableItem = (r?: string) => SELECTABLE.test(role(r));

const WANTED: Record<ByNameAction, RegExp[]> = {
  focus: [EDITABLE, FOCUSABLE],
  'set-value': [EDITABLE, FOCUSABLE],
  // WinUI toggle switches report as UIA Button, GTK toggle buttons map to Button: only when nothing better matches.
  toggle: [TOGGLES, /^button$/],
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

type Placed = { name?: string; bounds?: { x: number; y: number; width: number; height: number } } | null | undefined;
/** Is the focused element `target` itself: in the same place, or of the same name and overlapping it? */
export function sameElement(focused: Placed, target: Placed): boolean {
  const a = focused?.bounds, b = target?.bounds;
  if (!a || !b) return false;
  const near = (p: number, q: number) => Math.abs(p - q) <= 8;
  if (near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height)) return true;
  const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  return overlap && !!focused?.name?.trim() && norm(focused.name) === norm(target?.name);
}

type Box = { x: number; y: number; width: number; height: number };
/** Is box `f` inside box `b`? */
export const inside = (f: Box, b: Box): boolean =>
  f.x >= b.x && f.y >= b.y && f.x + f.width <= b.x + b.width && f.y + f.height <= b.y + b.height;

/**
 * Before keys go to process `pid`'s control: bring its window to the front. False only when a real read still shows
 * another app in front. A Store app's window is its frame's (ApplicationFrameHost): the app is the process it hosts.
 * A read that fails or only guesses (Linux without xdotool, Wayland) cannot tell: the caller's focus check after its
 * click or focus call is the guard there.
 */
export async function ensureInFront(platform: Pick<PlatformAdapter, 'getActiveWindow' | 'focusWindow'>, pid: number): Promise<boolean> {
  const front = async () => {
    const w = await platform.getActiveWindow().catch(() => null);
    return !w || w.guessed ? undefined : w.processId === pid || w.hostedProcessId === pid;
  };
  if (await front()) return true;
  await platform.focusWindow({ processId: pid }).catch(() => false);
  await new Promise(r => setTimeout(r, 150));
  return (await front()) !== false;
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
  return `${quoteScreenText(q.name)} is not a list item or tab to select (it is a ${[...new Set(named.map(h => h.controlType))].join(', ')}); to pick an option inside a dropdown, pass value`;
}
