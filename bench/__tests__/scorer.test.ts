import { describe, it, expect } from 'vitest';
import { aggregate, agentErrorOf, buildReport, compare, countFalseOk, expectsEffect, gateOf, renderMarkdown, score, toBaseline, DONE_MARK, type RunRecord, type Score } from '../lib/scorer';
import { countLoops, loopKeys } from '../lib/rules';
import type { AgentRun, FixtureState, LogCall, TaskSpec } from '../lib/types';

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const task: TaskSpec = {
  id: 'web-sample', archetype: 'web-form', os: ['windows'], mechanisms: ['M1'], guards: 'a sample',
  fixture: { kind: 'web', page: 'form' }, prompt: 'Fill the form and press Confirm.',
  success: { path: 'done', equals: true }, oracle: { screenshots: 0, calls: 4 }, caps: { calls: 12, seconds: 60 },
};

function call(i: number, tool: string, action: string, cls: LogCall['cls'], extra: Partial<LogCall> = {}): LogCall {
  return { t: at(i * 1000 + 200), tool, action, cls, ok: true, ms: 200, outcome: 'ok', ...extra };
}
const agent = (extra: Partial<AgentRun> = {}): AgentRun => ({ finalText: DONE_MARK, exitCode: 0, sigs: [], seconds: 12.4, ...extra });
/** An event in the middle of call i. */
const ev = (i: number, type = 'click') => ({ t: T0 + i * 1000 + 100, type, target: 'x' });

/** A clean run: read, three actions by name, each seen by the fixture. */
function cleanRun(): RunRecord {
  return {
    task, model: 'claude-code:sonnet',
    calls: [call(0, 'accessibility', 'read_tree', 'blind'), call(1, 'accessibility', 'set_value', 'act-name'),
      call(2, 'accessibility', 'set_value', 'act-name'), call(3, 'accessibility', 'invoke', 'act-name')],
    fixture: { state: { done: true }, events: [ev(1, 'input'), ev(2, 'input'), ev(3)] },
    agent: agent(),
  };
}

