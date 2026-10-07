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
 *   5. read the control back and report whether it now shows `value`.
 */
import type { PlatformAdapter } from './types';

export interface SelectOptionResult {
  success: boolean;
  /** true when the final value was read back from the control */
  verified: boolean;
  text: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function selectOption(
  platform: Pick<PlatformAdapter, 'invokeElement' | 'findElements'>,
  q: { name: string; value: string; controlType?: string; processId?: number },
): Promise<SelectOptionResult> {
  const { name, value, controlType, processId } = q;
  const readValue = async (): Promise<string | null> => {
    const r = await platform.invokeElement({ name, controlType, processId, action: 'get-value' }).catch(() => null);
    if (!r?.success) return null;
    const v = String(r.data?.value ?? '');
    // A control that only echoes its own name has no readable selection.
    return norm(v) === norm(name) ? null : v;
  };

  const before = await readValue();
  if (before !== null && norm(before) === norm(value)) {
    return { success: true, verified: true, text: `"${name}" already shows "${value}".` };
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
  if (after !== null) {
    const ok = norm(after) === norm(value);
    if (!ok && expanded?.success) await platform.invokeElement({ name, controlType, processId, action: 'collapse' }).catch(() => null);
    return {
      success: ok,
      verified: true,
      text: ok ? `Selected "${value}" in "${name}" (verified).` : `Tried to select "${value}" in "${name}", but it now shows "${after}".`,
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
