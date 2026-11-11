/**
 * The scorer: one row per task x model, from the fixture's state, the isolated server's session log and the agent's
 * last message. No model judges anything.
 */
import { evaluate } from './tasks';
import { countLoops, loopKeys } from './rules';
import type { AgentRun, BenchOs, FixtureState, LogCall, TaskSpec } from './types';

export const GATE = {
  /** screenshots <= oracle + this */
  screenshotSlack: 1,
  /** calls <= oracle x this */
  callFactor: 1.5,
} as const;

/** The agent ends its reply with one of these (prompt.ts). */
export const DONE_MARK = 'BENCH_RESULT: DONE';
export const FAILED_MARK = 'BENCH_RESULT: FAILED';

/** How long after a call returns an effect may still reach the fixture's recorder and count for that call. */
export const EFFECT_GRACE_MS = 1500;

export interface RunRecord {
  task: TaskSpec;
  /** adapter:model, e.g. "claude-code:sonnet" */
  model: string;
  calls: LogCall[];
  /** null: the task has no state to read (manual verify), or reading it failed */
  fixture: FixtureState | null;
  agent: AgentRun;
}

export interface Score {
  task: string; model: string; archetype: string; mechanisms: string[]; manual: boolean;
  /** null on a manual-verify task */
  success: boolean | null;
  calls: number; oracleCalls: number;
  screenshots: number; oracleScreenshots: number;
  /** screenshots / oracle; null when the oracle takes none */
  screenshotRatio: number | null;
  actName: number; actCoords: number;
  /** share of pointer-or-name actions done by name / by coordinates; null when there were none */
  byName: number | null; byCoords: number | null;
  /** calls that failed (refusals are not failures) */
  errors: number;
  /** falseOk + (falseDone ? 1 : 0) */
  falseSuccesses: number;
  /** actions the server reported ok that never reached the fixture */
  falseOk: number;
  /** the agent said DONE and the fixture state says otherwise */
  falseDone: boolean;
  loops: number;
  seconds: number;
  /** the watchdog rule that stopped the agent */
  killed?: string;
  gate: { pass: boolean; failures: string[] };
}

type Unit = Pick<LogCall, 'tool' | 'action' | 'cls' | 'ok' | 'outcome'>;

/** A batch counts by its steps, any other call by itself. */
function units(calls: LogCall[]): Unit[] {
  return calls.flatMap((c): Unit[] => c.steps?.length ? c.steps : [c]);
}

const NO_EFFECT_POINTER = new Set(['hover', 'move', 'move_relative', 'mouse_up']);
const KEYBOARD = new Set(['type', 'key', 'key_press']);
const BROWSER_ACTS = new Set(['click', 'type', 'select_option']);

/** Does this call, when it works, always do something a fixture's recorder sees? */
export function expectsEffect(u: Unit): boolean {
  const a = u.action ?? '';
  if (u.cls === 'act-name') return true;
  if (u.cls === 'act-coords') return !NO_EFFECT_POINTER.has(a);
  if (u.tool === 'computer') return KEYBOARD.has(a);
  if (u.tool === 'browser') return BROWSER_ACTS.has(a);
  return false;
}

/**
 * Actions the server reported ok while the fixture recorded nothing during the call (or just after it): the click,
 * key or value never arrived. Needs the fixture's event timeline, so it is 0 for a task that has none.
 */
export function countFalseOk(calls: LogCall[], fixture: FixtureState | null): number {
  if (!fixture) return 0;
  let n = 0;
  for (const c of calls) {
    const reportedOk = c.ok && (c.outcome ?? 'ok') === 'ok';
    if (!reportedOk || !units([c]).some(expectsEffect)) continue;
    const end = Date.parse(c.t);
    const from = end - c.ms - 100;
    const to = end + EFFECT_GRACE_MS;
    if (!fixture.events.some(e => e.t >= from && e.t <= to)) n++;
  }
  return n;
}

