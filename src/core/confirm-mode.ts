/**
 * Confirm mode (#373): opt-in, off by default. CLAWD_CONFIRM=1 (the Claude Desktop extension's "Ask before Send / Delete /
 * Pay / Close" toggle sets it) holds an act that looks irreversible and asks the user on the pause card first.
 *
 * For hosts that auto-approve tool calls, and unattended runs: 2.0 removed the always-on gate (#344) because it refused
 * ordinary work and coordinate clicks went around it. This mode asks instead of refusing, and runs in the input layer
 * (pointer-guard.ts) under every tool, batch step and named shortcut, so a click by coordinates is checked by the element
 * under it.
 *
 * What is held (a small, fixed list; English labels):
 *  - a click, double-click or accessibility act on an element named Send, Delete, Remove, Pay, Buy, Submit, Close or Discard
 *    (a word of the name: "Send now", not "Sender"). By name: the elements the query reaches, found the way the act finds
 *    them (the bridges match part of a name: "Sen" presses Send). By coordinates: the smallest button, link, menu item,
 *    list item or tab under the point in the window in front (text, a document, a field or the window is not pressed);
 *  - a browser click on such an element: the element the selector picks, or the buttons and links whose text has the text;
 *  - the keys alt+f4, mod+w, mod+q, mod+enter, shift+delete, also built from keys held with key_down, and typed text while
 *    a key is held (key_down ctrl, then type "w");
 *  - closing a window.
 *
 * Only the user's click on Resume on the pill lets it through ('resumed' with `pill`, never detected): not
 * `clawdcursor resume` or POST /resume, which a model with a shell can call. End task, a typed reply, an AI's
 * resume_task, a timeout, or no card to show: nothing is sent. The card names the act and the window it is in, and so
 * does the key a Resume is kept under: a Resume given after the held call returned is kept for that same act in that
 * same window for two minutes, once, so the agent's retry goes through without asking again. A Resume given while the
 * call waits covers the same act for a few seconds, so an invoke's next rung (click, then select, then toggle, then a
 * click at its bounds) is not asked again.
 */
import { pauseGate, type PauseResult } from './pause-gate';
import { foregroundNow } from './control';
import { keysOf } from '../platform/hard-keys';
import { normalizeKey } from '../platform/keys';
import type { UiElement } from '../platform/types';
import type { Page } from 'playwright';
import { quoteScreenText } from './result-codes';

const LABEL = /\b(send|delete|remove|pay|buy|submit|close|discard)\b/i;
const COMBOS = ['alt+f4', 'mod+w', 'mod+q', 'mod+enter', 'shift+delete'];
/** Roles a click presses (UIA, macOS AX without its prefix, AT-SPI): not text, a document, a field or the window. */
const PRESSABLE = /^(?:Button|SplitButton|PopUpButton|MenuButton|CheckBox|RadioButton|Hyperlink|Link|MenuItem|ListItem|Cell|TabItem|Tab|TreeItem|OutlineRow|push button|toggle button|check box|radio button|menu item|check menu item|radio menu item|list item|page tab)$/i;
/** Under common 60 s MCP client timeouts, as pause_for_user. */
const WAIT_MS = 45_000;
const APPROVAL_MS = 2 * 60_000;
/** A Resume given inside the call also covers the act's next tries (an invoke's ladder, its bounds click) this long. */
const LADDER_MS = 10_000;

// On Windows both executors press `meta` as Ctrl (keys.ts, windows.ts); hard-keys reads it as the Windows key. A press is
// read here as it is sent: meta+w closes the tab. The Windows key is in no combo on Windows, so nothing is lost.
const keySet = (combo: string, os: NodeJS.Platform) =>
  keysOf(os === 'win32' ? combo.split('+').map(k => (k.trim().toLowerCase() === 'meta' ? 'ctrl' : k)).join('+') : combo, os)
    .map(k => normalizeKey(k).toLowerCase());

/** Does this key input (a chord, or a sequence of chords) press one of the held combos, with the keys held down (as named)? */
export function consequentialCombo(combo: unknown, held: string[] = [], os: NodeJS.Platform = process.platform): boolean {
  const heldKeys = held.flatMap(k => keySet(k, os));
  return String(combo ?? '').trim().split(/\s+/).filter(Boolean).some(chord => {
    const down = new Set([...heldKeys, ...keySet(chord, os)]);
    return COMBOS.some(c => keySet(c, os).every(k => down.has(k)));
  });
}

/** Typed text while a key is held: each character is a press with it, as the hard-key guard reads it; a newline is Enter. */
const typedCombo = (text: unknown, held: string[]) =>
  held.length > 0 && [...String(text ?? '')].some(ch => consequentialCombo(/[\r\n]/.test(ch) ? 'enter' : ch, held));

