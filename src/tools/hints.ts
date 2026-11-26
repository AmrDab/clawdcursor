/**
 * The text clawdcursor adds to tool results to steer the agent: what a blind read could not show (blind-hints), which
 * window a read covered (scope-note), whose window is under a point (click-owner), the help after a by-name miss
 * (name-search-help), and how hints are rewritten for the compact surface and as prose (hint-rewrite, call-prose).
 */

import type { UiElement, PlatformAdapter, WindowAtPoint } from '../platform/types';
import { untrusted } from '../core/miss-text';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { wakeAccessibility } from '../platform/a11y-wake';
import { COMPOUND_ROUTE_INDEX, compactCall } from './compact-routes';

// ─── blind-hints ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Shared wording for blind-first perception results, used by both tool
 * surfaces (the src/tools/*.ts tools and the core tools in core-tools.ts).
 */
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

/** read_tree's line for an opaque area. It names smart_click and batch; this line is outside <untrusted-screen-content>, so it is
 *  rewritten to the caller's surface names like SPARSE_NEXT_STEP (toCompactNames). The MCP server matches
 *  its start to know the agent is on a canvas (mcp-server.ts). */
export const OPAQUE_MARK = '→ Opaque area @';
export function opaqueAreaLine(o: { bounds: UiElement['bounds']; share: number }): string {
  const b = o.bounds;
  return `${OPAQUE_MARK}${b.x},${b.y} ${b.width}×${b.height} (${Math.round(o.share * 100)}% of the window): nothing inside has a name — ` +
    'a canvas, board or drawn view. Inside it, work from one screenshot: send all the strokes in ONE batch, then look again only at the area that changed. ' +
    'Outside it, a button or field with a visible label is pressed with smart_click {"target":"<label>"}, no screenshot.';
}

/** read_tree cut a long value: how to read it whole (outside the screen-content block, so it is rewritten per surface).
 *  A role-only get_value works on Linux but not on Windows, so an unnamed editor goes to copy_all_text. */
export const CUT_VALUE_NEXT_STEP =
  '→ A value ending in "chars not shown" is cut. Read it whole: copy_all_text for a document or an unnamed editor · ' +
  'a11y_get_value {"name":"…"} for a named field.';

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

/** Title-bar buttons and the system menu: named, pressable, and nothing to do with the app's own controls. */
const WINDOW_CHROME = /^(?:Minimize|Maximize|Restore|Close|System|System Menu Bar)$/i;
const CHROME_ROLE = /^(?:Button|MenuItem|MenuBar)$/i;
const CONTAINER_ROLE = /^(?:Pane|Group|ToolBar)$/i;

/**
 * A window that names things but has nothing to press: a CAD or drawn-UI app whose ribbon, toolbars and panels are named panes
 * (live 2026-11-16, Designcenter: ~35 named Panes and the title-bar buttons, 73 coordinate clicks, ~58 on labelled buttons). It is not sparse
 * (5+ named), so SPARSE_NEXT_STEP never fires. Fires on a tree that is not sparse, not a browser, has no actionable element once window chrome
 * is left out, and at least 3 named Pane / Group / ToolBar elements. An open dialog lists its buttons and fields, so it does not fire.
 */
export function drawnControlsLine(tree: ReadonlyArray<UiElement>, isBrowser = false): string | null {
  if (isBrowser || isSparseTree(tree, false)) return null;
  const pressable = tree.some(el => ACTIONABLE.test(el.controlType ?? '') && !(named(el) && CHROME_ROLE.test(el.controlType ?? '') && WINDOW_CHROME.test((el.name ?? '').trim())));
  if (pressable) return null;
  if (tree.filter(el => named(el) && CONTAINER_ROLE.test(el.controlType ?? '')).length < 3) return null;
  return '→ Nothing here to press by name: this window lists only panes and its title-bar buttons, so its toolbars and panels are drawn by the app. ' +
    'Press what you can see by its label: smart_click {"target":"<label>"} reads the screen itself, no screenshot. A screenshot and x,y only for a point with no label.';
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

// ─── scope-note ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A find or invoke covers the FRONT window of an app (see scripts/ps-bridge.ps1 Get-ProcessScopeWindows; macOS key window,
 * Linux active window). A miss must say so: otherwise "no elements found" reads as "nothing in the app" when the element is
 * in another window of it.
 */
export async function narrowedScopeNote(
  platform: { listWindows(): Promise<Array<{ processId: number; title?: string }>> } | undefined,
  scopes: Array<{ processId?: number; title?: string }>,
): Promise<string> {
  const generic = ' — pass processId to target another app';
  const s = scopes.find(x => x.processId !== undefined);
  if (!s || !platform) return generic;
  try {
    const mine = (await platform.listWindows()).filter(w => w.processId === s.processId && (w.title ?? '').trim());
    const others = Math.max(0, mine.length - 1);
    if (others === 0) return generic;
    // The title is page text: inside an untrusted block, so classifyResult never reads it as clawdcursor's own words.
    return `; only the front window was searched; this app has ${others} other window${others === 1 ? '' : 's'}`
      + ' — window {"action":"focus","title":"…"} first to work in one'
      + (s.title ? `\n${untrusted(`front window: ${s.title}`)}` : '');
  } catch { return generic; }
}

// ─── click-owner ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A coordinate click must land in the window it was meant for. A system dialog on top of the target (macOS "Accessibility
 * Access" over a app's window) matched the label "settings" and was clicked, though the caller named the other app.
 * The check asks the platform which window is at the point (`windowAtPoint`, read-only); a platform that cannot say
 * (null, no such method, an error) allows the click — it fails open.
 */
/** `"Title" (process, pid N)` for a window found at a point: the title is screen text, so quoted. */
export function describeWindowAt(at: WindowAtPoint): string {
  const shown = at.hostedProcessName || at.processName;   // a Store app by its own name, not ApplicationFrameHost
  const name = shown ? shown.replace(/[^\w .+-]/g, '').slice(0, 60) : 'unknown app';
  return `${at.title ? quoteScreenText(at.title) : 'a window'} (${name}, pid ${at.processId})`;
}

/**
 * Does the window at a point belong to one of these processes? A Windows Store app's frame belongs to ApplicationFrameHost
 * and hosts the app's own process: window lists report the first as `processId` and the second as `hostedProcessId`, and a
 * caller may target either, so either matches (else every click in Calculator or Settings would read as another app's).
 */
export function ownsPoint(at: Pick<WindowAtPoint, 'processId' | 'hostedProcessId'> | null | undefined, ...pids: Array<number | undefined>): boolean {
  return !!at && pids.some(p => !!p && (p === at.processId || p === at.hostedProcessId));
}

/**
 * The refusal text when the window at (x, y) belongs to another process than `targetPid`, else null (go ahead).
 * `label` is what the point was matched by; `targetName` names the window the click was meant for.
 */
export async function foreignWindowRefusal(
  platform: Pick<PlatformAdapter, 'windowAtPoint'> | undefined,
  x: number, y: number,
  targetPid: number | undefined,
  label: string,
  targetName?: string,
): Promise<string | null> {
  if (!platform?.windowAtPoint || !targetPid) return null;
  const at = await platform.windowAtPoint(x, y).catch(() => null);
  if (!at || !at.processId || ownsPoint(at, targetPid)) return null;
  const target = targetName || `process ${targetPid}`;
  const what = describeWindowAt(at);
  return `refused: the point ${quoteScreenText(label)} matched is in ${what}, which is on top of ${target} — nothing was clicked. `
    + `Bring ${target} to the front (or close the window on top of it), then try again`;
}

// ─── name-search-help ────────────────────────────────────────────────────────────────────────────────────

/**
 * Two helps for a by-name search (find, invoke, smart_click) that matters most on a Mac:
 *  - an Electron / Chromium app builds its accessibility tree only after a client asks (AXManualAccessibility): read_tree
 *    wakes the app, a search by name did not, so it saw a thin tree and missed. The wake is sent once per process.
 *  - a miss because another app's window (a system dialog) covers the one being searched: the line says whose, and the
 *    processId to read it with.
 */
const woken = new Set<number>();

/** Test hook. */
export function resetNameSearchState(): void { woken.clear(); }

/** macOS: switch the app's accessibility on before its first by-name search (the pid is the caller's, else the focused window's). */
export async function wakeForNameSearch(
  platform: Pick<PlatformAdapter, 'getActiveWindow'> | undefined,
  pid?: number,
  os: NodeJS.Platform = process.platform,
): Promise<void> {
  if (os !== 'darwin') return;
  // Best effort: a wake must never fail the search it helps (a platform without getActiveWindow, a helper error).
  try {
    const target = pid ?? (await platform?.getActiveWindow?.())?.processId;
    if (!target || woken.has(target)) return;
    woken.add(target);
    await wakeAccessibility(target, os);
  } catch { /* the search goes ahead unwoken */ }
}

/**
 * One line for a miss: another app's window is on top of the searched window's centre. Null when it is not, or cannot be
 * told. The title is screen text: quoted, and the line goes outside the untrusted block like the other result lines.
 */
export async function onTopOfLine(
  platform: Pick<PlatformAdapter, 'windowAtPoint' | 'listWindows' | 'getActiveWindow'> | undefined,
  pid?: number,
): Promise<string | null> {
  if (!platform?.windowAtPoint) return null;
  try {
    const target = pid === undefined
      ? await platform.getActiveWindow().catch(() => null)
      : (await platform.listWindows().catch(() => []))
        .filter(w => w.processId === pid && !w.isMinimized && w.bounds?.width > 0 && w.bounds?.height > 0)
        .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
    if (!target?.bounds || !target.processId) return null;
    const b = target.bounds;
    const at = await platform.windowAtPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
    if (!at || !at.processId || ownsPoint(at, target.processId, target.hostedProcessId)) return null;
    return `→ ${describeWindowAt(at)} is on top of this window; pass processId:${at.processId} to read it`;
  } catch { return null; }
}

// ─── hint-rewrite ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tool results are rewritten so hints name tools that exist on the caller's
 * surface (see toCompactNames). That rewrite must only touch
 * clawdcursor's own prose:
 *   - a JSON result is data and stays byte-identical — the compact rewrite
 *     inserts `{action:"…"}` with raw double quotes, which made every OCR
 *     result (its hint names smart_click / mouse_click) unparseable;
 *   - text inside <untrusted-screen-content> is what the screen, page, file
 *     or clipboard said — rewriting it would corrupt what the agent reads.
 */
const UNTRUSTED_BLOCK = /(<untrusted-screen-content>[\s\S]*?<\/untrusted-screen-content>)/;

export function rewriteOutsideData(text: string, rewrite: (prose: string) => string): string {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return text; } catch { /* not JSON — treat as prose */ }
  }
  return text
    .split(UNTRUSTED_BLOCK)
    .map((seg, i) => (i % 2 === 1 ? seg : rewrite(seg)))
    .join('');
}

