/**
 * Choose an option inside a named dropdown / list / tab strip:
 * `select name:"Plan" value:"Pro"`.
 *
 * OS-agnostic — built only from PlatformAdapter primitives:
 *   1. read the control's value; done if it already matches,
 *   2. expand it (options of macOS pop-ups and many web selects only exist
 *      while open),
 *   3. require an option whose name EXACTLY matches `value` — bridge name
 *      matching is fuzzy, and "Pro" must never click a "Profile" button,
 *   4. select it (SelectionItem / AT-SPI Selection), else press it,
 *   5. read the control back and report whether it now shows `value`. A pick is applied a moment AFTER the press returns (a menu
 *      that is still closing, a page script), so a control that still shows the old value is re-read for `settleMs` before the
 *      pick is called a failure (macOS WebKit: "Tried to select Green, but it now shows Red" while the page already showed Green).
 *   6. still the old value: ONE try through the keyboard (pickByKeys), then the same read-back.
 *
 * A plain `select name:"High"` (the item itself, no value) ends in selectedResult: the item's own state, read by the bridge.
 */
import type { PlatformAdapter } from './types';
import { findControls, typeAheadSelects, isListItem, isTextBox, sameElement, inside, ensureInFront } from './prefer-control';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { sleep } from '../sleep';

export interface SelectOptionResult {
  success: boolean;
  /** true when the final value was read back from the control */
  verified: boolean;
  text: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
/**
 * Does the control show the option? EXACTLY it: case and outer whitespace aside, nothing is forgiven. Not the rule a typed
 * value is read back with (holdsValue): "10 GB", "10%", "10.0" and "$10" are other options than "10".
 */
const showsValue = (shown: string, want: string): boolean => norm(shown) === norm(want);

/** Re-read until the control shows `want` or `ms` is up. Returns the last value it could read (null: it never could). */
async function readUntil(read: () => Promise<string | null>, want: string, ms: number): Promise<string | null> {
  let last: string | null = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(150);
    const v = await read();
    if (v !== null) last = v;
    if (v !== null && showsValue(v, want)) return v;
  }
  return last;
}

/**
 * How a plain `select` on an item ends. The bridges read the item's selected state back after the act (`data.selected`):
 * selected is confirmed, not selected is a failure, and a state that cannot be read is a success said to be NOT verified.
 */
export function selectedResult(res: { success: boolean; data?: Record<string, unknown> }, name: string): SelectOptionResult {
  const selected = res.data?.selected;
  if (selected === true) return { success: true, verified: true, text: `Selected (read back ✓) ${quoteScreenText(name)}.` };
  if (selected === false) return { success: false, verified: true, text: `Select ${quoteScreenText(name)} failed: it still reads as not selected.` };
  return { success: true, verified: false, text: `Selected ${quoteScreenText(name)} — its selected state could not be read back: NOT verified. Read it to check.` };
}

/**
 * How a select whose control the caller reads itself ends (a browser <select> over CDP, #399): `shown` is the chosen
 * option's text and `option` its value; either one EXACTLY as asked confirms it. null: it could not be read.
 */
export function shownResult(shown: { value?: string; option?: string } | null | undefined, value: string, name: string): SelectOptionResult {
  if (typeof shown?.value !== 'string') {
    return { success: true, verified: false, text: `Selected ${quoteScreenText(value)} in ${quoteScreenText(name)} — the selection could not be read back: NOT verified. Read it to check.` };
  }
  if (showsValue(shown.value, value) || (shown.option !== undefined && showsValue(shown.option, value))) {
    return { success: true, verified: true, text: `Selected (read back ✓) ${quoteScreenText(value)} in ${quoteScreenText(name)}.` };
  }
  return { success: false, verified: true, text: `Tried to select ${quoteScreenText(value)} in ${quoteScreenText(name)}, but it now shows ${quoteScreenText(shown.value)}.` };
}

type KeysPlatform = Pick<PlatformAdapter, 'invokeElement' | 'findElements'>
  & Partial<Pick<PlatformAdapter, 'getActiveWindow' | 'focusWindow' | 'getFocusedElement' | 'typeText'>>;

/**
 * The second try, after a pattern route the control ignored: give the control the keyboard focus and type the option's
 * text — a list box or a closed dropdown list moves to the item that starts with what is typed. The keys go through the
 * platform's guarded input, like all input.
 *
 * Only where type-ahead selects: a list box or a dropdown list (typeAheadSelects). In a tab strip, a radio group or a
 * menu a letter is a shortcut and a space toggles, and an editable combo box (one with a text box inside it) takes the
 * letters as text: none of those is typed into.
 *
 * Keys go to whatever has the focus, so (as when a field is typed into): the control's window must be in front, and after
 * the focus call the keyboard focus must be on the control itself or on one of its list items. No Return is sent: on a
 * list or a closed dropdown it presses the dialog's default button.
 * 'skipped': nothing was done. 'unfocused': the focus is not on the control; nothing was typed.
 */