const nameOf = (e: UiElement) => (e.name || e.description || '').trim();

let readTree = async (): Promise<UiElement[]> => (await (await import('../platform')).getPlatform()).getUiTree();
export function __setTreeReaderForTests(f: (() => Promise<UiElement[]>) | null): void {
  readTree = f ?? (async () => (await (await import('../platform')).getPlatform()).getUiTree());
}

/** The name of the smallest named pressable element under (x, y) in the window in front (screen coordinates, as clicks take them). */
async function labelAt(x: number, y: number): Promise<string> {
  const tree = await readTree().catch(() => [] as UiElement[]);
  const area = (e: UiElement) => e.bounds.width * e.bounds.height;
  const hit = tree
    .filter(e => nameOf(e) && PRESSABLE.test(e.controlType ?? '') && e.bounds && area(e) > 0
      && x >= e.bounds.x && y >= e.bounds.y && x < e.bounds.x + e.bounds.width && y < e.bounds.y + e.bounds.height)
    .sort((a, b) => area(a) - area(b))[0];
  return hit ? nameOf(hit) : '';
}

type Finder = (q: object) => Promise<Array<{ name?: string }>>;
/**
 * The names of the elements a by-name act would reach, found by the object that acts (the accessibility bridge's
 * findElement, a platform adapter's findElements) with the same query: their matching takes part of a name.
 */
async function namesFor(target: object | undefined, q: Record<string, unknown>): Promise<string[]> {
  const t = target as { findElement?: Finder; findElements?: Finder } | undefined;
  const find = t?.findElement ?? t?.findElements;
  if (typeof find !== 'function' || (!q.name && !q.automationId)) return [];
  const hits = await find.call(t, { name: q.name, automationId: q.automationId, controlType: q.controlType, processId: q.processId }).catch(() => []);
  return Array.isArray(hits) ? hits.map(h => String(h?.name ?? '')) : [];
}

/**
 * The names of the page elements a CDP click(selector) / clickByText(text) would press: the element the selector picks,
 * or the buttons, links, menu items and tabs whose text or aria-label has the text (cdp-driver.ts matches part of it).
 * Every frame is read, iframes included: the driver's clicks reach into them (#398). A frame that hangs is left out after 1.5 s.
 */
async function pageNames(page: Page, bySelector: boolean, q: string): Promise<string[]> {
  const frames: Array<Pick<Page, 'evaluate'>> = typeof page.frames === 'function' ? page.frames() : [page];
  const late = () => new Promise<string[]>(r => setTimeout(() => r([]), 1500).unref?.());
  return (await Promise.all(frames.map(f => Promise.race([frameNames(f, bySelector, q), late()])))).flat();
}

/* global document -- the callback below runs in the page */
async function frameNames(f: Pick<Page, 'evaluate'>, bySelector: boolean, q: string): Promise<string[]> {
  return f.evaluate(({ bySelector, q }) => {
    const name = (el: Element) => `${el.getAttribute('aria-label') ?? ''} ${(el.textContent ?? '').trim()} ${(el as HTMLInputElement).value ?? ''}`;
    if (bySelector) { const el = document.querySelector(q); return el ? [name(el)] : []; }
    const lower = q.toLowerCase();
    return [...document.querySelectorAll('button, [role="button"], a[href], [role="link"], [role="menuitem"], [role="tab"]')]
      .map(name).filter(n => n.toLowerCase().includes(lower));
  }, { bySelector, q }).catch(() => [] as string[]);
}

/** Screen text, quoted the house way: the result classifier never reads it as clawdcursor's own words. */
const quote = (s: string) => quoteScreenText(s.replace(/\s+/g, ' ').trim().slice(0, 60));
const labelled = (s: unknown) => typeof s === 'string' && LABEL.test(s);
/** One verb for every way of pressing: an invoke's ladder and its bounds click are one act, asked once. */
const press = (label: string) => ({ what: `click ${quote(label)}` });

async function clickAt(x: unknown, y: unknown) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const label = await labelAt(x, y);
  return labelled(label) ? press(label) : null;
}

