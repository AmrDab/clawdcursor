/**
 * Rung R2 of the own-window ladder: a short foreground burst, only when R0 and R1 cannot do the step. Waits until the user
 * is idle, saves their foreground window and cursor, focuses the target, runs the acts, puts both back. The user always
 * wins: input of theirs mid-burst PAUSES it (their window and cursor come back at once, the step stops) and it is their
 * turn (core/control.ts takeover): idle again after 5 s, the step is run again from the start with the target re-focused;
 * still working, it is held until they click Resume on the pill. Never fought for the foreground.
 */
import { AsyncLocalStorage } from 'async_hooks';
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

/**
 * The user's turn, one rule for every input (core/control.ts, which registers it): `idle` — is the user idle now (their
 * input, not ours); `takeover` — they took over: resolves when the step may go on, throws (held until their Resume, or
 * stopped) when it may not. With none registered, nothing waits.
 */
export interface UserTurns { idle(): Promise<boolean>; takeover(): Promise<void> }
let turns: UserTurns = { idle: async () => true, takeover: async () => undefined };
export function setUserTurns(t: UserTurns): void { turns = t; }

const inBurst = new AsyncLocalStorage<true>();
/**
 * This call is inside a burst: its inputs keep the user's turn themselves, so the input guard does not wait for idle
 * again. Per call (async context), never process-wide: another call running meanwhile still waits for the user.
 */
export const inForegroundBurst = (): boolean => inBurst.getStore() === true;

let bursts = 0;
/** Foreground bursts run since the task began (the pill / status shows it). */
export const burstCount = (): number => bursts;
export const resetBurstCount = (): void => { bursts = 0; };

/** Told when a burst starts, pauses for the user, resumes, and ends: the indicator goes full-screen for its length (banner.ts). */
export type BurstEvent = 'start' | 'pause' | 'resume' | 'end';
let onBurst: ((e: BurstEvent) => void) | null = null;
export function setOnBurst(f: ((e: BurstEvent) => void) | null): void { onBurst = f; }
const announce = (e: BurstEvent) => { try { onBurst?.(e); } catch { /* cosmetic */ } };

export interface Burst {
  /**
   * Run one of the burst's own inputs (every input of the burst goes through here: one that does not reads as the user's).
   * Skipped (`done: false`) when the user has typed, moved the mouse or switched windows since the last act: GetLastInputInfo
   * counts our synthetic input too, so the baseline is taken again right after each act of ours. The caller then returns
   * at once; it is the user's turn, and the burst calls `fn` AGAIN once it is the agent's again, so `fn` must be safe to
   * run again from the start (whole-value, idempotent steps).
   */
  act<R>(f: () => Promise<R>): Promise<{ done: true; value: R } | { done: false }>;
}
export type BurstResult<T> =
  /** restored: the user's window and cursor are verified back (false when they took over, `yielded`). */
  | { ran: true; value: T; yielded: boolean; restored: boolean }
  /**
   * no-focus: the target did not come to the front; target-changed: paused, and the target window is gone or no longer
   * the same one; no-replay: paused during a step that is not safe to run again (a fixed-coordinate click), so it is not
   * redone. Either way: R3, and the user's window and cursor are theirs. (A user who keeps working is not a result: the
   * takeover throws the held waiting reply, and the agent calls the step again.)
   */
  | { ran: false; reason: 'no-focus' | 'target-changed' | 'no-replay' };

const same = (w: WindowInfo | null, t: BurstTarget) =>
  !!w && ((t.handle !== undefined && Number(w.handle) === t.handle) || (t.processId !== undefined && (w.processId === t.processId || w.hostedProcessId === t.processId)));

export async function withForegroundBurst<T>(p: BurstPlatform, target: BurstTarget, fn: (b: Burst) => Promise<T>, opts: { replay?: boolean } = {}): Promise<BurstResult<T>> {
  // replay (default true): the step is whole-value and safe to run again from the start on resume. A step that is NOT —
  // a fixed-coordinate click, whose coordinates may be stale after the user scrolled — passes false: an interruption
  // goes straight to R3 instead of re-clicking a point that no longer means what it did.
  const replay = opts.replay !== false;
  let before = await p.getActiveWindow().catch(() => null);
  // The user is already in the agent's window: nothing to take, nothing to give back.
  if (same(before, target)) return { ran: true, value: await fn({ act: async f => ({ done: true, value: await f() }) }), yielded: false, restored: false };

  // The user is at the keyboard: their turn first. Throws while they hold it; nothing has been taken.
  if (!await turns.idle()) {
    await turns.takeover();
    before = await p.getActiveWindow().catch(() => null);   // they may have moved to another window meanwhile
  }
  return inBurst.run(true, () => burstRun(p, target, fn, replay, before));
}

