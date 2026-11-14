/**
 * Diff-and-poll helper for `launchApp` across platforms.
 *
 *   On Windows 11, modern UWP apps (Calculator, Photos, Edge, Settings, etc.)
 *   take 2–6 seconds to surface a window in the a11y tree on a cold start.
 *   A single 800ms scan missed them, returned `{}`, and the agent saw
 *   "Launched X (no window surfaced yet)" — so it fell back to keyboard
 *   shortcuts (`win+r`, `cmd+space`, `win+d`, etc.), a slower and less reliable
 *   route than waiting for the window.
 *
 * Properties:
 *   - **OS-agnostic.** Operates on the abstract `WindowInfo` shape; no
 *     win32 / AppKit / X11 specifics.
 *   - **App-agnostic.** No allowlist of known apps. The predicate is supplied
 *     by the caller (an identity match — see `buildAppPredicate`).
 */

import type { WindowInfo } from './types';
import { appIdentity, ownsWindow, type AppIdentityHints } from './app-identity';
import { sleep } from '../core/sleep';

/**
 * How often the diff-and-poll loop re-checks `listWindows()`.
 */
const DEFAULT_POLL_INTERVAL_MS = 300;

/**
 * Total budget the loop will wait for a matching window to surface.
 * Tuned for cold-start UWP apps;
 * warm classic Win32 apps usually return in the first 1–2 ticks.
 */
const DEFAULT_LAUNCH_TIMEOUT_MS = 8_000;

export interface LaunchPollOpts {
  /** Override the poll tick. Default 300ms. */
  intervalMs?: number;
  /** Override the total budget. Default 8s. */
  timeoutMs?: number;
  /**
   * If the launch primitive returned a PID (e.g. `child.pid` from `spawn`),
   * pass it here. The loop will accept that PID's window even if its name /
   * title hasn't decorated yet. Optional — `undefined` means rely solely on
   * the predicate (which is the case for Windows `Start-Process` and macOS
   * `open -a`, where the parent we spawn is *not* the target app).
   */
  spawnPid?: number;
}

/**
 * Predicate used to decide whether a `WindowInfo` belongs to the app we just
 * launched. See `buildAppPredicate`.
 */
export type AppPredicate = (w: WindowInfo) => boolean;

/**
 * Wait for a matching window to surface after a launch.
 *
 * Algorithm:
 *   1. Compute a stable id for each window in `windowsBefore`. Use `handle`
 *      when available (Win32 HWND / X11 XID), fall back to `pid:N` so macOS
 *      adapters that don't surface a handle still work.
 *   2. Poll `listWindows()` every `intervalMs` until `timeoutMs` elapses.
 *   3. On each tick, prefer the FIRST window that:
 *        a) is not minimized,
 *        b) is NOT in the before-set (genuinely new),
 *        c) and matches the predicate (or the spawn PID, if given).
 *      If none, remember the BEST already-existing match (e.g. an instance
 *      that was running but minimized when we snapshotted) and keep going.
 *   4. On timeout, return the remembered best match or `null`.
 *
 * Returning the "remembered best" handles two real cases:
 *   - macOS `open -a` activates an existing app rather than spawning a new
 *     window. The before-set already includes the app's minimized window;
 *     after activation it's restored but its id is unchanged.
 *   - Windows / Linux app already-running idempotency check — `launchApp`
 *     short-circuits earlier when an existing window is found, so this only
 *     fires for `alwaysNewInstance` or post-spawn-restore cases.
 *
 * Robustness: a `listWindows()` exception inside a tick is swallowed and the
 * loop continues. This matches the existing adapter behavior — a transient
 * UIA bridge hiccup must not poison the launch result.
 */
export async function waitForLaunchedWindow(
  windowsBefore: readonly WindowInfo[],
  listWindows: () => Promise<readonly WindowInfo[]>,
  predicate: AppPredicate,
  opts: LaunchPollOpts = {},
): Promise<WindowInfo | null> {
  const interval = Math.max(50, opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const budget = Math.max(interval, opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  const deadline = Date.now() + budget;

  const idOf = (w: WindowInfo): string =>
    w.handle !== undefined ? String(w.handle) : `pid:${w.processId}`;

  const beforeIds = new Set(windowsBefore.map(idOf));

  let lastSeenAnyMatch: WindowInfo | null = null;

  while (Date.now() < deadline) {
    await sleep(interval);

    // The read is bounded by what is left of the budget: an app that is starting can block the accessibility read
    // for many seconds (live: an 8 s wait took 39 s), and a wait that does not end is worse than "not yet".
    const read = await within(listWindows(), Math.max(0, deadline - Date.now()));
    if (read === TIMED_OUT) break;
    if (read === null) continue;
    const current = read;

    let pidNew: WindowInfo | null = null;
    let predNew: WindowInfo | null = null;
    // A new window with NO owning pid (X11 without _NET_WM_PID — xcalc) can
    // match neither the spawn pid nor, when its title differs from the launch
    // name, the predicate. Having appeared since the launch, it is ours.
    // Only when we spawned something and exactly ONE such window appeared — a
    // pid-less popup or notification must not pass for the launched app.
    const unownedNews: WindowInfo[] = [];
    for (const w of current) {
      if (w.isMinimized) continue;
      if (beforeIds.has(idOf(w))) continue;
      if (opts.spawnPid && w.processId === opts.spawnPid) {
        pidNew = w;
        break;
      }
      if (!predNew && predicate(w)) {
        predNew = w;
      }
      if (!w.processId) unownedNews.push(w);
    }
    if (pidNew) return pidNew;
    if (predNew) return predNew;
    if (opts.spawnPid && unownedNews.length === 1) return unownedNews[0];

    if (opts.spawnPid) {
      const pidAny = current.find(w => !w.isMinimized && w.processId === opts.spawnPid);
      if (pidAny) {
        lastSeenAnyMatch = pidAny;
        continue;
      }
    }
    if (!lastSeenAnyMatch) {
      const predAny = current.find(w => !w.isMinimized && predicate(w));
      if (predAny) lastSeenAnyMatch = predAny;
    }
  }

  return lastSeenAnyMatch;
}

/**
 * The "this window belongs to the launched app" predicate: by identity only (app-identity.ts) — the window's process
 * name equals the launch name (extension dropped) or one of the app's known process names; on Windows also its
 * package family, or the exact display-name title of a window the UWP frame host owns. Never a substring of the
 * process name or of the title: a title is whatever a document, a web page or a mail subject says.
 */
export function buildAppPredicate(name: string, hints?: AppIdentityHints): AppPredicate {
  const identity = appIdentity(name, hints);
  return (w: WindowInfo): boolean => ownsWindow(identity, w);
}

/** `within` ran out of time. */
export const TIMED_OUT = Symbol('timed out');

/**
 * `p`, or TIMED_OUT after `ms` — the read itself is abandoned, not cancelled. null when `p` rejects. For reads that
 * may hang on an app that is starting: a launch wait has a budget, and it must end with it.
 */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null | typeof TIMED_OUT> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}
