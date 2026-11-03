/**
 * Shared resolve + gate + dispatch-plan for el_NN element refs on
 * invoke_element / set_field_value. Pure (no platform calls) — the caller
 * passes the live active window so this stays unit-testable. See the Part 2
 * spec section 5.
 */
import type { UIElement, Bounds } from './ui-map-types';
import type { UIMapHolder } from './ui-map-holder';

/** Below this, an el_NN ref is too uncertain to act on. */
export const REF_MIN_CONFIDENCE = 0.5;

export type RefIntent = 'click' | 'fill';
interface ActiveWindow { processId: number; processName: string; title: string; bounds: { x: number; y: number; width: number; height: number }; }

export type RefPlan =
  | { ok: true; via: 'name'; name: string; element: UIElement }
  // `offView`: the element is in the map's window but not fully inside the active window's rect — scrolled out of view (below
  // the fold of a page, past the end of a list). The caller scrolls it in (ensureVisible) before acting on `bounds`.
  | { ok: true; via: 'bounds'; bounds: Bounds; element: UIElement; offView?: true }
  | { ok: false; error: string };

function boundsInside(b: Bounds, w: ActiveWindow['bounds']): boolean {
  const [x, y, bw, bh] = b;
  return x >= w.x && y >= w.y && x + bw <= w.x + w.width && y + bh <= w.y + w.height;
}

export function resolveRef(
  ref: { element_id?: string; snapshot_id?: string },
  holder: UIMapHolder | undefined,
  now: number,
  intent: RefIntent,
  activeWindow: ActiveWindow | null,
): RefPlan {
  const hasId = typeof ref.element_id === 'string' && ref.element_id !== '';
  const hasSnap = typeof ref.snapshot_id === 'string' && ref.snapshot_id !== '';
  if (hasId !== hasSnap) return { ok: false, error: 'provide element_id and snapshot_id together, or neither (use name)' };
  if (!holder) return { ok: false, error: 'no UIMap holder on this context' };

  const r = holder.resolve(ref.snapshot_id as string, now);
  if (!r.ok) {
    const msg = r.reason === 'unknown' ? `unknown snapshot ${ref.snapshot_id} — call compile_ui first`
      : r.reason === 'expired' ? 'snapshot expired — call compile_ui again'
      : 'stale snapshot — the screen changed; call compile_ui again';
    return { ok: false, error: msg };
  }
  const map = r.map;
  const element = map.elements.find(e => e.id === ref.element_id);
  if (!element) return { ok: false, error: `element ${ref.element_id} not in snapshot ${ref.snapshot_id}` };

  if (element.confidence < REF_MIN_CONFIDENCE) return { ok: false, error: `element ${element.id} confidence too low to act on — recompile / re-find` };
  if (intent === 'click' && (!element.actionable || element.state?.enabled === false)) return { ok: false, error: `element ${element.id} is not actionable (disabled?)` };
  if (intent === 'fill' && !element.editable) return { ok: false, error: `element ${element.id} is not editable` };

  // The map's window must STILL be the active window — for BOTH dispatch paths
  // (a unique name is no safer than bounds if the window changed under us).
  if (!activeWindow) return { ok: false, error: 'cannot verify active window — call compile_ui again' };
  // A zero/empty pid means the adapter couldn't read it (macOS unixId read can
  // fail → normalizeWindow defaults to 0; Windows shares the `?? 0` pattern), so
  // treat it as UNKNOWN and fall back to the title instead of comparing against a
  // bogus 0 — which would spuriously reject (or, if both sides are 0, falsely
  // accept) (audit 2026-06-11, M6).
  const pidKnown = map.process_id !== undefined && map.process_id !== '' && map.process_id !== '0';
  const sameWin = pidKnown
    ? String(activeWindow.processId) === map.process_id   // pid is authoritative when known
    : activeWindow.title === map.window_title;            // fall back to title only when pid unknown
  if (!sameWin) return { ok: false, error: 'window changed since compile — call compile_ui again' };

  // Prefer the reliable a11y path when the name is unique; else disambiguate by bounds.
  const name = element.normalized_text ?? '';
  const uniqueName = name !== '' && map.elements.filter(e => e.normalized_text === name).length === 1;
  if (uniqueName) return { ok: true, via: 'name', name, element };

  // The window check above passed, so the element belongs to this window's tree. Bounds outside the window's rect then mean
  // "scrolled out of view", not "in another window" (a real run: a form field below the fold was refused as "off the
  // active window"). Hand it back flagged; ensureVisible scrolls it in and refuses only if that fails.
  if (!boundsInside(element.bounds, activeWindow.bounds)) return { ok: true, via: 'bounds', bounds: element.bounds, element, offView: true };
  return { ok: true, via: 'bounds', bounds: element.bounds, element };
}