// ─── call-prose ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hints name a call as prose, never as call-shaped text.
 *
 * Tool text and result lines write a call as `browser {"action":"page_context"}`. A host does not call a tool named
 * `browser`: it prefixes every tool with its server name, so agents that copied the bare name got "No such tool" and lost a
 * round trip (8 of 16 test runs, audit 2026-11-19). Prose names the tool and the action and leaves the host's spelling to the
 * agent: "the browser tool, action page_context": a compound tool and its action, also for a granular tool a hint names (its
 * compound route).
 *
 * Applied once, to the text that leaves the server (mcp-server.ts), so every hint is covered whoever wrote it.
 */
const COMPOUNDS = Object.keys(COMPOUND_ROUTE_INDEX);
const DELEGATES = [...new Set(Object.values(COMPOUND_ROUTE_INDEX).flat().map(r => r.delegate))];
// Longest first, so `mouse_click` is never read as a shorter name that ends it.
const NAMES = [...COMPOUNDS, ...DELEGATES].sort((a, b) => b.length - a.length);

/** `name {"action":"x", ...}`, `name({...})` or `name {"key": ...}`, with the arguments left to the scanner below. */
const CALL_HEAD = new RegExp(`(\`?)(?<![\\w"-])(${NAMES.join('|')})(\\(?)[ \\t]*\\{(?=[ \\t]*"?[A-Za-z_]+"?[ \\t]*:)`, 'g');