async function pickByKeys(
  platform: KeysPlatform, control: { name: string; controlType?: string; processId?: number }, value: string,
): Promise<'typed' | 'skipped' | 'unfocused'> {
  const { getActiveWindow, focusWindow, getFocusedElement, typeText } = platform;
  if (!getActiveWindow || !focusWindow || !getFocusedElement || !typeText) return 'skipped';
  const named = (await platform.findElements({ name: control.name, processId: control.processId }).catch(() => []))
    .filter(h => norm(h.name) === norm(control.name) && h.bounds);
  const el = named.find(h => typeAheadSelects(h.controlType) && (!control.controlType || norm(h.controlType) === norm(control.controlType)));
  if (!el || named.some(h => isTextBox(h.controlType) && inside(h.bounds, el.bounds))) return 'skipped';
  const pid = control.processId ?? el.processId;
  if (pid === undefined) return 'skipped';
  if (!await ensureInFront({ getActiveWindow: getActiveWindow.bind(platform), focusWindow: focusWindow.bind(platform) }, pid)) return 'skipped';
  const focus = await platform.invokeElement({ ...control, action: 'focus' }).catch(() => null);
  if (!focus?.success) return 'unfocused';
  await sleep(100);
  const focused = await getFocusedElement.call(platform).catch(() => null);
  const role = focused?.controlType;
  const itemInside = !!focused?.bounds && isListItem(role) && inside(focused.bounds, el.bounds);
  if (!focused || focused.secure || !(itemInside || (typeAheadSelects(role) && sameElement(focused, el)))) return 'unfocused';
  await typeText.call(platform, value);
  return 'typed';
}

export async function selectOption(
  platform: KeysPlatform,
  q: { name: string; value: string; controlType?: string; processId?: number },
  opts: { settleMs?: number } = {},
): Promise<SelectOptionResult> {
  const { name, value, processId } = q;
  const settleMs = opts.settleMs ?? 1500;
  let controlType = q.controlType;
  // Without a role the bridge takes the first element with that name, and a form's label ("Favorite color") is found before
  // its combo box. Aim at the one that can hold options; if only labels or the like have the name, say so.
  if (!controlType) {
    const { controlType: held, named } = await findControls(platform, 'select', { name, processId });
    if (named.length) {
      if (!held) {
        const roles = [...new Set(named.map(h => h.controlType))].join(', ');
        return { success: false, verified: false, text: `No dropdown or list named ${quoteScreenText(name)}; only ${roles} matched (a label or another element, not something with options). Nothing was changed.` };
      }
      controlType = held;
    }
  }
  const readValue = async (): Promise<string | null> => {
    const r = await platform.invokeElement({ name, controlType, processId, action: 'get-value' }).catch(() => null);
    if (!r?.success) return null;
    const v = String(r.data?.value ?? '');
    // A control that only echoes its own name has no readable selection.
    return norm(v) === norm(name) ? null : v;
  };

  const before = await readValue();
  if (before !== null && showsValue(before, value)) {
    return { success: true, verified: true, text: `Selected (read back ✓) ${quoteScreenText(value)} in ${quoteScreenText(name)} (it already showed that).` };
  }

  const expanded = await platform.invokeElement({ name, controlType, processId, action: 'expand' }).catch(() => null);
  // `acted`: the press was sent and no list was seen to open. One may be open anyway (a menu the platform cannot see), so what
  // follows cleans up as if it had worked.
  const opened = expanded?.success === true || expanded?.data?.acted === true;
  if (opened) await sleep(300);

  const hits = await platform.findElements({ name: value, processId }).catch(() => []);
  const option = hits.find(h => norm(h.name) === norm(value) && norm(h.name) !== norm(name));
  if (!option) {
    if (opened) await platform.invokeElement({ name, controlType, processId, action: 'collapse' }).catch(() => null);
    const near = hits.slice(0, 5).map(h => `${quoteScreenText(h.name)}`).join(', ');
    return { success: false, verified: false, text: `${quoteScreenText(name)} has no option named exactly ${quoteScreenText(value)}${near ? ` (similar: ${near})` : ''}. Nothing was changed.` };
  }

  // The option's own role first (keeps fuzzy name matching off look-alikes);
  // without it if the bridge can't filter on that role. Read back after EACH
  // attempt: on GTK, "select" on a combo's popup item only highlights it and
  // still reports success — "click" is what activates it.
  let picked = false;
  let after: string | null = null;
  outer: for (const role of [option.controlType || undefined, undefined]) {
    for (const action of ['select', 'click'] as const) {
      const r = await platform.invokeElement({ name: option.name, controlType: role, processId, action }).catch(() => null);
      if (!r?.success) continue;
      picked = true;
      await sleep(250);
      after = await readValue();
      if (after === null || showsValue(after, value)) break outer;
    }
    if (!option.controlType) break;
  }
  if (picked && after !== null && !showsValue(after, value) && settleMs > 0) after = (await readUntil(readValue, value, settleMs)) ?? after;
  if (after !== null) {
    let ok = showsValue(after, value);
    if (!ok && opened) await platform.invokeElement({ name, controlType, processId, action: 'collapse' }).catch(() => null);
    const keyed = ok ? 'skipped' : await pickByKeys(platform, { name, controlType, processId }, value);
    if (keyed === 'typed') {
      after = (await readUntil(readValue, value, Math.max(settleMs, 450))) ?? after;
      ok = showsValue(after, value);
    }
    const keys = keyed === 'typed' ? ' Typing it into the control did not change that.'
      : keyed === 'unfocused' ? ' To type it instead, could not focus the control to type into it; nothing was typed.' : '';
    return {
      success: ok,
      verified: true,
      text: ok ? `Selected (read back ✓) ${quoteScreenText(value)} in ${quoteScreenText(name)}${keyed === 'typed' ? ' (via keys after the direct select had no effect)' : ''}.`
        : `Tried to select ${quoteScreenText(value)} in ${quoteScreenText(name)}, but it now shows ${quoteScreenText(after)}.${keys}`,
    };
  }
  return {
    success: picked,
    verified: false,
    text: picked
      ? `Selected ${quoteScreenText(value)} in ${quoteScreenText(name)} (the control exposes no readable value, so this is unverified — check the screen).`
      : `Found option ${quoteScreenText(value)} but could not select or press it.`,
  };
}
