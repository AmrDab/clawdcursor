/**
 * Find an editable field by its label the way `find_field` does (the compiled UI map: a field's own name, or the label
 * beside a nameless one), then make it visible. smart_type's by-name lookup misses a field whose accessibility name is not
 * its label, and one below the fold of a page; this is the lookup find_field uses, with the same scroll-into-view as a ref.
 */
import type { PlatformAdapter } from '../../platform/types';
import { UIMapHolder } from './ui-map-holder';
import { compileUIMap, defaultCompileDeps } from './ui-map';
import { findInputField } from './ui-map-find';
import { resolveRef } from './ui-map-resolve';
import { ensureVisible, untrusted } from './ui-map-visible';

export type FieldLocation = { ok: true; x: number; y: number; id: string } | { ok: false; error: string };

/** The click point of the field `label` names, scrolled into view when it was out of it. Never guesses between fields. */
export async function locateFieldByLabel(
  platform: PlatformAdapter,
  holder: UIMapHolder | undefined,
  label: string,
): Promise<FieldLocation> {
  const maps = holder ?? new UIMapHolder();
  const now = Date.now();
  let map = maps.currentIfCost('ocr_ok', now);
  if (!map) {
    map = await compileUIMap(defaultCompileDeps(platform, now, maps.nextId()), { max_cost: 'ocr_ok' });
    maps.put(map, now, 'ocr_ok');
  }
  const found = findInputField(map.elements, map.snapshot_id, label);
  if (found.status === 'none') return { ok: false, error: `no field named "${label}" in the compiled UI` };
  if (found.status === 'ambiguous') {
    return { ok: false, error: `"${label}" matches several fields (${untrusted(found.candidates.map(c => c.label).join(' | '))}) — name one exactly` };
  }
  const win = await platform.getActiveWindow().catch(() => null);
  // The same gates as an el_NN ref: confidence, editable, and the map's window still the active one.
  const plan = resolveRef({ element_id: found.best.element_id, snapshot_id: map.snapshot_id }, maps, now, 'fill', win);
  if (!plan.ok) return { ok: false, error: plan.error };
  const [x, y, width, height] = plan.element.bounds;
  const vis = await ensureVisible(platform, { name: plan.element.text, role: plan.element.role, bounds: { x, y, width, height } }, win!, maps);
  if (!vis.ok) return vis;
  return { ok: true, x: Math.round(vis.bounds.x + vis.bounds.width / 2), y: Math.round(vis.bounds.y + vis.bounds.height / 2), id: plan.element.id };
}