/** The end of a value that starts at `i`: the next top-level `,` or `}`. -1 when the text ends first. */
function valueEnd(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      if (i >= s.length) return -1;
    } else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (depth === 0) return c === '}' ? i : -1; depth--; }
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

/** The `key: value` pairs of an argument list that starts after its `{`, and where its `}` is. Null when it is not one. */
function readArgs(s: string, from: number): { args: [string, string][]; end: number } | null {
  const args: [string, string][] = [];
  let i = from;
  for (;;) {
    while (/\s/.test(s[i] ?? '')) i++;
    if (s[i] === '}') return { args, end: i + 1 };
    const key = /^(?:"([A-Za-z_]+)"|([A-Za-z_]+))[ \t]*:\s*/.exec(s.slice(i));
    if (!key) return null;
    i += key[0].length;
    const end = valueEnd(s, i);
    if (end < 0) return null;
    args.push([key[1] ?? key[2], s.slice(i, end).trim()]);
    i = end;
    if (s[i] === ',') i++;
  }
}

function proseCall(name: string, args: [string, string][]): string | null {
  const given = args.find(([k]) => k === 'action');
  const action = given ? given[1].replace(/^"|"$/g, '') : undefined;
  const rest = args.filter(([k]) => k !== 'action').map(([k, v]) => `${k} ${v}`);
  let tool: string;
  let act: string | undefined;
  if (COMPOUNDS.includes(name)) {
    if (!action) return null;
    tool = name; act = action;
  } else {
    const c = compactCall(name);
    if (!c.action) return null;
    tool = c.tool; act = c.action;
  }
  return [`the ${tool} tool${act ? `, action ${act}` : ''}`, ...rest].join(', ');
}

