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

import { wrapUntrustedScreenContent, quoteScreenText } from './untrusted-screen-content';

export type MissReason = 'not_found' | 'unsupported' | 'invoke_threw' | 'disabled' | 'timeout' | 'no_window' | 'hidden' | 'ambiguous' | 'failed';
const REASONS: ReadonlySet<string> = new Set<MissReason>(['not_found', 'unsupported', 'invoke_threw', 'disabled', 'timeout', 'no_window', 'hidden', 'ambiguous', 'failed']);

/** A name and a role as the screen gives them, bounded: shown only inside an untrusted block, or quoted. */
interface Named { name: string; controlType: string }
/** One of the elements an ambiguous name could mean: screen text, a screen rect and the window or dialog it is in. */
export interface MissCandidate extends Named { bounds?: { x: number; y: number; width: number; height: number }; container?: Named }
const MAX_CANDIDATES = 8;

function namedOf(raw: unknown): Named {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    name: String(o.name ?? '').replace(/\s+/g, ' ').slice(0, 80),
    controlType: String(o.controlType ?? '').replace(/^ControlType\./, '').slice(0, 40),
  };
}

function candidatesOf(raw: unknown): MissCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CANDIDATES).map(c => {
    const o = (c ?? {}) as Record<string, unknown>;
    const b = (o.bounds ?? {}) as Record<string, unknown>;
    const rect = [b.x, b.y, b.width, b.height];
    return {
      ...namedOf(o),
      ...(rect.every(v => typeof v === 'number' && Number.isFinite(v))
        ? { bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } } : {}),
      ...(o.container && typeof o.container === 'object' ? { container: namedOf(o.container) } : {}),
    };
  });
}

/** The element a by-name action acted on, and how its name matched the one asked for (#376). */
export interface PressedTarget extends Named { match: 'exact' | 'prefix' | 'substring' }

/** The bridge's `target` from a success reply, bounded and typed; undefined without one (an old bridge, an id match). */
export function targetOf(raw: unknown): PressedTarget | undefined {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (typeof t.name !== 'string' || (t.match !== 'exact' && t.match !== 'prefix' && t.match !== 'substring')) return undefined;
  return { ...namedOf(t), match: t.match };
}

/** What a success line calls the element acted on: its role and its own name, and how that matched when not exactly. */
export function targetText(t: PressedTarget | undefined, asked: string): string {
  if (!t) return quoteScreenText(asked);
  const role = t.controlType ? `[${t.controlType}] ` : '';
  const how = t.match === 'exact' ? '' : ` (its name ${t.match === 'prefix' ? 'starts with' : 'contains'} ${quoteScreenText(asked)})`;
  return `${role}${quoteScreenText(t.name)}${how}`;
}

/** The one wrapper (untrusted-screen-content.ts): the content cannot close the block. */
export const untrusted = wrapUntrustedScreenContent;

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
  if (reason === 'ambiguous') {
    out.candidates = candidatesOf(o.candidates);
    // No element is named exactly that: the ones listed only contain the name (#376).
    if (o.inexact === true) out.inexact = true;
    // The window is minimized: its elements have no place on screen to click (#364).
    if (o.minimized === true) out.minimized = true;
  }
  if (typeof o.otherWindows === 'number' && Number.isFinite(o.otherWindows) && o.otherWindows > 0) {
    out.otherWindows = Math.min(Math.floor(o.otherWindows), 999);
  }
  return out;
}

interface MissData { reason?: unknown; detail?: unknown; cascade?: unknown; otherWindows?: unknown; error?: unknown; candidates?: unknown; inexact?: unknown; minimized?: unknown }

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
    case 'ambiguous': {
      const list = candidatesOf(d.candidates);
      const rows = list.map(c => `[${c.controlType || 'Element'}] ${JSON.stringify(c.name)}` +
        (c.container ? ` in [${c.container.controlType || 'Element'}] ${JSON.stringify(c.container.name)}` : '') +
        (c.bounds ? ` @${c.bounds.x},${c.bounds.y} ${c.bounds.width}x${c.bounds.height}` : ''));
      const block = rows.length ? `\n${untrusted(rows.join('\n'))}` : '';
      const place = d.minimized === true
        ? 'its window is minimized, so none has a place to click: restore the window first (window {"action":"restore"})'
        : 'or click its position (@x,y is its top-left corner, in screen coordinates)';
      if (d.inexact === true) {
        return `no element is named exactly that: ${list.length || 'the'} element${list.length === 1 ? '' : 's'} on screen only contain${list.length === 1 ? 's' : ''} it, nothing was done; ` +
          `to press one, call again with its full name as listed, ${place}:${block}`;
      }
      // within helps only when the listed ones are in different windows or dialogs.
      const within = new Set(list.map(c => c.container?.name)).size > 1 ? 'pick one with within (the window or dialog it is in, as listed), or ' : '';
      return `${list.length || 'several'} elements on screen match that name, nothing was done; ` +
        `${within}name it by its controlType, ${place}:${block}`;
    }
    default: own = 'the action failed';
  }
  const n = typeof d.otherWindows === 'number' ? d.otherWindows : 0;
  const scope = reason === 'not_found' && n > 0
    ? `; only the front window was searched; this app has ${n} other window${n === 1 ? '' : 's'} — window {"action":"focus","title":"…"} first to work in one`
    : '';
  return `${own}${scope}${detail}`;
}
