/**
 * A thin accessibility tree is often a SLEEPING one, not an empty one.
 *
 * Chromium / Electron apps build their page tree only after an accessibility
 * client asks for it, and it arrives ~1.5-2.5 s later. Measured on Windows with
 * a plain Electron window: reads at +0.4 s, +1.0 s and +1.4 s returned 6
 * elements and none of the page (heading, button, field, list); from +2.6 s on
 * every read returned 14 with all of it. An agent that stops at the first
 * answer concludes "no accessibility here" and falls back to screenshots — the
 * opposite of blind-first.
 *
 * So when a read comes back thin, wake the app (macOS: set the per-app
 * AXManualAccessibility attribute, the documented switch for Electron;
 * Windows / Linux: the read itself is the wake-up) and keep reading for a few
 * seconds until the tree fills in.
 *
 * A browser is not "thin" when its page is asleep: its own UI (tab strip,
 * toolbar, address bar) is ~59 elements on macOS Chrome (#234). So for a
 * browser the page counts too — no web area (Document) with anything inside
 * it is a missing page, and wakes the same way.
 *
 * Not everything wakes this way: Chromium on Linux exposes its page only when
 * launched with --force-renderer-accessibility (switching AT-SPI on afterwards,
 * or even before launch, did not help in testing) — callers say so in the hint.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { getPackageRoot } from '../paths';
import type { PlatformAdapter, UiElement } from './types';

const execFileAsync = promisify(execFile);

/** A tree with fewer elements than this is "thin": probably asleep or a canvas app. */
export const SPARSE_TREE_MAX = 10;
/** Pause between re-reads while waiting for the tree to fill in. */
export const WAKE_POLL_MS = 700;
/** Give up after about this long: a genuinely sparse app (canvas, game) stays sparse.
 *  CLAWDCURSOR_WAKE_BUDGET_MS overrides it (0 turns the wait off). */
export const WAKE_BUDGET_MS = 3000;
/** Don't wait on the same process again for this long (the wait is only paid by thin apps). */
const RETRY_COOLDOWN_MS = 5 * 60_000;

/** Cooldown key when the app's process id is unknown — still rate-limited, never waits on every read. */
const UNKNOWN_PID = -1;
const lastTry = new Map<number, number>();
const MAC_ENABLE_SCRIPT = path.join(getPackageRoot(), 'scripts', 'mac', 'enable-accessibility.jxa');

/** Switch the app's accessibility on, where the OS has an explicit switch (macOS). Never throws. */
export async function wakeAccessibility(pid: number | undefined, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin' || !pid) return;
  try {
    await execFileAsync('osascript', ['-l', 'JavaScript', MAC_ENABLE_SCRIPT, String(pid)], { timeout: 5000 });
  } catch { /* best effort: the re-read still runs */ }
}

export interface WokenTree {
  tree: UiElement[];
  /** True when the first read was thin and a later read returned more. */
  woke: boolean;
}

const hasArea = (el: UiElement) => el.bounds.width > 0 && el.bounds.height > 0;

/**
 * Does the tree hold a web page: a web area (Document) with at least one other
 * element inside it? The tree is flat, so "inside" is by position.
 */
export function hasWebContent(tree: UiElement[]): boolean {
  const docs = tree.filter(el => el.controlType === 'Document' && hasArea(el));
  if (!docs.length) return false;
  return tree.some(el => {
    if (el.controlType === 'Document' || !hasArea(el)) return false;
    const cx = el.bounds.x + el.bounds.width / 2;
    const cy = el.bounds.y + el.bounds.height / 2;
    return docs.some(d => cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width
      && cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height);
  });
}

/**
 * Read the UI tree; if it is thin — or, for a browser, its page is missing —
 * wake the app and keep re-reading (up to the budget) until it fills in,
 * returning the richest read. At most one wait per process per cooldown.
 *
 * `isBrowser` says whether the target is a web browser; it is asked only when
 * the answer matters (the tree has no web content).
 */
export async function getUiTreeWithWake(
  platform: Pick<PlatformAdapter, 'getUiTree' | 'getActiveWindow'>,
  pid?: number,
  opts: { pollMs?: number; budgetMs?: number; now?: () => number; isBrowser?: () => boolean | Promise<boolean> } = {},
): Promise<WokenTree> {
  const first = await platform.getUiTree(pid);
  const askBrowser = async () => {
    if (!opts.isBrowser || hasWebContent(first)) return false;
    try { return await opts.isBrowser(); } catch { return false; }
  };
  let browser = false;
  if (first.length >= SPARSE_TREE_MAX) {
    browser = await askBrowser();
    if (!browser) return { tree: first, woke: false };
  }

  const envBudget = Number(process.env.CLAWDCURSOR_WAKE_BUDGET_MS);
  const budgetMs = opts.budgetMs ?? (Number.isFinite(envBudget) && process.env.CLAWDCURSOR_WAKE_BUDGET_MS !== undefined ? envBudget : WAKE_BUDGET_MS);
  if (budgetMs <= 0) return { tree: first, woke: false };

  const target = pid ?? (await platform.getActiveWindow().catch(() => null))?.processId;
  const key = target ?? UNKNOWN_PID;
  const now = (opts.now ?? Date.now)();
  const prev = lastTry.get(key);
  if (prev !== undefined && now - prev < RETRY_COOLDOWN_MS) return { tree: first, woke: false };
  lastTry.set(key, now);
  if (first.length < SPARSE_TREE_MAX) browser = await askBrowser();

  // A browser's read is better when it has the page; otherwise more is better.
  const better = (a: UiElement[], b: UiElement[]) => {
    if (browser && hasWebContent(a) !== hasWebContent(b)) return hasWebContent(a);
    return a.length > b.length;
  };
  const filled = (t: UiElement[]) => t.length >= SPARSE_TREE_MAX && (!browser || hasWebContent(t));

  await wakeAccessibility(target);
  const pollMs = opts.pollMs ?? WAKE_POLL_MS;
  const nowFn = opts.now ?? Date.now;
  // A fixed number of polls, so the wait is ~budget, not budget + a poll — and a
  // wall-clock bound, so slow reads count against the budget too: on macOS a
  // System Events walk of a Chromium app takes ~10 s, which turned "3 s" into
  // 41 s. One re-read is always attempted, so the wake gets its chance.
  const polls = Math.max(1, Math.floor(budgetMs / Math.max(pollMs, 1)));
  const started = nowFn();
  let best = first;
  for (let i = 0; i < polls; i++) {
    if (i > 0 && nowFn() - started >= budgetMs) break;
    await new Promise(r => setTimeout(r, pollMs));
    const next = await platform.getUiTree(pid).catch(() => best);
    if (better(next, best)) best = next;
    if (filled(best)) break;
  }
  return best !== first ? { tree: best, woke: true } : { tree: first, woke: false };
}

/** Test hook. */
export function resetWakeState(): void { lastTry.clear(); }