/** Rewrite every call-shaped text in `text` as prose. Text that is not a well-formed call stays as it is. */
export function callsAsProse(text: string): string {
  if (!text.includes('{')) return text;
  let out = '';
  let last = 0;
  CALL_HEAD.lastIndex = 0;
  for (let m = CALL_HEAD.exec(text); m; m = CALL_HEAD.exec(text)) {
    const parsed = readArgs(text, m.index + m[0].length);
    if (!parsed) continue;
    let end = parsed.end;
    // `browser({...})` and `` `browser {...}` ``: the brackets and ticks around the call go with it, or not at all.
    if (m[3]) { if (text[end] !== ')') continue; end++; }
    const ticks = !!m[1] && text[end] === '`';
    if (ticks) end++;
    const prose = proseCall(m[2], parsed.args);
    if (!prose) continue;
    out += text.slice(last, m.index) + (m[1] && !ticks ? m[1] : '') + prose;
    last = end;
    CALL_HEAD.lastIndex = end;
  }
  return out + text.slice(last);
}

/** The fields of a JSON result that advise the caller; the rest of a JSON result is data and is never touched. */
const ADVICE_FIELDS = ['next', 'hint', 'toMouseClick'] as const;

/** `callsAsProse` for a result that is prose or a JSON result: prose outside the screen-content blocks, a JSON result's advice fields only. */
export function resultCallsAsProse(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) {
    let o: Record<string, unknown> | undefined;
    try { o = JSON.parse(t); } catch { /* prose that starts with a brace */ }
    if (o) {
      let changed = false;
      for (const k of ADVICE_FIELDS) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        const p = callsAsProse(v);
        if (p !== v) { o[k] = p; changed = true; }
      }
      if (!changed) return text;
      // Same layout as it came in; an integer past 2^53 would lose digits in a re-serialisation, so replace in the text itself then.
      const indent = t.includes('\n') ? 2 : undefined;
      if (JSON.stringify(JSON.parse(t), null, indent) === t) return JSON.stringify(o, null, indent);
      let outText = text;
      const orig = JSON.parse(t);
      for (const k of ADVICE_FIELDS) {
        if (typeof orig[k] !== 'string' || o[k] === orig[k]) continue;
        outText = outText.replace(JSON.stringify(orig[k]), () => JSON.stringify(o![k]));
      }
      return outText;
    }
  }
  return rewriteOutsideData(text, prose => callsAsProse(prose));
}
