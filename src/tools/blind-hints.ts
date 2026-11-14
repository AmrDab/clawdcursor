/**
 * Shared wording for blind-first perception results, used by both tool
 * surfaces (System A registry tools and the projected agent-loop tools).
 */
import type { UiElement } from '../platform/types';

/** Act on a listed element by its name; its @x,y are SCREEN coordinates — clicked as image coords they land off-target on a
 *  scaled display, which made blind reads look unreliable. Surface-agnostic: no tool names to rewrite. */
export const SCREEN_COORDS_NOTE = '(act on these by name: invoke {"name":"…"}. The @x,y are screen coordinates, only for an element that has no name: click with space:"screen")';

/** Next step when a blind read comes back thin (MCP agents), instead of a
 *  dead end that leaves screenshots as the only option. */
export const SPARSE_NEXT_STEP =
  '→ Little or no accessibility structure here (common for canvas apps and pages that expose none). ' +
  'SEE: read_screen → copy_all_text → ocr_read_screen. ' +
  'ACT: invoke_element / set_field_value by name → smart_click {"target":"<label>"} → desktop_screenshot, then mouse_click with x,y from that image. ' +
  'Electron/Chromium app? Restarting it with --force-renderer-accessibility exposes the whole page (required on Linux).';

/** How many characters of an element's value its line shows. */
const VALUE_SHOWN = 40;

/**
 * An element's value on its line, for read_tree and find alike: quoted, with line breaks and quotes escaped so the element
 * stays on one line, and marked when cut — an agent that took the first 40 characters of a document for all of it rewrote
 * the document without its tail (perception eval 2026-11-05). `onCut` runs when the value was cut.
 */
export function shownValue(v: string | undefined, onCut?: () => void): string {
  if (!v) return '';
  const head = JSON.stringify(v.slice(0, VALUE_SHOWN));
  if (v.length <= VALUE_SHOWN) return ` value=${head}`;
  onCut?.();
  return ` value=${head}… (+${v.length - VALUE_SHOWN} chars not shown)`;
}

/**
 * The text an app shows on hover (UIA HelpText, AXHelp, AT-SPI description), on read_tree and find lines alike: only when
 * it says more than the name, quoted and kept to one line like a value, so an agent reads what a button does without hovering.
 */
export function shownHelp(el: { name?: string; help?: string }): string {
  const h = (el.help ?? '').trim();
  if (!h || h === (el.name ?? '').trim()) return '';
  return ` help=${JSON.stringify(h.length > 80 ? h.slice(0, 80) : h)}${h.length > 80 ? '…' : ''}`;
}

/** Share of the window a nameless area must cover before read_tree reports it. */
const OPAQUE_SHARE = 0.25;
/** Text roles on UIA / AX (role prefix stripped) / AT-SPI. */
const TEXT_ROLE = /^(?:Text|StaticText|label|static|paragraph)$/i;
/** Editors and collections (UIA / AX / AT-SPI as normalized): empty, they are still something to type into or pick from. */
const FIELD_ROLE = /^(?:Edit|Document|TextArea|TextField|List|Table|DataGrid|Tree|Outline)$/i;

/**
 * A large part of the window in which nothing has a name or a value: a drawing canvas, a whiteboard, a CAD viewport, a page
 * drawn in a <canvas>. The window is the largest element read; the area is the largest element covering at least a quarter
 * of it with no readable element (named, with a value, or a field) centred inside. Null when there is none.
 * Geometry only; the Windows and macOS bridges keep a large unnamed leaf for it (ps-bridge.ps1, ax-helper.swift).
 */
export function opaqueArea(tree: ReadonlyArray<UiElement>): { bounds: UiElement['bounds']; share: number } | null {
  const area = (el: UiElement) => (el.offscreen || el.bounds.width <= 0 || el.bounds.height <= 0 ? 0 : el.bounds.width * el.bounds.height);
  const windowArea = Math.max(0, ...tree.map(area));
  if (!windowArea) return null;
  const win = tree.find(el => area(el) === windowArea);
  const readable = tree.filter(el => el !== win && area(el) > 0 && (named(el) || !!el.value || FIELD_ROLE.test(el.controlType ?? '')));
  // No larger and centred in it: an editor with the same bounds as its scroll wrapper is its content; the page around a canvas is not.
  const inside = (c: UiElement, el: UiElement) => {
    if (area(el) > area(c)) return false;
    const cx = el.bounds.x + el.bounds.width / 2, cy = el.bounds.y + el.bounds.height / 2;
    return cx >= c.bounds.x && cx <= c.bounds.x + c.bounds.width && cy >= c.bounds.y && cy <= c.bounds.y + c.bounds.height;
  };
  // A text element's name IS its content (a long paragraph is one big Text): readable, not opaque. A field is never drawn,
  // and a ScrollArea (AX) only scrolls its content, which may be taller than it (an NSTextView).
  const best = tree
    .filter(c => area(c) >= OPAQUE_SHARE * windowArea && !c.value && !TEXT_ROLE.test(c.controlType ?? '')
      && !FIELD_ROLE.test(c.controlType ?? '') && c.controlType !== 'ScrollArea'
      && !readable.some(el => el !== c && inside(c, el)))
    .sort((a, b) => area(b) - area(a))[0];
  return best ? { bounds: best.bounds, share: area(best) / windowArea } : null;
}

