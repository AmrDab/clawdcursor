/**
 * Rung R2 of the own-window ladder: a short foreground burst, only when R0 and R1 cannot do the step. Waits until the user
 * has been idle, saves their foreground window and cursor, focuses the target, runs the acts, puts both back. The user
 * always wins: input of theirs mid-burst ends it, and their window is then left alone.
 */
import type { WindowInfo } from './types';
import { unguarded } from './pointer-guard';

export interface BurstPlatform {
  getActiveWindow(): Promise<WindowInfo | null>;
  focusWindow(query: BurstTarget): Promise<boolean>;
  restoreForeground(handle: number): Promise<boolean>;
  /** `tick`: when the last input of ANY kind happened (ours too), `idleMs`: how long ago. Null when it cannot be read. */
  userIdle(): Promise<{ tick: number; idleMs: number } | null>;
  cursorPos(): Promise<{ x: number; y: number } | null>;
  mouseMove(x: number, y: number): Promise<void>;
}
export type BurstTarget = { processId?: number; handle?: number; processName?: string; title?: string };

/** How long the user must have been idle, how long to wait for that, and how often to look. Tests shorten the last two. */
export const burstTiming = { idleMs: 1000, maxWaitMs: 5000, pollMs: 200 };

let bursts = 0;
/** Foreground bursts run since the task began (the pill / status shows it). */
export const burstCount = (): number => bursts;
export const resetBurstCount = (): void => { bursts = 0; };

/** Told when a burst starts (true) and ends (false): the on-screen indicator goes full-screen for its length (banner.ts). */
let onBurst: ((start: boolean) => void) | null = null;
export function setOnBurst(f: ((start: boolean) => void) | null): void { onBurst = f; }
const announce = (start: boolean) => { try { onBurst?.(start); } catch { /* cosmetic */ } };

export interface Burst {
  /**
   * Run one of the burst's own inputs (every input of the burst goes through here: one that does not reads as the user's). Skipped (`done: false`, and the burst ends as yielded) when the user has typed, moved
   * the mouse or switched windows since the last act: GetLastInputInfo counts our synthetic input too, so the baseline is
   * taken again right after each act of ours.
   */
  act<R>(f: () => Promise<R>): Promise<{ done: true; value: R } | { done: false }>;
}
export type BurstResult<T> =
  /** restored: the user's window and cursor are verified back (false when they took over, `yielded`). */
  | { ran: true; value: T; yielded: boolean; restored: boolean }
  /** user-busy: never idle in time; no-focus: the target did not come to the front. Either way: R3, pause_for_user. */
  | { ran: false; reason: 'user-busy' | 'no-focus' };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const same = (w: WindowInfo | null, t: BurstTarget) =>
  !!w && ((t.handle !== undefined && Number(w.handle) === t.handle) || (t.processId !== undefined && (w.processId === t.processId || w.hostedProcessId === t.processId)));

export async function withForegroundBurst<T>(p: BurstPlatform, target: BurstTarget, fn: (b: Burst) => Promise<T>): Promise<BurstResult<T>> {
  const before = await p.getActiveWindow().catch(() => null);
  // The user is already in the agent's window: nothing to take, nothing to give back.
  if (same(before, target)) return { ran: true, value: await fn({ act: async f => ({ done: true, value: await f() }) }), yielded: false, restored: false };

  for (const until = Date.now() + burstTiming.maxWaitMs; ;) {
    const idle = await p.userIdle().catch(() => null);
    if (idle && idle.idleMs >= burstTiming.idleMs) break;
    if (!idle || Date.now() + burstTiming.pollMs > until) return { ran: false, reason: 'user-busy' };
    await sleep(burstTiming.pollMs);
  }
  const cursor = await p.cursorPos().catch(() => null);
  const focused = await p.focusWindow(target);
  const now = await p.getActiveWindow().catch(() => null);
  if (!focused || !same(now, target)) {
    // Something else may have come up: the user's window goes back if it is no longer in front.
    if (before?.handle && now && now.handle !== before.handle) await p.restoreForeground(Number(before.handle)).catch(() => false);
    return { ran: false, reason: 'no-focus' };
  }
  bursts++;
  announce(true);

  let base = (await p.userIdle().catch(() => null))?.tick;
  let yielded = false;
  const userActed = async () => {
    const now = (await p.userIdle().catch(() => null))?.tick;
    return (base !== undefined && now !== undefined && now !== base) || !same(await p.getActiveWindow().catch(() => null), target);
  };
  const burst: Burst = {
    async act(f) {
      if (yielded || await userActed()) { yielded = true; return { done: false }; }
      const value = await f();
      base = (await p.userIdle().catch(() => null))?.tick;
      return { done: true, value };
    },
  };
  let value: T;
  let restored = false;
  try { value = await fn(burst); } finally {
    if (!yielded) yielded = await userActed();
    // Not when the user took over: their window and mouse are theirs.
    if (!yielded) {
      restored = !before?.handle || await p.restoreForeground(Number(before.handle)).catch(() => false);
      if (cursor) await unguarded(() => p.mouseMove(cursor.x, cursor.y)).catch(() => { restored = false; });
    }
    announce(false);
  }
  return { ran: true, value, yielded, restored };
}
