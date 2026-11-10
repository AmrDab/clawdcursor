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
 */
import type { PlatformAdapter } from './types';
import { findControls } from './prefer-control';

export interface SelectOptionResult {
  success: boolean;
  /** true when the final value was read back from the control */
  verified: boolean;
  text: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Re-read until the control shows `want` or `ms` is up. Returns the last value it could read (null: it never could). */
async function readUntil(read: () => Promise<string | null>, want: string, ms: number): Promise<string | null> {
  let last: string | null = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(150);
    const v = await read();
    if (v !== null) last = v;
    if (v !== null && norm(v) === norm(want)) return v;
  }
  return last;
}

export async function selectOption(
  platform: Pick<PlatformAdapter, 'invokeElement' | 'findElements'>,
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
        return { success: false, verified: false, text: `No dropdown or list named "${name}"; only ${roles} matched (a label or another element, not something with options). Nothing was changed.` };
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
  if (before !== null && norm(before) === norm(value)) {
    return { success: true, verified: true, text: `Selected (read back ✓) "${value}" in "${name}" (it already showed that).` };
  }

  const expanded = await platform.invokeElement({ name, controlType, processId, action: 'expand' }).catch(() => null);
  if (expanded?.success) await sleep(300);

  const hits = await platform.findElements({ name: value, processId }).catch(() => []);
  const option = hits.find(h => norm(h.name) === norm(value) && norm(h.name) !== norm(name));
  if (!option) {
    if (expanded?.success) await platform.invokeElement({ name, controlType, processId, action: 'collapse' }).catch(() => null);
    const near = hits.slice(0, 5).map(h => `"${h.name}"`).join(', ');
    return { success: false, verified: false, text: `"${name}" has no option named exactly "${value}"${near ? ` (similar: ${near})` : ''}. Nothing was changed.` };
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
      if (after === null || norm(after) === norm(value)) break outer;
    }
    if (!option.controlType) break;
  }
  // Still the old value after the last attempt: give the control time to show the new one before calling this a failure.
  if (picked && after !== null && norm(after) !== norm(value) && settleMs > 0) after = (await readUntil(readValue, value, settleMs)) ?? after;
  if (after !== null) {
    const ok = norm(after) === norm(value);
    if (!ok && expanded?.success) await platform.invokeElement({ name, controlType, processId, action: 'collapse' }).catch(() => null);
    return {
      success: ok,
      verified: true,
      text: ok ? `Selected (read back ✓) "${value}" in "${name}".` : `Tried to select "${value}" in "${name}", but it now shows "${after}".`,
    };
  }
  return {
    success: picked,
    verified: false,
    text: picked
      ? `Selected "${value}" in "${name}" (the control exposes no readable value, so this is unverified — check the screen).`
      : `Found option "${value}" but could not select or press it.`,
  };
}