describe('score', () => {
  it('scores a clean run and passes the gate', () => {
    const s = score(cleanRun());
    expect(s).toMatchObject({ success: true, calls: 4, screenshots: 0, actName: 3, actCoords: 0, byName: 1, byCoords: 0,
      falseSuccesses: 0, loops: 0, seconds: 12, screenshotRatio: null });
    expect(s.gate).toEqual({ pass: true, failures: [] });
  });

  it('reads success from the fixture state, not from what the agent said', () => {
    const r = cleanRun();
    r.fixture = { state: { done: false }, events: r.fixture!.events };
    const s = score(r);
    expect(s.success).toBe(false);
    expect(s.falseDone).toBe(true);
    expect(s.falseSuccesses).toBe(1);
    expect(s.gate.failures).toEqual(['task not done (fixture state)', 'false successes 1']);
  });

  it('does not count an honest failure as a false success', () => {
    const r = cleanRun();
    r.fixture = { state: { done: false }, events: r.fixture!.events };
    r.agent = agent({ finalText: 'BENCH_RESULT: FAILED' });
    expect(score(r)).toMatchObject({ success: false, falseDone: false, falseSuccesses: 0 });
  });

  it('fails a task whose state could not be read', () => {
    const r = cleanRun();
    r.fixture = null;
    expect(score(r).success).toBe(false);
  });

  it('counts an action the server called ok that never reached the fixture', () => {
    const r = cleanRun();
    r.fixture = { state: { done: true }, events: [ev(1, 'input'), ev(3)] };  // nothing during call 2, nor 1.5 s after it
    r.calls[3] = call(5, 'accessibility', 'invoke', 'act-name');
    r.fixture.events[1] = ev(5);
    const s = score(r);
    expect(s.falseOk).toBe(1);
    expect(s.gate.failures).toEqual(['false successes 1']);
  });

  it('counts screenshots and the by-name / by-coordinates split, batch steps included', () => {
    const r = cleanRun();
    r.task = { ...task, oracle: { screenshots: 1, calls: 4 } };
    r.calls = [
      call(0, 'computer', 'screenshot', 'vision'),
      call(1, 'computer', 'click', 'act-coords'),
      call(2, 'batch', '', 'act-other', { steps: [
        { tool: 'computer', action: 'screenshot', cls: 'vision', ok: true, outcome: 'ok' },
        { tool: 'accessibility', action: 'invoke', cls: 'act-name', ok: true, outcome: 'ok' },
        { tool: 'computer', action: 'click', cls: 'act-coords', ok: true, outcome: 'ok' },
      ] }),
    ];
    r.fixture = { state: { done: true }, events: [ev(1), ev(2)] };
    const s = score(r);
    // Calls are counted like screenshots: the batch by its three steps. It was three round trips.
    expect(s).toMatchObject({ calls: 5, roundTrips: 3, screenshots: 2, screenshotRatio: 2, actName: 1, actCoords: 2, byName: 0.33, byCoords: 0.67 });
    expect(s.gate.pass).toBe(true);  // 2 screenshots <= oracle 1 + 1
  });

  it('fails the gate on one screenshot too many and on too many calls', () => {
    const r = cleanRun();
    r.calls = [call(0, 'computer', 'screenshot', 'vision'), call(1, 'computer', 'screenshot', 'vision'),
      ...[2, 3, 4, 5, 6].map(i => call(i, 'accessibility', 'find', 'blind', { outcome: i % 2 ? 'ok' : 'empty' }))];
    const s = score(r);
    expect(s.gate.failures).toEqual(['screenshots 2 > 1', 'calls 7 > 6']);
  });

  it('counts failed calls, and a refusal is not one', () => {
    const r = cleanRun();
    r.calls.push(call(4, 'accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error', code: 'NOT_FOUND' }),
      call(5, 'computer', 'click', 'act-coords', { ok: false, outcome: 'refused' }));
    expect(score(r).errors).toBe(1);
  });

  it('never gates a manual-verify task, and gives it no success', () => {
    const r = cleanRun();
    r.task = { ...task, manualVerify: true, success: undefined };
    r.fixture = null;
    r.calls = Array.from({ length: 9 }, (_, i) => call(i, 'computer', 'screenshot', 'vision'));
    const s = score(r);
    expect(s.success).toBeNull();
    expect(s.manual).toBe(true);
    expect(s.gate.pass).toBe(true);
  });

  it('reports the watchdog rule that stopped the agent, and fails the gate on a privacy stop', () => {
    const r = cleanRun();
    r.agent = agent({ killed: { rule: 'privacy', detail: 'acted in Outlook' } });
    const s = score(r);
    expect(s.killed).toBe('privacy');
    expect(s.gate.failures).toContain('acted in an app that is not a fixture');
  });
});

describe('loops', () => {
  it('uses the adapter signatures when there are any: the same call three times in a row', () => {
    const r = cleanRun();
    r.agent = agent({ sigs: ['a', 'b', 'b', 'b', 'c'].map(sig => ({ tool: 'accessibility', sig })) });
    expect(score(r).loops).toBe(1);
    expect(score(r).gate.failures).toContain('loops 1');
  });

  it('does not call three different set_value calls a loop', () => {
    const r = cleanRun();
    r.calls = [call(0, 'accessibility', 'read_tree', 'blind'), ...[1, 2, 3].map(i => call(i, 'accessibility', 'set_value', 'act-name'))];
    r.fixture = { state: { done: true }, events: [ev(1), ev(2), ev(3)] };
    expect(score(r).loops).toBe(0);
  });

  it('without signatures, counts the same read three times in a row', () => {
    const calls = [0, 1, 2].map(i => call(i, 'accessibility', 'read_tree', 'blind'));
    expect(countLoops(loopKeys(calls, []))).toBe(1);
    calls[1] = call(1, 'accessibility', 'find', 'blind');
    expect(countLoops(loopKeys(calls, []))).toBe(0);
  });

  it('counts each run once', () => {
    expect(countLoops(['a', 'a', 'a', 'a', 'b', 'c', 'c', 'c'])).toBe(2);
    expect(countLoops(['a', 'a', 'b', 'a', 'a'])).toBe(0);
    expect(countLoops([null, null, null])).toBe(0);
    expect(countLoops([])).toBe(0);
  });
});

