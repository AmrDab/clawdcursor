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
  /** Calls, counted like screenshots and the by-name share: a batch counts by its steps, any other call as one. */
  calls: number; oracleCalls: number;
  /** Top-level tool calls (a batch is one): what the model paid in round trips. Not gated. */
  roundTrips: number;
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
  /** The fixture page was loaded more than once: a reload resets its counters, so the run does not count. */
  reloaded: boolean;
  loops: number;
  /** How many runs this row stands for (--repeats), and how many of them were done. */
  runs: number; successes: number;
  seconds: number;
  /** the watchdog rule that stopped the agent */
  killed?: string;
  /**
   * The agent host itself failed (not signed in, did not start, crashed before its first tool call): its message. The
   * row says nothing about clawdcursor, so it is not gated and the run is INCOMPLETE.
   */
  agentError?: string;
  /** The agent could not reach clawdcursor (MCP connect, initialize or tools/list failed): a failure of the server under test. */
  serverError?: string;
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

/**
 * Did the agent host fail before it did anything? A nonzero exit (or an adapter that threw) with no tool call at all:
 * an expired login, a missing binary, a crash at start. The watchdog stopping an agent is not this.
 */
export function agentErrorOf(r: Pick<RunRecord, 'calls' | 'agent'>): string | null {
  const a = r.agent;
  // Not reaching clawdcursor is the server's failure, whatever the agent's exit code says.
  if (a.serverUnreachable || a.killed || r.calls.length || a.sigs.length) return null;
  const threw = a.finalText.startsWith('adapter error:');
  if (!threw && (a.exitCode === 0 || a.exitCode === null)) return null;
  const said = a.finalText.replace(/^adapter error:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return said || `the agent exited with code ${a.exitCode} before its first tool call`;
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
  const reloaded = (r.fixture?.loads ?? 1) > 1;
  const success = manual || !task.success ? null : (r.fixture && !reloaded ? evaluate(task.success, r.fixture) : false);
  // A probe (a real app) gives state without a timeline: nothing to match the calls against.
  const falseOk = r.fixture && r.fixture.events.length ? countFalseOk(r.calls, r.fixture) : 0;
  const falseDone = success === false && r.agent.finalText.includes(DONE_MARK);
  const loops = countLoops(loopKeys(r.calls, r.agent.sigs));
  const s: Score = {
    task: task.id, model: r.model, archetype: task.archetype, mechanisms: task.mechanisms, manual,
    success,
    calls: us.length, oracleCalls: task.oracle.calls, roundTrips: r.calls.length,
    screenshots, oracleScreenshots: task.oracle.screenshots,
    screenshotRatio: task.oracle.screenshots ? round(screenshots / task.oracle.screenshots) : null,
    actName, actCoords,
    byName: pointed ? round(actName / pointed) : null,
    byCoords: pointed ? round(actCoords / pointed) : null,
    errors: r.calls.filter(c => !c.ok && c.outcome !== 'refused' && c.outcome !== 'consent_required').length,
    falseSuccesses: falseOk + (falseDone ? 1 : 0), falseOk, falseDone, reloaded,
    loops,
    runs: 1, successes: success ? 1 : 0,
    seconds: Math.round(r.agent.seconds),
    ...(r.agent.killed ? { killed: r.agent.killed.rule } : {}),
    gate: { pass: true, failures: [] },
  };
  if (r.agent.serverUnreachable) { s.serverError = r.agent.serverUnreachable; if (!manual) s.success = false; s.successes = 0; }
  const agentError = agentErrorOf(r);
  if (agentError) { s.agentError = agentError; s.success = null; s.successes = 0; s.falseSuccesses = 0; s.falseDone = false; }
  s.gate = gateOf(s);
  return s;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The thresholds one row must meet. A manual-verify row is never gated. */
export function gateOf(s: Omit<Score, 'gate'>): Score['gate'] {
  // An unreachable server fails any row, a manual one too: nothing could be done through it.
  if (s.serverError && s.manual) return { pass: false, failures: [`could not reach clawdcursor: ${s.serverError}`] };
  if (s.manual || s.agentError) return { pass: true, failures: [] };   // not a measurement of clawdcursor
  const failures: string[] = [];
  if (s.serverError) failures.push(`could not reach clawdcursor: ${s.serverError}`);
  else if (s.reloaded) failures.push('the fixture page was reloaded');
  else if (s.success !== true) failures.push(s.runs > 1 ? `task done in ${s.successes} of ${s.runs} runs` : 'task not done (fixture state)');
  const maxShots = s.oracleScreenshots + GATE.screenshotSlack;
  if (s.screenshots > maxShots) failures.push(`screenshots ${s.screenshots} > ${maxShots}`);
  const maxCalls = Math.ceil(s.oracleCalls * GATE.callFactor);
  if (s.calls > maxCalls) failures.push(`calls ${s.calls} > ${maxCalls}`);
  if (s.falseSuccesses > 0) failures.push(`false successes ${s.falseSuccesses}`);
  if (s.loops > 0) failures.push(`loops ${s.loops}`);
  if (s.killed === 'privacy') failures.push('acted in an app that is not a fixture');
  return { pass: failures.length === 0, failures };
}

/** The upper median: of two runs the worse one, of three the middle one. */
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

/**
 * One row for several runs of the same task and model (--repeats): the (upper) median of calls, screenshots and time,
 * done when most runs were done, so one slow sample does not decide the gate. False successes and loops take the WORST
 * run: one of them in any run fails the row. A privacy stop or a reload in any run stays.
 */
export function aggregate(runs: Score[]): Score {
  if (runs.length === 1) return runs[0];
  const first = runs[0];
  const med = (key: 'calls' | 'roundTrips' | 'screenshots' | 'actName' | 'actCoords' | 'errors' | 'falseSuccesses' | 'falseOk' | 'loops' | 'seconds') => median(runs.map(r => r[key]));
  const worst = (key: 'falseSuccesses' | 'falseOk' | 'loops') => Math.max(...runs.map(r => r[key]));
  const successes = runs.filter(r => r.success === true).length;
  const actName = med('actName'), actCoords = med('actCoords');
  const pointed = actName + actCoords;
  const screenshots = med('screenshots');
  const killed = runs.find(r => r.killed === 'privacy')?.killed ?? runs.find(r => r.killed)?.killed;
  const s: Score = {
    ...first,
    success: first.manual ? null : successes * 2 > runs.length,
    calls: med('calls'), roundTrips: med('roundTrips'), screenshots,
    screenshotRatio: first.oracleScreenshots ? Math.round(screenshots / first.oracleScreenshots * 100) / 100 : null,
    actName, actCoords,
    byName: pointed ? Math.round(actName / pointed * 100) / 100 : null,
    byCoords: pointed ? Math.round(actCoords / pointed * 100) / 100 : null,
    errors: med('errors'), falseSuccesses: worst('falseSuccesses'), falseOk: worst('falseOk'),
    falseDone: runs.some(r => r.falseDone),
    reloaded: runs.some(r => r.reloaded),
    loops: worst('loops'), seconds: med('seconds'),
    runs: runs.length, successes,
    gate: { pass: true, failures: [] },
  };
  if (killed) s.killed = killed; else delete s.killed;
  // One run in which the agent never started leaves the row unmeasured: it is not averaged away.
  const unreachable = runs.find(r => r.serverError)?.serverError;
  if (unreachable) s.serverError = unreachable; else delete s.serverError;
  const failedToRun = unreachable ? undefined : runs.find(r => r.agentError)?.agentError;
  if (failedToRun) { s.agentError = failedToRun; s.success = null; } else delete s.agentError;
  s.gate = gateOf(s);
  return s;
}

export interface Report {
  meta: { date: string; os: BenchOs; clawdcursor: string; models: string[]; skipped: Array<{ task: string; why: string }> };
  scores: Score[];
  /**
   * PASS: every gated row passes. FAIL: a gated row fails. INCOMPLETE: no gated row fails, but an agent host failed on
   * some rows (`agentErrors`) or nothing was measured, so the run says nothing final about clawdcursor.
   */
  gate: { pass: boolean; status: 'PASS' | 'FAIL' | 'INCOMPLETE'; failed: number; gated: number; agentErrors: number };
}

export function buildReport(meta: Report['meta'], scores: Score[]): Report {
  const agentErrors = scores.filter(s => s.agentError).length;
  const gated = scores.filter(s => !s.manual && !s.agentError);
  const failed = gated.filter(s => !s.gate.pass).length;
  // No gated row at all is not a pass: nothing was measured.
  const status = failed > 0 ? 'FAIL' as const : agentErrors > 0 || gated.length === 0 ? 'INCOMPLETE' as const : 'PASS' as const;
  return { meta, scores, gate: { pass: status === 'PASS', status, failed, gated: gated.length, agentErrors } };
}

/** The numbers kept from a run to compare the next one with. */
export interface Baseline {
  meta: Report['meta'];
  scores: Array<Pick<Score, 'task' | 'model' | 'success' | 'calls' | 'screenshots' | 'falseSuccesses' | 'loops' | 'seconds'>>;
}

export function toBaseline(r: Report): Baseline {
  // A row in which the agent never ran is no baseline for anything.
  return { meta: r.meta, scores: r.scores.filter(x => !x.agentError).map(({ task, model, success, calls, screenshots, falseSuccesses, loops, seconds }) =>
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
  out.push(`${r.meta.date}. Gate: **${r.gate.status}** (${r.gate.gated - r.gate.failed}/${r.gate.gated} rows pass`
    + `${r.gate.agentErrors ? `; ${r.gate.agentErrors} row(s) not measured: the agent host failed` : ''}).`, '');
  if (r.gate.status === 'INCOMPLETE') {
    out.push(r.gate.agentErrors ? 'INCOMPLETE: an agent host failed before it made a tool call (not signed in, did not start). Those rows say nothing about '
      + 'clawdcursor and are not gated. Fix the agent and run again.' : 'INCOMPLETE: no gated task was run.', '');
  }
  out.push(`Gate per row: task done (fixture state), screenshots <= oracle + ${GATE.screenshotSlack}, calls <= ${GATE.callFactor} x oracle, `
    + 'no false success, no loop. Manual-verify rows are not gated. Calls and screenshots count each step of a batch; '
    + '"trips" are top-level calls. With repeats, a row is the median of its runs.', '');
  for (const model of r.meta.models) {
    const rows = r.scores.filter(s => s.model === model);
    if (!rows.length) continue;
    const gated = rows.filter(s => !s.manual && !s.agentError);
    out.push(`## ${model}`, '');
    out.push(`Done ${gated.filter(s => s.success).length}/${gated.length}, calls ${sum(rows, 'calls')} (oracle ${sum(rows, 'oracleCalls')}), `
      + `screenshots ${sum(rows, 'screenshots')} (oracle ${sum(rows, 'oracleScreenshots')}), false successes ${sum(rows, 'falseSuccesses')}, loops ${sum(rows, 'loops')}.`, '');
    out.push('| Task | Type | Guards | Done | Calls (oracle) | Trips | Shots (oracle) | Shots / oracle | By name | By coords | False ok | Loops | Time | Gate |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of rows) {
      const done = s.agentError ? 'agent error' : s.manual ? 'manual' : s.runs > 1 ? `${s.successes}/${s.runs}` : s.success ? 'yes' : 'NO';
      const gate = s.agentError ? `- (agent error: ${s.agentError.replace(/\|/g, '/')})` : s.manual ? '-' : s.gate.pass ? 'pass' : `FAIL: ${s.gate.failures.join('; ')}`;
      out.push(`| ${s.task} | ${s.archetype} | ${s.mechanisms.join(' ')} | ${done} | ${s.calls} (${s.oracleCalls}) | ${s.roundTrips} | ${s.screenshots} (${s.oracleScreenshots}) | `
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