/** read_tree's line for an opaque area. No tool names but batch, so it reads the same on every surface. The MCP server
 *  matches its start to know the agent is on a canvas (mcp-server.ts). */
export const OPAQUE_MARK = '→ Opaque area @';
export function opaqueAreaLine(o: { bounds: UiElement['bounds']; share: number }): string {
  const b = o.bounds;
  return `${OPAQUE_MARK}${b.x},${b.y} ${b.width}×${b.height} (${Math.round(o.share * 100)}% of the window): nothing inside has a name — ` +
    'a canvas, board or drawn view. Work in it from one screenshot: send all the strokes in ONE batch, then look again only at the area that changed.';
}

/** read_tree cut a long value: how to read it whole (outside the screen-content block, so it is rewritten per surface).
 *  A role-only get_value works on Linux but not on Windows, so an unnamed editor goes to copy_all_text. */
export const CUT_VALUE_NEXT_STEP =
  '→ A value ending in "chars not shown" is cut. Read it whole: copy_all_text for a document or an unnamed editor · ' +
  'a11y_get_value {"name":"…"} for a named field.';

export const CUT_VALUE_NEXT_STEP_INTERNAL =
  '→ A value ending in "chars not shown" is cut. Read a named field whole with a11y_get_value {"name":"…"}.';

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
    'browser {"action":"page_context"} (interactive elements) · browser {"action":"read_text"} · browser {"action":"click"} — ' +
    'they see the whole page, whatever the accessibility tree shows.' +
    (mode === 'dedicated'
      ? " It is clawdcursor's own browser: don't restart it — clawdcursor switches its accessibility on itself."
      : '');
}

/** The parts of the CDP driver the hints read. Optional: test contexts give a partial driver, or none. */
type CdpHintSource = {
  isConnected?: () => Promise<boolean>;
  getBrowserPid?: () => Promise<number | null>;
  getConnectionMode?: () => string;
} | null | undefined;

/** Pid of the browser clawdcursor is attached to over CDP, or null. Never throws. */
export async function cdpBrowserPid(cdp: CdpHintSource): Promise<number | null> {
  try {
    if (!(await cdp?.isConnected?.())) return null;
    const pid = await cdp?.getBrowserPid?.();
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The browser-tools hint (cdpBrowserNextStep) when `pid` is the browser clawdcursor is attached to over CDP, else ''.
 * `pid` may be a lookup (the active window's), made only when a CDP browser is attached.
 */
export async function cdpStepFor(cdp: CdpHintSource, pid: number | undefined | (() => Promise<number | undefined>)): Promise<string> {
  const cdpPid = await cdpBrowserPid(cdp);
  if (cdpPid === null) return '';
  if ((typeof pid === 'function' ? await pid() : pid) !== cdpPid) return '';
  let mode: string | undefined;
  try { mode = cdp?.getConnectionMode?.(); } catch { /* unknown */ }
  return cdpBrowserNextStep(mode === 'dedicated' ? 'dedicated' : 'attached');
}

/** A window with at least this many named elements is not "thin": a miss there is a wrong name, not a blind app. */
const STRUCTURED_MIN = 5;

/** Controls an agent acts on by name. */
const ACTIONABLE = /^(?:Button|CheckBox|RadioButton|Edit|ComboBox|Hyperlink|MenuItem|ListItem|TabItem|Slider|SplitButton|TreeItem|Spinner|text field|push button|check box|radio button|combo box|link|menu item|list item|page tab)$/i;
const named = (el: UiElement) => !!(el.name ?? '').trim();

/** Elements that lie inside a web area (Document). The browser's own find bar, side panel and toolbar are outside it. */
function insideDocuments(tree: ReadonlyArray<UiElement>): UiElement[] {
  const docs = tree.filter(el => el.controlType === 'Document' && el.bounds.width > 0 && el.bounds.height > 0);
  return tree.filter(el => {
    if (el.controlType === 'Document' || el.bounds.width <= 0 || el.bounds.height <= 0) return false;
    const cx = el.bounds.x + el.bounds.width / 2;
    const cy = el.bounds.y + el.bounds.height / 2;
    return docs.some(d => cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height);
  });
}

/** Enough to act on: 5 named elements, or a small set that is mostly named with a control to act on (a dialog, a login form). */
function hasStructure(els: ReadonlyArray<UiElement>, smallMin = 1): boolean {
  const names = els.filter(named);
  if (names.length >= STRUCTURED_MIN) return true;
  return names.length >= smallMin && names.length * 2 >= els.length && names.some(el => ACTIONABLE.test(el.controlType ?? ''));
}

/**
 * Is this read sparse enough to say "little or no accessibility structure"? A browser is judged by what is INSIDE its web
 * area (its own tab strip and toolbar are ~59 elements and say nothing about the page), any other window by the whole tree.
 * Either is sparse with fewer than 5 named elements, unless it is small and mostly named with something to act on: a
 * three-button dialog, a login form. A tree that holds the page is not sparse: the hint sent agents to OCR after every read of a page they
 * could already read by name.
 */
export function isSparseTree(tree: ReadonlyArray<UiElement>, isBrowser: boolean): boolean {
  // In a web area the small-set exception needs 3 named elements: a canvas or Flutter page with one "Enable accessibility"
  // button is not a readable page.
  return !(isBrowser ? hasStructure(insideDocuments(tree), 3) : hasStructure(tree));
}

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