describe('expectsEffect / countFalseOk', () => {
  it('expects an effect from actions on an element, a pointer or the keyboard', () => {
    const u = (tool: string, action: string, cls: LogCall['cls']) => ({ tool, action, cls, ok: true, outcome: 'ok' });
    expect(expectsEffect(u('accessibility', 'invoke', 'act-name'))).toBe(true);
    expect(expectsEffect(u('computer', 'click', 'act-coords'))).toBe(true);
    expect(expectsEffect(u('computer', 'type', 'act-other'))).toBe(true);
    expect(expectsEffect(u('browser', 'click', 'act-other'))).toBe(true);
    expect(expectsEffect(u('computer', 'hover', 'act-coords'))).toBe(false);
    expect(expectsEffect(u('computer', 'wait', 'act-other'))).toBe(false);
    expect(expectsEffect(u('window', 'focus', 'act-other'))).toBe(false);
    expect(expectsEffect(u('accessibility', 'read_tree', 'blind'))).toBe(false);
  });

  it('ignores failed calls, reads, and a run with no fixture', () => {
    const fx: FixtureState = { state: {}, events: [] };
    expect(countFalseOk([call(1, 'accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error' })], fx)).toBe(0);
    expect(countFalseOk([call(1, 'accessibility', 'read_tree', 'blind')], fx)).toBe(0);
    expect(countFalseOk([call(1, 'accessibility', 'invoke', 'act-name')], null)).toBe(0);
    expect(countFalseOk([call(1, 'accessibility', 'invoke', 'act-name')], fx)).toBe(1);
  });

  it('accepts an effect that lands shortly after the call returned', () => {
    const c = call(1, 'accessibility', 'invoke', 'act-name');   // ends at 1200
    expect(countFalseOk([c], { state: {}, events: [{ t: T0 + 2500, type: 'state' }] })).toBe(0);
    expect(countFalseOk([c], { state: {}, events: [{ t: T0 + 2800, type: 'state' }] })).toBe(1);
  });

  it('is not computed for a probed app, which has state but no timeline', () => {
    const r = cleanRun();
    r.fixture = { state: { done: true }, events: [] };
    expect(score(r).falseOk).toBe(0);
  });
});

describe('gateOf', () => {
  const base: Omit<Score, 'gate'> = { task: 't', model: 'm', archetype: 'web-form', mechanisms: ['M1'], manual: false, success: true,
    calls: 6, oracleCalls: 4, screenshots: 1, oracleScreenshots: 0, screenshotRatio: null, actName: 1, actCoords: 0, byName: 1, byCoords: 0,
    roundTrips: 6, errors: 0, falseSuccesses: 0, falseOk: 0, falseDone: false, reloaded: false, loops: 0, seconds: 1, runs: 1, successes: 1 };

  it('passes at the thresholds: calls = 1.5 x oracle, screenshots = oracle + 1', () => {
    expect(gateOf(base)).toEqual({ pass: true, failures: [] });
  });
  it('rounds the call limit up', () => {
    expect(gateOf({ ...base, oracleCalls: 3, calls: 5 }).pass).toBe(true);
    expect(gateOf({ ...base, oracleCalls: 3, calls: 6 }).pass).toBe(false);
  });
});

describe('report, baseline, comparison', () => {
  const meta = { date: '2026-11-11', os: 'windows' as const, clawdcursor: '2.0.0', models: ['claude-code:sonnet'], skipped: [{ task: 'textedit-type-lines', why: 'macos only' }] };

  it('passes only when every gated row passes, and never on an empty run', () => {
    const good = score(cleanRun());
    const bad = score({ ...cleanRun(), fixture: { state: {}, events: [] } });
    expect(buildReport(meta, [good]).gate).toEqual({ pass: true, status: 'PASS', failed: 0, gated: 1, agentErrors: 0 });
    expect(buildReport(meta, [good, bad]).gate).toEqual({ pass: false, status: 'FAIL', failed: 1, gated: 2, agentErrors: 0 });
    expect(buildReport(meta, []).gate).toMatchObject({ pass: false, status: 'INCOMPLETE' });
  });

  it('compares with the baseline row of the same task and model', () => {
    const before = buildReport(meta, [score(cleanRun())]);
    const base = toBaseline(before);
    expect(compare(before, base)[0].verdict).toBe('same');

    const worse = cleanRun();
    worse.calls.push(call(4, 'computer', 'screenshot', 'vision'));
    expect(compare(buildReport(meta, [score(worse)]), base)[0]).toMatchObject({ verdict: 'worse', calls: 1, screenshots: 1 });

    const better = cleanRun();
    better.calls.pop(); better.fixture!.events.pop();
    expect(compare(buildReport(meta, [score(better)]), base)[0]).toMatchObject({ verdict: 'better', calls: -1 });

    const lost = cleanRun();
    lost.fixture = { state: {}, events: lost.fixture!.events };
    expect(compare(buildReport(meta, [score(lost)]), base)[0]).toMatchObject({ verdict: 'worse', success: 'true -> false' });

    const other = { ...cleanRun(), model: 'ollama:qwen2.5:7b' };
    expect(compare(buildReport(meta, [score(other)]), base)[0].verdict).toBe('new');
  });

  it('renders a markdown table per model, the skipped tasks and the comparison', () => {
    const report = buildReport(meta, [score(cleanRun())]);
    const md = renderMarkdown(report, compare(report, toBaseline(report)));
    expect(md).toContain('Gate: **PASS** (1/1 rows pass)');
    expect(md).toContain('## claude-code:sonnet');
    expect(md).toContain('| web-sample | web-form | M1 | yes | 4 (4) | 4 | 0 (0) | - | 100% | 0% | 0 | 0 | 12s | pass |');
    expect(md).toContain('- textedit-type-lines: macos only');
    expect(md).toContain('| web-sample | claude-code:sonnet | same | true | 0 | 0 | 0 | 0 |');
  });
});

