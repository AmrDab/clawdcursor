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
 *    (a word of the name: "Send now", not "Sender"); by coordinates, the smallest named element under the point in the
 *    window in front;
 *  - a browser click whose selector or text has one of those words;
 *  - the keys alt+f4, mod+w, mod+q, mod+enter, shift+delete, also built from keys held with key_down;
 *  - closing a window.
 *
 * Only the user's Resume on the card lets it through ('resumed', never detected). End task, a typed reply, an AI's
 * resume_task ('resumed_unverified'), a timeout, or no card to show: nothing is sent. A Resume given after the held call
 * returned is kept for that same act for two minutes, once, so the agent's retry goes through without asking again.
 */
import { pauseGate, type PauseResult } from './pause-gate';
import { keysOf } from '../platform/hard-keys';
import { normalizeKey } from '../platform/keys';
import type { UiElement } from '../platform/types';
import { quoteScreenText } from './result-codes';

const LABEL = /\b(send|delete|remove|pay|buy|submit|close|discard)\b/i;
const COMBOS = ['alt+f4', 'mod+w', 'mod+q', 'mod+enter', 'shift+delete'];
/** Under common 60 s MCP client timeouts, as pause_for_user. */
const WAIT_MS = 45_000;
const APPROVAL_MS = 2 * 60_000;

const keySet = (combo: string, os: NodeJS.Platform) => keysOf(combo, os).map(k => normalizeKey(k).toLowerCase());

/** Does this key input (a chord, or a sequence of chords) press one of the held combos, with the keys already held down? */
export function consequentialCombo(combo: unknown, held: string[] = [], os: NodeJS.Platform = process.platform): boolean {
  const heldKeys = held.map(k => normalizeKey(k).toLowerCase());
  return String(combo ?? '').trim().split(/\s+/).filter(Boolean).some(chord => {
    const down = new Set([...heldKeys, ...keySet(chord, os)]);
    return COMBOS.some(c => keySet(c, os).every(k => down.has(k)));
  });
}

const nameOf = (e: UiElement) => (e.name || e.description || '').trim();

let readTree = async (): Promise<UiElement[]> => (await (await import('../platform')).getPlatform()).getUiTree();
export function __setTreeReaderForTests(f: (() => Promise<UiElement[]>) | null): void {
  readTree = f ?? (async () => (await (await import('../platform')).getPlatform()).getUiTree());
}

/** The name of the smallest named element under (x, y) in the window in front (screen coordinates, as clicks take them). */
async function labelAt(x: number, y: number): Promise<string> {
  const tree = await readTree().catch(() => [] as UiElement[]);
  const area = (e: UiElement) => e.bounds.width * e.bounds.height;
  const hit = tree
    .filter(e => nameOf(e) && e.bounds && area(e) > 0
      && x >= e.bounds.x && y >= e.bounds.y && x < e.bounds.x + e.bounds.width && y < e.bounds.y + e.bounds.height)
    .sort((a, b) => area(a) - area(b))[0];
  return hit ? nameOf(hit) : '';
}

/** Screen text, quoted the house way: the result classifier never reads it as clawdcursor's own words. */
const quote = (s: string) => quoteScreenText(s.replace(/\s+/g, ' ').trim().slice(0, 60));
const labelled = (s: unknown) => typeof s === 'string' && LABEL.test(s);

async function clickAt(x: unknown, y: unknown): Promise<string | null> {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const label = await labelAt(x, y);
  return labelled(label) ? `click ${quote(label)}` : null;
}

/** What the act would do, in a few words, when it is one confirm mode holds; null otherwise. */
async function consequential(method: string, args: unknown[], held: string[]): Promise<string | null> {
  const a = args[0] as Record<string, unknown> | string | undefined;
  const o = (typeof a === 'object' && a) || {};
  switch (method) {
    case 'mouseClick': case 'mouseDoubleClick': return clickAt(args[0], args[1]);
    case 'executeMouseAction': return o.kind === 'click' || o.kind === 'double_click' ? clickAt(o.x, o.y) : null;
    case 'keyPress': case 'keyDown': case 'pressKey': return consequentialCombo(a, held) ? `press ${quote(String(a))}` : null;
    case 'executeKeyboardAction': return o.kind === 'key_press' && consequentialCombo(o.key, held) ? `press ${quote(String(o.key))}` : null;
    // Reading, filling or opening an element is not the act; pressing, toggling or picking it is.
    case 'invokeElement': return ['click', 'toggle', 'select', undefined].includes(o.action as string) && labelled(o.name) ? `${(o.action as string) ?? 'click'} ${quote(String(o.name))}` : null;
    case 'click': case 'clickByText': return labelled(a) ? `click ${quote(String(a))} in the browser` : null;
    case 'setWindowState': return a === 'close' ? 'close a window' : null;
    default: return null;
  }
}

/** Resumes the user gave on a confirm card after its call had returned: card key → expiry. One use each. */
const approved = new Map<string, number>();
const granted = (r: PauseResult) => r.outcome === 'resumed' && !r.detected;

/**
 * Called by the input layer before an act, only while confirm mode is on. Returns when the act may go; throws (nothing is
 * sent) when the user has not let it through.
 */
export async function confirmBefore(method: string, args: unknown[], held: string[]): Promise<void> {
  const what = await consequential(method, args, held);
  if (!what) return;
  const message = `Confirm mode: the agent wants to ${what}. Resume lets it go ahead; End task stops it.`;
  // pause_for_user's own key for this message: the agent waits on this card by calling it with the same message.
  const key = `mcp:${message.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const until = approved.get(key);
  approved.delete(key);
  if (until !== undefined && until > Date.now()) { pauseGate.forget(key); return; }
  if (!pauseGate.available()) {
    throw new Error(`not confirmed: confirm mode is on but no on-screen prompt can ask the user (the overlay is off), so it will not ${what} — nothing was sent. Ask the user in your own chat; they can do this step themselves.`);
  }
  pauseGate.forget(key);   // an old answer to this question is never reused: the user is asked each time
  const queued = new AbortController();
  const asked = pauseGate.requestWithReply({ message, key }, { signal: queued.signal });
  // Registered before the race below, so it runs first: a Resume that comes after this call returned is kept for the retry.
  void asked.then(r => { if (granted(r)) approved.set(key, Date.now() + APPROVAL_MS); });
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
  if (granted(r)) { approved.delete(key); return; }
  const why = r.outcome === 'replied' ? `typed instead: ${quoteScreenText(r.reply ?? r.choice ?? '')}`
    : r.outcome === 'ended' ? 'clicked End task'
    : r.outcome === 'timeout' ? 'did not answer'
    : 'did not click Resume (an AI resume is not the user\'s answer)';
  throw new Error(`not confirmed: confirm mode asked the user whether to ${what}, and they ${why} — nothing was sent. Do not retry it; follow the user.`);
}

/** For tests. */
export function __resetConfirmForTests(): void {
  approved.clear();
}
