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

type Unit = Pick<LogCall, 'tool' | 'action' | 'cls'>;

/** Actions that touch no window: waiting, reading the clock, moving the pointer without pressing, connecting. */
const NO_TARGET = new Set(['wait', 'wait_for', 'connect', 'report', 'system_time', 'shortcuts_list', 'build_uri', 'detect_webview',
  'pause_for_user', 'hover', 'move', 'move_relative']);
const KEYS = new Set(['type', 'key', 'key_press', 'key_down', 'key_up']);

/** Does this call do something to a window or an app? Anything acting that is not known to be harmless counts. */
export function hasTarget(u: Unit): boolean {
  return isActing(u) && u.tool !== 'batch' && !NO_TARGET.has(u.action ?? '');
}

/** Input, or an act on an element by name: the session log names the app of every one of these that hit the window in front. */
export function isInput(u: Unit): boolean {
  return u.cls === 'act-name' || u.cls === 'act-coords' || (u.tool === 'computer' && KEYS.has(u.action ?? ''));
}

/**
 * A name that says nothing about which app it is: ApplicationFrameHost owns the window of EVERY Store app. clawdcursor
 * names a Store app by the app it hosts ("Calculator"); a build that does not, or a frame it could not resolve, logs
 * this. The name can then neither admit nor condemn the act: the process recorded with the act decides, and without
 * one the act is not allowed.
 */
export function isSharedHostName(name: string): boolean {
  return appKey(name) === 'applicationframehost';
}