describe('counting', () => {
  it('a batch cannot hide calls from the gate: its steps count, like its screenshots do', () => {
    const r = cleanRun();
    const step = { tool: 'accessibility', action: 'set_value', cls: 'act-name' as const, ok: true, outcome: 'ok' };
    r.calls = [call(0, 'accessibility', 'read_tree', 'blind'), call(1, 'batch', '', 'act-other', { steps: Array.from({ length: 8 }, () => step) })];
    r.fixture = { state: { done: true }, events: [ev(1)] };
    const s = score(r);
    expect(s).toMatchObject({ calls: 9, roundTrips: 2 });
    expect(s.gate.failures).toEqual(['calls 9 > 6']);
  });
});

describe('a reloaded page', () => {
  it('fails the run, whatever the state says: a reload resets the page\'s counters', () => {
    const r = cleanRun();
    r.fixture = { ...r.fixture!, loads: 2 };
    const s = score(r);
    expect(s).toMatchObject({ success: false, reloaded: true });
    expect(s.gate.failures[0]).toBe('the fixture page was reloaded');
  });
  it('one load is the normal case, and a native fixture has no loads at all', () => {
    expect(score({ ...cleanRun(), fixture: { ...cleanRun().fixture!, loads: 1 } })).toMatchObject({ success: true, reloaded: false });
    expect(score(cleanRun()).reloaded).toBe(false);
  });
});

describe('repeats', () => {
  const run = (over: Partial<Score>): Score => ({ ...score(cleanRun()), ...over });

  it('one run is returned as it is', () => {
    const s = score(cleanRun());
    expect(aggregate([s])).toBe(s);
  });

  it('takes the median of calls, screenshots and time, so one slow sample does not decide the gate', () => {
    const s = aggregate([run({ calls: 4, screenshots: 0, seconds: 10 }), run({ calls: 30, screenshots: 9, seconds: 200 }), run({ calls: 5, screenshots: 1, seconds: 12 })]);
    expect(s).toMatchObject({ calls: 5, screenshots: 1, seconds: 12, loops: 0, falseSuccesses: 0, runs: 3, successes: 3, success: true });
    expect(s.gate.pass).toBe(true);
  });

  it('of two runs the median is the worse one', () => {
    expect(aggregate([run({ calls: 4 }), run({ calls: 9 })]).calls).toBe(9);
    expect(aggregate([run({ calls: 9 }), run({ calls: 4 }), run({ calls: 5 }), run({ calls: 6 })]).calls).toBe(6);
  });

  it('takes the WORST run for false successes and loops: one bad run in three still fails', () => {
    const lied = aggregate([run({}), run({ falseSuccesses: 2, falseOk: 2 }), run({})]);
    expect(lied).toMatchObject({ falseSuccesses: 2, falseOk: 2, success: true });
    expect(lied.gate.failures).toEqual(['false successes 2']);
    const looped = aggregate([run({}), run({}), run({ loops: 1 })]);
    expect(looped.gate.failures).toEqual(['loops 1']);
    expect(aggregate([run({}), run({ falseDone: true }), run({})]).falseDone).toBe(true);
  });

  it('is done when most runs were done', () => {
    const lost = run({ success: false, successes: 0 });
    expect(aggregate([run({}), run({}), lost])).toMatchObject({ success: true, successes: 2, runs: 3 });
    const s = aggregate([run({}), lost, lost]);
    expect(s).toMatchObject({ success: false, successes: 1 });
    expect(s.gate.failures).toContain('task done in 1 of 3 runs');
    expect(aggregate([run({}), lost]).success).toBe(false);   // half is not most
  });

  it('keeps a privacy stop and a reload from any run', () => {
    const s = aggregate([run({}), run({ killed: 'privacy' }), run({})]);
    expect(s.killed).toBe('privacy');
    expect(s.gate.pass).toBe(false);
    expect(aggregate([run({}), run({ reloaded: true }), run({})]).gate.failures).toContain('the fixture page was reloaded');
  });

  it('shows done as n/m in the table', () => {
    const meta = { date: 'd', os: 'windows' as const, clawdcursor: '2', models: ['claude-code:sonnet'], skipped: [] };
    expect(renderMarkdown(buildReport(meta, [aggregate([run({}), run({}), run({ success: false, successes: 0 })])]))).toContain('| 2/3 |');
  });
});

