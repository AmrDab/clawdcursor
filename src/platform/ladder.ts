/**
 * One ladder for a step that by-name access (R0) could not do, in one place (own-window plan):
 *   R1  input addressed to the window (deliverToWindow): native controls, no focus, no cursor. Only where a step offers it.
 *   R2  a foreground burst (foreground-burst.ts): the user idle, their window and cursor put back.
 *   R3  the user: `why` says so; the tool result tells the agent to pause_for_user.
 * Every result names the rung and whether focus moved (`noteRoute`, which the tool result carries). A platform without the
 * Windows pieces keeps today's path: bring the window to the front, then act.
 */
import type { PlatformAdapter, DeliverInput } from './types';
import { withForegroundBurst, burstCount, type BurstPlatform } from './foreground-burst';
import { ensureInFront } from './prefer-control';

export type LadderPlatform = Pick<PlatformAdapter, 'getActiveWindow' | 'focusWindow'>
  & Partial<Pick<PlatformAdapter, 'deliverToWindow' | 'restoreForeground' | 'userIdle' | 'cursorPos' | 'mouseMove' | 'noteRoute'>>;

/** Runs one input of an R2 step. Inside a burst it throws `Yielded` when the user has taken over; elsewhere it just runs. */
export type Act = <R>(f: () => Promise<R>) => Promise<R>;
class Yielded extends Error {}

export type LadderResult<T> = { rung: 'R1' } | { rung: 'R2'; value: T } | { rung: 'R3'; why: string };

const ASK = 'ask them for this one step with pause_for_user';
const direct: Act = f => f();

const canBurst = (p: LadderPlatform): p is LadderPlatform & BurstPlatform =>
  !!(p.restoreForeground && p.userIdle && p.cursorPos && p.mouseMove);

/**
 * `r1`: the window message that does the step (`name`: the control's text or accessibility name). `r2`: the step with the
 * target in front; it sends each of its inputs through `act`. `pid` undefined: the step acts on the window in front.
 */
export async function viaLadder<T>(
  platform: LadderPlatform, pid: number | undefined,
  step: { r1?: { name?: string; input: DeliverInput }; r2: (act: Act) => Promise<T> },
  opts: { replay?: boolean } = {},
): Promise<LadderResult<T>> {
  if (pid === undefined) return { rung: 'R2', value: await step.r2(direct) };
  if (!canBurst(platform)) {
    if (!await ensureInFront(platform, pid)) return { rung: 'R3', why: 'its window would not come to the front' };
    return { rung: 'R2', value: await step.r2(direct) };
  }
  const note = (n: string) => platform.noteRoute?.(n);
  const front = await platform.getActiveWindow().catch(() => null);
  if (front && (front.processId === pid || front.hostedProcessId === pid)) return { rung: 'R2', value: await step.r2(direct) };

  if (step.r1 && platform.deliverToWindow) {
    const r = await platform.deliverToWindow({ processId: pid, name: step.r1.name }, step.r1.input);
    // A click cannot be read back; text must have been, or it is done again below (a whole-value set, so not twice).
    if (r.success && (r.verified || 'click' in step.r1.input)) { note('R1 window message, focus not moved'); return { rung: 'R1' }; }
    if (r.reason === 'uipi') note('R1 refused: the window runs elevated, so Windows blocks posted input');
  }

  const burst = await withForegroundBurst(platform, { processId: pid }, async b => {
    const act: Act = async f => { const a = await b.act(f); if (!a.done) throw new Yielded(); return a.value; };
    try { return { value: await step.r2(act) }; } catch (e) { if (e instanceof Yielded) return null; throw e; }
  }, opts);
  if (!burst.ran) {
    const paused = burst.reason === 'paused-out' || burst.reason === 'target-changed' || burst.reason === 'no-replay';
    const why = burst.reason === 'user-busy' ? 'the user is at the keyboard'
      : burst.reason === 'paused-out' ? 'the step was paused for the user, who kept using the computer'
      : burst.reason === 'target-changed' ? 'the step was paused for the user and its window was gone or changed when they were done'
      : burst.reason === 'no-replay' ? 'the step was paused for the user, and a click by position is not safe to repeat once they have moved things'
      : 'its window would not come to the front';
    note(`R3: ${why}, so ${paused ? 'it was given up and their window left alone' : 'nothing was done'}; ${ASK}`);
    return { rung: 'R3', why: `${why}; ${ASK}` };
  }
  if (!burst.value) {
    note(`R3: the user started using the computer during the step, so it stopped and their window was left alone; ${ASK}`);
    return { rung: 'R3', why: `the user started using the computer during the step; ${ASK}` };
  }
  note(`R2 foreground burst #${burstCount()}: focus moved for a moment, your window and cursor given back`);
  return { rung: 'R2', value: burst.value.value };
}