export function score(r: RunRecord): Score {
  const { task } = r;
  const us = units(r.calls);
  const count = (cls: LogCall['cls']) => us.filter(u => u.cls === cls).length;
  const screenshots = count('vision');
  const actName = count('act-name');
  const actCoords = count('act-coords');
  const pointed = actName + actCoords;
  const manual = !!task.manualVerify;
  const success = manual || !task.success ? null : (r.fixture ? evaluate(task.success, r.fixture) : false);
  // A probe (a real app) gives state without a timeline: nothing to match the calls against.
  const falseOk = r.fixture && r.fixture.events.length ? countFalseOk(r.calls, r.fixture) : 0;
  const falseDone = success === false && r.agent.finalText.includes(DONE_MARK);
  const loops = countLoops(loopKeys(r.calls, r.agent.sigs));
  const s: Score = {
    task: task.id, model: r.model, archetype: task.archetype, mechanisms: task.mechanisms, manual,
    success,
    calls: r.calls.length, oracleCalls: task.oracle.calls,
    screenshots, oracleScreenshots: task.oracle.screenshots,
    screenshotRatio: task.oracle.screenshots ? round(screenshots / task.oracle.screenshots) : null,
    actName, actCoords,
    byName: pointed ? round(actName / pointed) : null,
    byCoords: pointed ? round(actCoords / pointed) : null,
    errors: r.calls.filter(c => !c.ok && c.outcome !== 'refused' && c.outcome !== 'consent_required').length,
    falseSuccesses: falseOk + (falseDone ? 1 : 0), falseOk, falseDone,
    loops,
    seconds: Math.round(r.agent.seconds),
    ...(r.agent.killed ? { killed: r.agent.killed.rule } : {}),
    gate: { pass: true, failures: [] },
  };
  s.gate = gateOf(s);
  return s;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The thresholds one row must meet. A manual-verify row is never gated. */
export function gateOf(s: Omit<Score, 'gate'>): Score['gate'] {
  if (s.manual) return { pass: true, failures: [] };
  const failures: string[] = [];
  if (s.success !== true) failures.push('task not done (fixture state)');
  const maxShots = s.oracleScreenshots + GATE.screenshotSlack;
  if (s.screenshots > maxShots) failures.push(`screenshots ${s.screenshots} > ${maxShots}`);
  const maxCalls = Math.ceil(s.oracleCalls * GATE.callFactor);
  if (s.calls > maxCalls) failures.push(`calls ${s.calls} > ${maxCalls}`);
  if (s.falseSuccesses > 0) failures.push(`false successes ${s.falseSuccesses}`);
  if (s.loops > 0) failures.push(`loops ${s.loops}`);
  if (s.killed === 'privacy') failures.push('acted in an app that is not a fixture');
  return { pass: failures.length === 0, failures };
}

export interface Report {
  meta: { date: string; os: BenchOs; clawdcursor: string; models: string[]; skipped: Array<{ task: string; why: string }> };
  scores: Score[];
  gate: { pass: boolean; failed: number; gated: number };
}

export function buildReport(meta: Report['meta'], scores: Score[]): Report {
  const gated = scores.filter(s => !s.manual);
  const failed = gated.filter(s => !s.gate.pass).length;
  // No gated row at all is not a pass: nothing was measured.
  return { meta, scores, gate: { pass: gated.length > 0 && failed === 0, failed, gated: gated.length } };
}

/** The numbers kept from a run to compare the next one with. */
export interface Baseline {
  meta: Report['meta'];
  scores: Array<Pick<Score, 'task' | 'model' | 'success' | 'calls' | 'screenshots' | 'falseSuccesses' | 'loops' | 'seconds'>>;
}

export function toBaseline(r: Report): Baseline {
  return { meta: r.meta, scores: r.scores.map(({ task, model, success, calls, screenshots, falseSuccesses, loops, seconds }) =>
    ({ task, model, success, calls, screenshots, falseSuccesses, loops, seconds })) };
}

export interface Delta {
  task: string; model: string;
  /** new: the baseline has no such row */
  verdict: 'better' | 'same' | 'worse' | 'new';
  success: string; calls: number; screenshots: number; falseSuccesses: number; loops: number;
}

/** Each row against the baseline's row for the same task and model. Worse: success lost, or any count went up. */
export function compare(now: Report, base: Baseline): Delta[] {
  return now.scores.map(s => {
    const b = base.scores.find(x => x.task === s.task && x.model === s.model);
    if (!b) return { task: s.task, model: s.model, verdict: 'new' as const, success: String(s.success), calls: 0, screenshots: 0, falseSuccesses: 0, loops: 0 };
    const d = { calls: s.calls - b.calls, screenshots: s.screenshots - b.screenshots,
      falseSuccesses: s.falseSuccesses - b.falseSuccesses, loops: s.loops - b.loops };
    const lost = b.success === true && s.success !== true;
    const won = b.success === false && s.success === true;
    const counts = Object.values(d);
    const verdict = lost || (!won && counts.some(n => n > 0)) ? 'worse' as const
      : won || counts.some(n => n < 0) ? 'better' as const : 'same' as const;
    return { task: s.task, model: s.model, verdict, success: b.success === s.success ? String(s.success) : `${b.success} -> ${s.success}`, ...d };
  });
}

const pct = (n: number | null) => n === null ? '-' : `${Math.round(n * 100)}%`;
const signed = (n: number) => n > 0 ? `+${n}` : String(n);

export function renderMarkdown(r: Report, deltas?: Delta[]): string {
  const out: string[] = [];
  out.push(`# clawdcursor benchmark: ${r.meta.os}, clawdcursor ${r.meta.clawdcursor}`, '');
  out.push(`${r.meta.date}. Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}** (${r.gate.gated - r.gate.failed}/${r.gate.gated} rows pass).`, '');
  out.push(`Gate per row: task done (fixture state), screenshots <= oracle + ${GATE.screenshotSlack}, calls <= ${GATE.callFactor} x oracle, `
    + 'no false success, no loop. Manual-verify rows are not gated.', '');
  for (const model of r.meta.models) {
    const rows = r.scores.filter(s => s.model === model);
    if (!rows.length) continue;
    const gated = rows.filter(s => !s.manual);
    out.push(`## ${model}`, '');
    out.push(`Done ${gated.filter(s => s.success).length}/${gated.length}, calls ${sum(rows, 'calls')} (oracle ${sum(rows, 'oracleCalls')}), `
      + `screenshots ${sum(rows, 'screenshots')} (oracle ${sum(rows, 'oracleScreenshots')}), false successes ${sum(rows, 'falseSuccesses')}, loops ${sum(rows, 'loops')}.`, '');
    out.push('| Task | Type | Guards | Done | Calls (oracle) | Shots (oracle) | Shots / oracle | By name | By coords | False ok | Loops | Time | Gate |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of rows) {
      const done = s.manual ? 'manual' : s.success ? 'yes' : 'NO';
      const gate = s.manual ? '-' : s.gate.pass ? 'pass' : `FAIL: ${s.gate.failures.join('; ')}`;
      out.push(`| ${s.task} | ${s.archetype} | ${s.mechanisms.join(' ')} | ${done} | ${s.calls} (${s.oracleCalls}) | ${s.screenshots} (${s.oracleScreenshots}) | `
        + `${s.screenshotRatio ?? '-'} | ${pct(s.byName)} | ${pct(s.byCoords)} | ${s.falseSuccesses} | ${s.loops} | ${s.seconds}s | `
        + `${gate}${s.killed ? ` (stopped: ${s.killed})` : ''} |`);
    }
    out.push('');
  }
  if (r.meta.skipped.length) {
    out.push('## Skipped', '', ...r.meta.skipped.map(k => `- ${k.task}: ${k.why}`), '');
  }
  if (deltas) {
    out.push('## Against the baseline', '');
    out.push('| Task | Model | Verdict | Done | Calls | Shots | False ok | Loops |', '|---|---|---|---|---|---|---|---|');
    for (const d of deltas) {
      out.push(d.verdict === 'new' ? `| ${d.task} | ${d.model} | new | ${d.success} | | | | |`
        : `| ${d.task} | ${d.model} | ${d.verdict} | ${d.success} | ${signed(d.calls)} | ${signed(d.screenshots)} | ${signed(d.falseSuccesses)} | ${signed(d.loops)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function sum(rows: Score[], key: 'calls' | 'oracleCalls' | 'screenshots' | 'oracleScreenshots' | 'falseSuccesses' | 'loops'): number {
  return rows.reduce((n, s) => n + s[key], 0);
}