describe('an agent that never ran is not clawdcursor failing', () => {
  const meta = { date: 'd', os: 'windows' as const, clawdcursor: '2', models: ['claude-code:sonnet'], skipped: [] };
  /** What the first live run recorded for every task: the CLI's login had expired. */
  const expired = (): RunRecord => ({ ...cleanRun(), calls: [], fixture: { state: { done: false }, events: [{ t: T0, type: 'load', target: 'page' }], loads: 1 },
    agent: { finalText: 'Failed to authenticate: OAuth session expired and could not be refreshed', exitCode: 1, sigs: [], seconds: 2 } });

  it('a nonzero exit with no tool call is an agent error, with the agent\'s message', () => {
    expect(agentErrorOf(expired())).toBe('Failed to authenticate: OAuth session expired and could not be refreshed');
    const s = score(expired());
    expect(s).toMatchObject({ agentError: 'Failed to authenticate: OAuth session expired and could not be refreshed', success: null, calls: 0 });
    expect(s.gate).toEqual({ pass: true, failures: [] });   // not gated: it measured nothing
  });

  it('so is an adapter that threw, and an exit with nothing said', () => {
    expect(agentErrorOf({ calls: [], agent: { finalText: 'adapter error: spawn claude ENOENT', exitCode: null, sigs: [], seconds: 0 } })).toBe('spawn claude ENOENT');
    expect(agentErrorOf({ calls: [], agent: { finalText: '', exitCode: 3, sigs: [], seconds: 0 } })).toBe('the agent exited with code 3 before its first tool call');
  });

  it('it is NOT an agent error when the agent made a call, was stopped by the watchdog, or just gave up', () => {
    const made = expired(); made.calls = [call(0, 'accessibility', 'read_tree', 'blind')];
    expect(agentErrorOf(made)).toBeNull();
    expect(score(made)).toMatchObject({ success: false });
    const asked = expired(); asked.agent.sigs = [{ tool: 'accessibility', sig: 'a' }];
    expect(agentErrorOf(asked)).toBeNull();
    const stopped = expired(); stopped.agent.killed = { rule: 'time-cap', detail: '' };
    expect(agentErrorOf(stopped)).toBeNull();
    const gaveUp = expired(); gaveUp.agent = { finalText: 'I cannot do this.\nBENCH_RESULT: FAILED', exitCode: 0, sigs: [], seconds: 3 };
    expect(agentErrorOf(gaveUp)).toBeNull();
    expect(score(gaveUp).gate.failures).toContain('task not done (fixture state)');   // a model that does nothing fails the task
  });

  it('the run is INCOMPLETE, not FAIL: such rows are left out of the gate', () => {
    const all = buildReport(meta, [score(expired()), score(expired())]);
    expect(all.gate).toEqual({ pass: false, status: 'INCOMPLETE', failed: 0, gated: 0, agentErrors: 2 });
    const some = buildReport(meta, [score(cleanRun()), score(expired())]);
    expect(some.gate).toEqual({ pass: false, status: 'INCOMPLETE', failed: 0, gated: 1, agentErrors: 1 });
  });

  it('a real failure beside it is still FAIL', () => {
    const bad = score({ ...cleanRun(), fixture: { state: {}, events: [] } });
    expect(buildReport(meta, [bad, score(expired())]).gate).toMatchObject({ status: 'FAIL', failed: 1, gated: 1, agentErrors: 1 });
  });

  it('the table says "agent error" with the message, and the report says what to do', () => {
    const md = renderMarkdown(buildReport(meta, [score(expired())]));
    expect(md).toContain('Gate: **INCOMPLETE** (0/0 rows pass; 1 row(s) not measured: the agent host failed)');
    expect(md).toContain('| agent error |');
    expect(md).toContain('- (agent error: Failed to authenticate: OAuth session expired and could not be refreshed)');
    expect(md).toContain('Fix the agent and run again.');
    expect(md).not.toContain('FAIL:');
  });

  it('with repeats, one run in which the agent never started leaves the row unmeasured', () => {
    const s = aggregate([score(cleanRun()), score(expired()), score(cleanRun())]);
    expect(s.agentError).toMatch(/OAuth session expired/);
    expect(s.gate.pass).toBe(true);
    expect(buildReport(meta, [s]).gate.status).toBe('INCOMPLETE');
  });

  it('an agent-error row is never written to a baseline', () => {
    const report = buildReport(meta, [score(cleanRun()), { ...score(expired()), task: 'other-task' }]);
    expect(toBaseline(report).scores.map(x => x.task)).toEqual(['web-sample']);
  });
});

