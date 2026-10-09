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

/**
 * Read the UI tree; if it is thin, wake the app and keep re-reading (up to the
 * budget) until it fills in, returning the richest read. At most one wait per
 * process per cooldown.
 */
export async function getUiTreeWithWake(
  platform: Pick<PlatformAdapter, 'getUiTree' | 'getActiveWindow'>,
  pid?: number,
  opts: { pollMs?: number; budgetMs?: number; now?: () => number } = {},
): Promise<WokenTree> {
  const first = await platform.getUiTree(pid);
  if (first.length >= SPARSE_TREE_MAX) return { tree: first, woke: false };

  const envBudget = Number(process.env.CLAWDCURSOR_WAKE_BUDGET_MS);
  const budgetMs = opts.budgetMs ?? (Number.isFinite(envBudget) && process.env.CLAWDCURSOR_WAKE_BUDGET_MS !== undefined ? envBudget : WAKE_BUDGET_MS);
  if (budgetMs <= 0) return { tree: first, woke: false };

  const target = pid ?? (await platform.getActiveWindow().catch(() => null))?.processId;
  const key = target ?? UNKNOWN_PID;
  const now = (opts.now ?? Date.now)();
  const prev = lastTry.get(key);
  if (prev !== undefined && now - prev < RETRY_COOLDOWN_MS) return { tree: first, woke: false };
  lastTry.set(key, now);

  await wakeAccessibility(target);
  const pollMs = opts.pollMs ?? WAKE_POLL_MS;
  // A fixed number of polls, so the wait is ~budget (plus read time), not budget + a poll.
  const polls = Math.max(1, Math.floor(budgetMs / Math.max(pollMs, 1)));
  let best = first;
  for (let i = 0; i < polls; i++) {
    await new Promise(r => setTimeout(r, pollMs));
    const next = await platform.getUiTree(pid).catch(() => best);
    if (next.length > best.length) best = next;
    if (best.length >= SPARSE_TREE_MAX) break;
  }
  return best.length > first.length ? { tree: best, woke: true } : { tree: first, woke: false };
}

/** Test hook. */
export function resetWakeState(): void { lastTry.clear(); }
