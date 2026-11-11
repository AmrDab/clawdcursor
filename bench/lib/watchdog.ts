/**
 * The watchdog: follows the isolated server's session log while an agent runs and says when to stop it.
 *
 * Rules (the first that fires wins):
 *   privacy          an acting call whose `app` is not a fixture app
 *   loop             the same call 3 times in a row
 *   repeat-failure   the same failure code 3 times
 *   call-cap         more calls than the task allows
 *   time-cap         more seconds than the task allows
 */
import * as fs from 'fs';
import * as path from 'path';
import { LOOP_RUN, appKey, isActing } from './rules';
import type { CallSig, LogCall } from './types';

export interface Verdict { rule: 'privacy' | 'loop' | 'repeat-failure' | 'call-cap' | 'time-cap'; detail: string }

export const FAILURE_REPEATS = 3;

export class Watchdog {
  private calls = 0;
  private sigSeen = false;
  private lastKey: string | null = null;
  private run = 0;
  private codes = new Map<string, number>();
  private readonly allowed: Set<string>;

  constructor(private limits: { maxCalls: number; maxSeconds: number; fixtureApps: string[] }) {
    this.allowed = new Set(limits.fixtureApps.map(appKey));
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

  /** One line of the session log. */
  onCall(c: LogCall): Verdict | null {
    this.calls++;
    const acted = isActing(c) || !!c.steps?.some(isActing);
    if (acted && c.app && !this.allowed.has(appKey(c.app))) {
      return { rule: 'privacy', detail: `${c.tool} ${c.action ?? ''} acted in "${c.app}", which is not a fixture app` };
    }
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
