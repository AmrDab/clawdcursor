/**
 * Diff-and-poll helper for `launchApp` across platforms.
 *
 * Background — what this fixes:
 *
 *   Before this helper, every platform adapter's `launchApp` did:
 *     1. spawn the launch primitive (Start-Process / open -a / xdg-open / …)
 *     2. `await delay(800ms)` — single fixed settle
 *     3. `await listWindows()` once and pick the best name match
 *     4. return `{ pid, title }` or `{}` if nothing matched
 *
 *   On Windows 11, modern UWP apps (Calculator, Photos, Edge, Settings, etc.)
 *   take 2–6 seconds to surface a window in the a11y tree on a cold start.
 *   The 800ms scan misses them, returns `{}`, and the agent sees
 *   "Launched X (no window surfaced yet)" — so it falls back to keyboard
 *   shortcuts. Most of those shortcuts (`win+r`, `cmd+space`, `win+d`, etc.)
 *   are blocked by the safety layer for good reasons, so the agent gets stuck.
 *
 *   The router (`src/core/router/router.ts`) already had the right pattern
 *   for its zero-LLM fast path — diff before/after, poll for a NEW window —
 *   but the platform adapter ignored it. This module exists so all three
 *   adapters can use the same proven pattern; the agent's `open_app` tool
 *   (and any other caller of `launchApp`) gets the reliability for free.
 *
 * Properties:
 *   - **OS-agnostic.** Operates on the abstract `WindowInfo` shape; no
 *     win32 / AppKit / X11 specifics.
 *   - **App-agnostic.** No allowlist of known apps. The predicate is supplied
 *     by the caller (typically a name/title substring match).
 *   - **Model-agnostic.** No prompt or LLM coupling — pure async function.
 *   - **MCP-safe.** No tool signature change. Callers' return contracts are
 *     unchanged; only the latency-to-truth improves.
 */

import type { WindowInfo } from './types';

/**
 * How often the diff-and-poll loop re-checks `listWindows()`.
 * Mirrors `READY_POLL_INTERVAL_MS` in the router so behavior is consistent.
 */
const DEFAULT_POLL_INTERVAL_MS = 300;

/**
 * Total budget the loop will wait for a matching window to surface.
 * Mirrors `READY_TIMEOUT_MS` in the router. Tuned for cold-start UWP apps;
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
 * launched. Implementations typically do a case-insensitive match against
 * `processName` and `title`.
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

    let current: readonly WindowInfo[];
    try {
      current = await listWindows();
    } catch {
      continue;
    }

    // Pass 1: prefer brand-new windows. PID match wins (most reliable),
    // then predicate match.
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

    // Pass 2: remember the best already-existing match for the timeout
    // fallback. Prefer PID, then predicate.
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
 * Build the standard "matches the launched app" predicate. Mirrors the
 * heuristic each adapter previously used inline, with one extra rule:
 *
 *   1. exact `processName` match (case-insensitive)
 *   2. `processName` substring match
 *   3. reverse — target contains `processName` (handles `msedge.exe` ↔
 *      processName `msedge`, `firefox.exe` ↔ `firefox`, `Calculator.app` ↔
 *      `Calculator`). The reverse leg is gated by a 3-character minimum
 *      on `processName` so unrelated 1–2-char proc names ("ps", "ai")
 *      don't sweep everything in.
 *   4. `title` substring match
 *
 * App-agnostic — caller passes whatever name the user / agent / alias
 * resolver provided. OS-agnostic — operates only on the abstract
 * `WindowInfo` shape.
 */
export function buildAppPredicate(name: string): AppPredicate {
  const target = name.trim().toLowerCase();
  if (!target) return () => false;
  // Strip a trailing `.exe` / `.com` / `.app` so a launchName like
  // "msedge.exe" still matches a `processName` of "msedge". This is the
  // single OS-agnostic, app-agnostic translation needed: launchers want
  // file-system names, window enumerators give back stripped process names.
  const stem = target.replace(/\.(exe|com|app)$/, '');
  return (w: WindowInfo): boolean => {
    const proc = w.processName.toLowerCase();
    if (proc === target) return true;
    if (proc === stem) return true;
    if (proc.includes(target)) return true;
    if (proc.includes(stem)) return true;
    if (proc.length >= 3 && (target.includes(proc) || stem.includes(proc))) {
      return true;
    }
    const title = w.title.toLowerCase();
    return title.includes(target) || title.includes(stem);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
