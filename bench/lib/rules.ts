/** Rules the watchdog (live) and the scorer (afterwards) share. */
import type { CallSig, LogCall } from './types';

export const LOOP_RUN = 3;

/**
 * Keys that say when two calls are "the same call".
 *
 * The session log never holds arguments, so two set_value calls on two fields look alike there. The adapter's
 * signatures (tool + arguments) are exact and are used when there are any. Without them only perception calls are
 * compared: reading the same thing three times in a row is a loop, three actions of one kind in a row need not be.
 */
export function loopKeys(calls: LogCall[], sigs: CallSig[]): Array<string | null> {
  if (sigs.length) return sigs.map(s => s.sig);
  return calls.map(c => (c.cls === 'blind' || c.cls === 'vision') ? `${c.tool}/${c.action ?? ''}/${c.outcome ?? ''}` : null);
}

/** Runs of LOOP_RUN or more equal keys in a row. A null key matches nothing. */
export function countLoops(keys: Array<string | null>): number {
  let loops = 0;
  let run = 1;
  for (let i = 1; i <= keys.length; i++) {
    if (i < keys.length && keys[i] !== null && keys[i] === keys[i - 1]) { run++; continue; }
    if (run >= LOOP_RUN) loops++;
    run = 1;
  }
  return loops;
}

/** "Bench Fixture", "BenchFixture.exe" and "benchfixture" are one app. */
export function appKey(name: string): string {
  return name.toLowerCase().replace(/\.(exe|app)$/, '').replace(/[^a-z0-9]/g, '');
}

export const isActing = (c: Pick<LogCall, 'cls'>) => c.cls === 'act-name' || c.cls === 'act-coords' || c.cls === 'act-other';