async function burstRun<T>(p: BurstPlatform, target: BurstTarget, fn: (b: Burst) => Promise<T>, replay: boolean, before: WindowInfo | null): Promise<BurstResult<T>> {
  let cursor = await p.cursorPos().catch(() => null);
  const focused = await p.focusWindow(target);
  const now = await p.getActiveWindow().catch(() => null);
  if (!focused || !same(now, target)) {
    // Something else may have come up: the user's window goes back if it is no longer in front.
    if (before?.handle && now && now.handle !== before.handle) await p.restoreForeground(Number(before.handle)).catch(() => false);
    return { ran: false, reason: 'no-focus' };
  }
  bursts++;
  announce('start');
  const targetHandle = now?.handle ? Number(now.handle) : undefined;

  let base = (await p.userIdle().catch(() => null))?.tick;
  let yielded = false;
  let skipped = false; // an act was refused: the step did not finish
  let ownCursor = cursor;
  const userActed = async () => {
    const now = (await p.userIdle().catch(() => null))?.tick;
    return (base !== undefined && now !== undefined && now !== base) || !same(await p.getActiveWindow().catch(() => null), target);
  };
  const burst: Burst = {
    async act(f) {
      if (skipped) return { done: false };
      if (yielded || await userActed()) {
        yielded = skipped = true;
        announce('pause');
        // Their input must land where they expect: their window goes back if ours is still in front, and the mouse if it is
        // still where our last act left it (a moved mouse is theirs).
        if (same(await p.getActiveWindow().catch(() => null), target)) {
          if (before?.handle) await p.restoreForeground(Number(before.handle)).catch(() => false);
          const c = await p.cursorPos().catch(() => null);
          const back = cursor;   // a const for the closure: `cursor` is reassigned on resume
          if (back && c && ownCursor && c.x === ownCursor.x && c.y === ownCursor.y) await unguarded(() => p.mouseMove(back.x, back.y)).catch(() => undefined);
        }
        return { done: false };
      }
      const value = await f();
      base = (await p.userIdle().catch(() => null))?.tick;
      ownCursor = await p.cursorPos().catch(() => null);
      return { done: true, value };
    },
  };
  /**
   * Paused: the user's turn (takeover: after 5 s, idle → go on; still working → held until their Resume, which throws the
   * waiting reply meanwhile), then re-focus the same target. Null: resumed; else why not.
   */
  const settle = async (): Promise<'target-changed' | null> => {
    await turns.takeover();
    const usersNow = await p.getActiveWindow().catch(() => null);
    const cursorNow = await p.cursorPos().catch(() => null);
    const focused = await p.focusWindow(target).catch(() => false);
    const w = await p.getActiveWindow().catch(() => null);
    if (!focused || !same(w, target) || (targetHandle !== undefined && Number(w?.handle) !== targetHandle)) {
      // Gone or another window: whatever came up, the user's window goes back.
      if (usersNow?.handle && w && w.handle !== usersNow.handle) await p.restoreForeground(Number(usersNow.handle)).catch(() => false);
      return 'target-changed';
    }
    // The user may have moved to another window during the pause: restore to where they WERE at this resume, not to the
    // window and cursor from the first burst start.
    before = usersNow;
    cursor = cursorNow;
    return null;
  };
  let value: T;
  let restored = false;
  let gaveUp: 'target-changed' | 'no-replay' | null = null;
  try {
    for (; ;) {
      value = await fn(burst);
      if (!skipped) break;
      // A step that is not safe to run again (a fixed-coordinate click) is not redone: the user already has their window.
      if (!replay) { gaveUp = 'no-replay'; break; }
      gaveUp = await settle();
      if (gaveUp) break;
      base = (await p.userIdle().catch(() => null))?.tick;
      ownCursor = await p.cursorPos().catch(() => null);
      skipped = yielded = false;
      announce('resume');
    }
  } finally {
    if (!yielded) yielded = await userActed();
    // Not when the user took over: their window and mouse are theirs.
    if (!yielded) {
      restored = !before?.handle || await p.restoreForeground(Number(before.handle)).catch(() => false);
      const c = cursor;   // a const for the closure: `cursor` is reassigned on resume
      if (c) await unguarded(() => p.mouseMove(c.x, c.y)).catch(() => { restored = false; });
    }
    announce('end');
  }
  if (gaveUp) return { ran: false, reason: gaveUp };
  return { ran: true, value: value!, yielded, restored };
}
