/**
 * Shared wording for blind-first perception results, used by both tool
 * surfaces (System A registry tools and the projected agent-loop tools).
 */

/** a11y positions are SCREEN coordinates — clicked as image coords they land
 *  off-target on a scaled display, which made blind reads look unreliable. */
export const SCREEN_COORDS_NOTE = '(positions are screen coordinates — click them with space:"screen", or act by name)';

/** Next step when a blind read comes back thin (MCP agents), instead of a
 *  dead end that leaves screenshots as the only option. */
export const SPARSE_NEXT_STEP =
  '→ Little or no accessibility structure here (common for web pages and canvas apps). Next: ' +
  'copy_all_text for the exact page text · smart_click name:"…" to press a labelled control (OCR fallback) · ' +
  'ocr to read it · screenshot only if those fail. ' +
  'Electron/Chromium app? Restarting it with --force-renderer-accessibility exposes the whole page (required on Linux).';

/** The same advice for clawdcursor's internal agent loop, in its own tool names. */
export const SPARSE_NEXT_STEP_INTERNAL =
  '→ Little or no accessibility structure here (common for web pages and canvas apps). Next: ' +
  'read_text (OCR) to read it · screenshot only if that is not enough.';

/**
 * Next step when the thin read is of the browser clawdcursor is attached to
 * over CDP (#235): its page is readable through the browser tools right now,
 * and restarting clawdcursor's own browser is neither needed nor possible
 * for the agent.
 */
export function cdpBrowserNextStep(mode: 'dedicated' | 'attached'): string {
  return '→ This is the browser clawdcursor is attached to over CDP: read and act on its page with ' +
    'browser {action:"page_context"} (interactive elements) · browser {action:"read_text"} · browser {action:"click"} — ' +
    'they see the whole page, whatever the accessibility tree shows.' +
    (mode === 'dedicated'
      ? " It is clawdcursor's own browser: don't restart it — clawdcursor switches its accessibility on itself."
      : '');
}

/** A window with at least this many named elements is not "thin": a miss there is a wrong name, not a blind app. */
const STRUCTURED_MIN = 5;

/** How alike two element names are, for "did you mean": shared words, containment, then a common prefix. 0 = unrelated. */
function nameScore(want: string, have: string): number {
  const a = want.toLowerCase().trim();
  const b = have.toLowerCase().trim();
  if (!a || !b) return 0;
  let s = 0;
  if (b.includes(a) || a.includes(b)) s += 3;
  const words = (t: string) => new Set(t.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2));
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) s += 2;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p >= 3) s += 1;
  return s;
}

/**
 * A find that matched nothing, in a window whose tree was read: if the window has real structure, the name was wrong —
 * say how many elements it has and the closest names (as data). Null when the window is thin: the caller keeps its
 * "little or no accessibility structure" advice, which is only true then.
 */
export function nameMissHint(
  name: string,
  tree: ReadonlyArray<{ name?: string; controlType?: string }>,
  wrap: (screenText: string) => string,
): string | null {
  const named = tree.filter(el => (el.name ?? '').trim());
  if (named.length < STRUCTURED_MIN) return null;
  const seen = new Set<string>();
  const close = named
    .map(el => ({ el, s: nameScore(name, el.name ?? '') }))
    .filter(x => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .filter(x => { const k = (x.el.name ?? '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5)
    .map(x => `[${(x.el.controlType || 'Element').replace(/^ControlType\./, '')}] "${(x.el.name ?? '').slice(0, 60)}"`);
  const head = `→ No element named "${name.slice(0, 60)}" among the ${named.length} named elements in this window.`;
  return close.length
    ? `${head} Closest names:\n${wrap(close.join('\n'))}`
    : `${head} None is close: read the window (read_tree / compile_ui) to see what it calls things.`;
}