describe('"could not reach clawdcursor" is a clawdcursor failure, never an agent error', () => {
  const meta = { date: 'd', os: 'windows' as const, clawdcursor: '2', models: ['claude-code:sonnet'], skipped: [] };
  /** The daemon's MCP handshake broke: the agent host exits with an error and makes no call, exactly like an expired login. */
  const unreachable = (): RunRecord => ({ ...cleanRun(), calls: [], fixture: { state: { done: false }, events: [], loads: 1 },
    agent: { finalText: '', exitCode: 1, sigs: [], seconds: 1, serverUnreachable: 'the MCP handshake failed: fetch failed' } });

  it('the row fails, with that reason, and is not an agent error', () => {
    expect(agentErrorOf(unreachable())).toBeNull();
    const s = score(unreachable());
    expect(s.agentError).toBeUndefined();
    expect(s).toMatchObject({ success: false, serverError: 'the MCP handshake failed: fetch failed' });
    expect(s.gate).toEqual({ pass: false, failures: ['could not reach clawdcursor: the MCP handshake failed: fetch failed'] });
  });

  it('whatever the agent said or however it exited', () => {
    for (const agent of [{ finalText: 'adapter error: connect ECONNREFUSED', exitCode: null }, { finalText: 'Failed to authenticate', exitCode: 1 },
      { finalText: 'BENCH_RESULT: FAILED', exitCode: 0 }]) {
      const r = unreachable();
      r.agent = { ...r.agent, ...agent };
      const s = score(r);
      expect(s.agentError, agent.finalText).toBeUndefined();
      expect(s.gate.failures[0], agent.finalText).toMatch(/^could not reach clawdcursor/);
    }
  });

  it('the run is FAIL, not INCOMPLETE, and the table says why', () => {
    const report = buildReport(meta, [score(unreachable())]);
    expect(report.gate).toEqual({ pass: false, status: 'FAIL', failed: 1, gated: 1, agentErrors: 0 });
    const md = renderMarkdown(report);
    expect(md).toContain('Gate: **FAIL**');
    expect(md).toContain('FAIL: could not reach clawdcursor: the MCP handshake failed: fetch failed');
    expect(md).not.toContain('agent error');
  });

  it('with repeats, one unreachable run fails the row; it does not turn into an agent error beside one', () => {
    const expired: RunRecord = { ...cleanRun(), calls: [], agent: { finalText: 'Failed to authenticate', exitCode: 1, sigs: [], seconds: 1 } };
    const s = aggregate([score(cleanRun()), score(unreachable()), score(expired)]);
    expect(s.serverError).toBe('the MCP handshake failed: fetch failed');
    expect(s.agentError).toBeUndefined();
    expect(s.gate.pass).toBe(false);
  });

  it('a manual-verify task fails too: nothing could be done through an unreachable server', () => {
    const r = unreachable();
    r.task = { ...task, manualVerify: true, success: undefined };
    expect(score(r).gate.pass).toBe(false);
  });
});
