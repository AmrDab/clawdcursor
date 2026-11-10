/**
 * What a failed by-name action says, built from the bridge's STRUCTURED reply instead of its sentence.
 *
 * A result is classified by its words (result-codes.ts), so a result may contain only clawdcursor's own words outside an
 * <untrusted-screen-content> block. The bridges (ps-bridge.ps1, ax-helper.swift, atspi-bridge.py) therefore answer a miss with
 * a machine-readable `reason` plus separate fields for anything the screen or the app controls: `detail` (an exception
 * message), `otherWindows` (a count). Their `error` sentence is for old callers and is never shown or classified when a
 * reason is present. A window title, an element name or an app's exception text cannot steer the code, whatever characters
 * it contains.
 */

export type MissReason = 'not_found' | 'unsupported' | 'invoke_threw' | 'disabled' | 'timeout' | 'no_window' | 'hidden' | 'failed';
const REASONS: ReadonlySet<string> = new Set<MissReason>(['not_found', 'unsupported', 'invoke_threw', 'disabled', 'timeout', 'no_window', 'hidden', 'failed']);

/** Same escaping as wrapUntrustedScreenContent (agent-loop/prompt.ts): the content cannot close the block. */
export function untrusted(text: string): string {
  const safe = text.replace(/<(\/?)\s*untrusted-screen-content\s*>/gi, '‹$1untrusted-screen-content›');
  return `<untrusted-screen-content>\n${safe}\n</untrusted-screen-content>`;
}

/** The structured part of a bridge reply that the tools read: whitelisted, bounded, typed. */
export function structuredMissFields(r: unknown): Record<string, unknown> {
  const o = (r ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // The Linux bridge's search-cut reply (`partial: true`) is a timeout: it ran out of budget, nothing was ruled out.
  const reason = o.partial === true ? 'timeout' : o.reason;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return out;
  out.reason = reason;
  if (typeof o.detail === 'string' && o.detail) out.detail = o.detail.slice(0, 500);
  if (o.cascade === true) out.cascade = true;
  if (typeof o.otherWindows === 'number' && Number.isFinite(o.otherWindows) && o.otherWindows > 0) {
    out.otherWindows = Math.min(Math.floor(o.otherWindows), 999);
  }
  return out;
}

interface MissData { reason?: unknown; detail?: unknown; cascade?: unknown; otherWindows?: unknown; error?: unknown }

/**
 * The reason, as text. With a known reason: our own sentence for it, the app's detail inside an untrusted block, the window
 * count as a number. Without one (an old bridge, a platform that does not send it): whatever the bridge said, inside an
 * untrusted block, so it is shown but never classified.
 */
export function missText(d: MissData | undefined, fallback = 'element not found or not actionable'): string {
  if (!d) return fallback;
  const reason = typeof d.reason === 'string' && REASONS.has(d.reason) ? (d.reason as MissReason) : undefined;
  if (!reason) return typeof d.error === 'string' && d.error.trim() ? untrusted(d.error.trim()) : fallback;
  const detail = typeof d.detail === 'string' && d.detail ? `\n${untrusted(d.detail)}` : '';
  let own: string;
  switch (reason) {
    case 'not_found': own = 'Element not found'; break;
    case 'no_window': own = 'No window for that process'; break;
    case 'unsupported': own = d.cascade === true ? 'No invoke/toggle/select/expand pattern' : 'the element does not support this action (Pattern not supported)'; break;
    case 'invoke_threw': own = 'Invoke failed:'; break;
    case 'disabled': own = 'the element is disabled'; break;
    case 'timeout': own = 'the search timed out before it read the whole window'; break;
    case 'hidden': own = 'the element exists but is not visible on screen, nothing was done'; break;
    default: own = 'the action failed';
  }
  const n = typeof d.otherWindows === 'number' ? d.otherWindows : 0;
  const scope = reason === 'not_found' && n > 0
    ? `; only the front window was searched; this app has ${n} other window${n === 1 ? '' : 's'} — window {"action":"focus","title":"…"} first to work in one`
    : '';
  return `${own}${scope}${detail}`;
}
