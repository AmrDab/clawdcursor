/**
 * The watchdog: follows the isolated server's session log while an agent runs and says when to stop it.
 *
 * Rules (the first that fires wins):
 *   privacy          an acting call that is not proven to be in the fixture (see `privacy` below): fails CLOSED
 *   loop             the same call 3 times in a row
 *   repeat-failure   the same failure code 3 times
 *   call-cap         more calls than the task allows
 *   time-cap         more seconds than the task allows
 */
import * as fs from 'fs';
import * as path from 'path';
import { LOOP_RUN, appKey, hasTarget, isInput } from './rules';
import type { CallSig, LogCall } from './types';

export interface Verdict { rule: 'privacy' | 'loop' | 'repeat-failure' | 'call-cap' | 'time-cap'; detail: string }

export const FAILURE_REPEATS = 3;

/** What the runner can prove about the fixture right now. Both answers must fail closed. */
export interface Proof {
  /** The keyboard focus belongs to a process the benchmark started for this task (or a child of one). */
  ownsFocus(): Promise<boolean> | boolean;
  /** The only browser clawdcursor's `browser` tool can reach is the fixture's own instance. */
  cdpIsFixture(): Promise<boolean> | boolean;
}

export class Watchdog {
  private calls = 0;
  private sigSeen = false;
  private lastKey: string | null = null;
  private run = 0;
  private codes = new Map<string, number>();
  private readonly allowed: Set<string>;

  constructor(private limits: { maxCalls: number; maxSeconds: number; fixtureApps: string[] }, private proof: Proof) {
    this.allowed = new Set(limits.fixtureApps.map(appKey));
  }

  /**
   * The privacy guard. Each call that does something to a window (and each such step of a batch) must be PROVEN to be
   * in the fixture, or the run stops:
   *   - the log names its app: the name must be the fixture's, and the focus must belong to a process the benchmark started;
   *   - no app, `browser` tool (the 2.0 log names no app for a CDP act): the only reachable browser must be the fixture's own;
   *   - no app, input or an act by name (the log leaves the app out when it went to a background process): stop;
   *   - no app, anything else (window focus, open_app, ...): the focus must belong to a process the benchmark started.
   * An app name alone never passes, and a probe that cannot answer counts as "not ours".
   */
  async privacy(c: LogCall): Promise<Verdict | null> {
    const units = c.steps?.length ? c.steps.map(s => ({ ...s, app: s.app ?? c.app })) : [c];
    // One probe per log line, and only when a unit needs it.
    let focus: Promise<boolean> | undefined;
    const ownsFocus = () => focus ??= Promise.resolve(this.proof.ownsFocus()).catch(() => false);
    // A batch whose steps the log does not list could have done anything: it is judged like input.
    const opaque = (u: { tool: string }) => u.tool === 'batch';
    // A call a guard refused never ran.
    const ran = (u: { outcome?: string }) => u.outcome !== 'refused' && u.outcome !== 'consent_required';
    for (const u of units.filter(x => ran(x) && (opaque(x) || hasTarget(x)))) {
      const what = `${u.tool} ${u.action ?? ''}`.trim();
      const stop = (why: string): Verdict => ({ rule: 'privacy', detail: `${what} ${why}` });
      if (u.app) {
        if (!this.allowed.has(appKey(u.app))) return stop(`acted in "${u.app}", which is not a fixture app`);
        if (!await ownsFocus()) return stop(`acted in "${u.app}", but the focus is not in a process the benchmark started`);
      } else if (u.tool === 'browser') {
        if (!await Promise.resolve(this.proof.cdpIsFixture()).catch(() => false)) return stop('acted through CDP, and the browser it reached is not proven to be the fixture\'s own');
      } else if (opaque(u) || isInput(u)) {
        return stop('acted with no app recorded (a background process, or an unknown target)');
      } else if (!await ownsFocus()) {
        return stop('left the focus in a process the benchmark did not start');
      }
    }
    return null;
  }

  private repeat(key: string | null, what: string): Verdict | null {
    this.run = key !== null && key === this.lastKey ? this.run + 1 : 1;
    this.lastKey = key;
    return this.run >= LOOP_RUN ? { rule: 'loop', detail: `${what} ${LOOP_RUN} times in a row` } : null;
  }

  /** A call as the adapter saw the model make it (tool + arguments). Exact, so it replaces the log's weaker comparison. */
  onSig(s: CallSig): Verdict | null {
    this.sigSeen = true;
    return this.repeat(s.sig, `the same ${s.tool} call`);
  }

  /** One line of the session log: the privacy guard first, then the other rules. */
  async judge(c: LogCall): Promise<Verdict | null> {
    return await this.privacy(c) ?? this.onCall(c);
  }

  /** One line of the session log, for every rule but privacy (whose proofs take time: `judge`). */
  onCall(c: LogCall): Verdict | null {
    this.calls += c.steps?.length || 1;   // counted like the scorer: a batch by its steps
    if (!this.sigSeen) {
      // The log has no arguments: only a repeated read is surely the same call (rules.ts).
      const key = c.cls === 'blind' || c.cls === 'vision' ? `${c.tool}/${c.action ?? ''}/${c.outcome ?? ''}` : null;
      const v = this.repeat(key, `${c.tool} ${c.action ?? ''}`);
      if (v) return v;
    }
    if (!c.ok && c.code) {
      const n = (this.codes.get(c.code) ?? 0) + 1;
      this.codes.set(c.code, n);
      if (n >= FAILURE_REPEATS) return { rule: 'repeat-failure', detail: `${c.code} ${n} times` };
    }
    if (this.calls > this.limits.maxCalls) return { rule: 'call-cap', detail: `${this.calls} calls, the task allows ${this.limits.maxCalls}` };
    return null;
  }

  onTime(seconds: number): Verdict | null {
    return seconds > this.limits.maxSeconds ? { rule: 'time-cap', detail: `${Math.round(seconds)} s, the task allows ${this.limits.maxSeconds}` } : null;
  }
}

/** Every call line of every session file in `dir`, oldest file first. The header and end lines are skipped. */
export function readSessionCalls(dir: string): LogCall[] {
  const calls: LogCall[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort(); } catch { /* no session yet */ }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const c = parseCall(line);
      if (c) calls.push(c);
    }
  }
  return calls.sort((a, b) => a.t.localeCompare(b.t));
}

function parseCall(line: string): LogCall | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line);
    return o && typeof o.tool === 'string' && typeof o.cls === 'string' ? o as LogCall : null;
  } catch { return null; }   // a line still being written
}

/**
 * Follow the session files in `dir` (the daemon makes one per client session): `onCall` gets each complete new line.
 * Polling, not fs.watch: it behaves the same on every OS. Returns the stop function.
 */
export function tailSessionDir(dir: string, onCall: (c: LogCall) => void, everyMs = 200): () => void {
  const offsets = new Map<string, number>();
  const rest = new Map<string, string>();
  const poll = () => {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort(); } catch { return; }
    for (const f of files) {
      const file = path.join(dir, f);
      const from = offsets.get(f) ?? 0;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size <= from) continue;
      const buf = Buffer.alloc(size - from);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
      offsets.set(f, size);
      const lines = ((rest.get(f) ?? '') + buf.toString('utf8')).split('\n');
      rest.set(f, lines.pop() ?? '');   // the last piece has no newline yet
      for (const line of lines) {
        const c = parseCall(line);
        if (c) onCall(c);
      }
    }
  };
  const timer = setInterval(poll, everyMs);
  return () => { clearInterval(timer); poll(); };
}