/** What the act would do in a few words (and where, when the act names it), when it is one confirm mode holds; null otherwise. */
async function consequential(method: string, args: unknown[], held: string[], target?: object): Promise<{ what: string; where?: string } | null> {
  const a = args[0] as Record<string, unknown> | string | undefined;
  const o = (typeof a === 'object' && a) || {};
  const typed = (text: unknown) => typedCombo(text, held) ? { what: `type ${quote(String(text))} with ${quote(held.join('+'))} held` } : null;
  switch (method) {
    case 'mouseClick': case 'mouseDoubleClick': return clickAt(args[0], args[1]);
    case 'executeMouseAction': return o.kind === 'click' || o.kind === 'double_click' ? clickAt(o.x, o.y) : null;
    case 'keyPress': case 'keyDown': case 'pressKey': return consequentialCombo(a, held) ? { what: `press ${quote(String(a))}` } : null;
    case 'typeText': return typed(a);
    case 'executeKeyboardAction':
      if (o.kind === 'type') return typed(o.text);
      return o.kind === 'key_press' && consequentialCombo(o.key, held) ? { what: `press ${quote(String(o.key))}` } : null;
    // Reading, filling or opening an element is not the act; pressing, toggling or picking it is.
    case 'invokeElement': {
      if (!['click', 'toggle', 'select', undefined].includes(o.action as string)) return null;
      const label = [o.name, ...await namesFor(target, o)].find(labelled);
      return label ? press(label as string) : null;
    }
    case 'click': case 'clickByText': {
      const page = (target as { getPage?: () => Page | null } | undefined)?.getPage?.() ?? null;
      const label = [a, ...(page ? await pageNames(page, method === 'click', String(a)) : [])].find(labelled);
      return label ? { ...press(label as string), where: page ? await page.title().catch(() => undefined) : undefined } : null;
    }
    case 'setWindowState': {
      const q = (args[1] ?? {}) as { title?: string; processName?: string };
      return a === 'close' ? { what: 'close the window', where: q.title ?? q.processName } : null;
    }
    default: return null;
  }
}

/** Resumes the user gave on a confirm card: card key → expiry, and whether one use spends it. */
const approved = new Map<string, { until: number; once: boolean }>();
const granted = (r: PauseResult) => r.outcome === 'resumed' && !r.detected && r.pill === true;

/**
 * Called by the input layer before an act, only while confirm mode is on. `target` is the object whose method acts (to
 * find what a by-name act reaches). Returns when the act may go; throws (nothing is sent) when the user has not let it through.
 */
export async function confirmBefore(method: string, args: unknown[], held: string[], target?: object): Promise<void> {
  const act = await consequential(method, args, held, target);
  if (!act) return;
  const fg = act.where ? null : await foregroundNow();
  const where = act.where || fg?.title || fg?.appName || fg?.processName;
  const what = where ? `${act.what} in ${quote(where)}` : act.what;
  const message = `Confirm mode: the agent wants to ${what}. Resume lets it go ahead; End task stops it.`;
  // pause_for_user's own key for this message: the agent waits on this card by calling it with the same message.
  const key = `mcp:${message.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const ok = approved.get(key);
  approved.delete(key);
  if (ok && ok.until > Date.now()) {
    if (!ok.once) approved.set(key, ok);
    pauseGate.forget(key);
    return;
  }
  if (!pauseGate.available()) {
    throw new Error(`not confirmed: confirm mode is on but no on-screen prompt can ask the user (the overlay is off), so it will not ${what} — nothing was sent. Ask the user in your own chat; they can do this step themselves.`);
  }
  pauseGate.forget(key);   // an old answer to this question is never reused: the user is asked each time
  const queued = new AbortController();
  const asked = pauseGate.requestWithReply({ message, key }, { signal: queued.signal });
  // Registered before the race below, so it runs first: a Resume that comes after this call returned is kept for the retry.
  void asked.then(r => { if (granted(r)) approved.set(key, { until: Date.now() + APPROVAL_MS, once: true }); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([asked, new Promise<null>(res => { timer = setTimeout(() => res(null), WAIT_MS); timer.unref?.(); })]);
  clearTimeout(timer);
  if (r === null) {
    // Still queued behind another pause: never shown, so it is dropped rather than shown later (as pause_for_user).
    if (!pauseGate.continues(key)) queued.abort();
    else pauseGate.markWaiting(key);
    throw new Error(
      `held: confirm mode is on and a pause is waiting for the user on screen, asking whether to ${what} — nothing was sent. ` +
      `Keep waiting: call pause_for_user with the message after "Message:" below; when it returns resumed, repeat this same action once.\nMessage: ${message}`);
  }
  pauseGate.forget(key);
  if (granted(r)) { approved.set(key, { until: Date.now() + LADDER_MS, once: false }); return; }
  const why = r.outcome === 'replied' ? `typed instead: ${quoteScreenText(r.reply ?? r.choice ?? '')}`
    : r.outcome === 'ended' ? 'clicked End task'
    : r.outcome === 'timeout' ? 'did not answer'
    : 'did not click Resume on the pill (an AI resume, `clawdcursor resume` or POST /resume is not the user\'s click)';
  throw new Error(`not confirmed: confirm mode asked the user whether to ${what}, and they ${why} — nothing was sent. Do not retry it; follow the user.`);
}

/** For tests. */
export function __resetConfirmForTests(): void {
  approved.clear();
}
