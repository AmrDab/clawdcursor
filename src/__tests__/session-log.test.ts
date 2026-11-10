/**
 * MCP session log + report: measure whether agents perceive "blind first"
 * (a11y / text) before screenshots, and let a user report a session in one
 * step — without ever recording typed text, clipboard, names or paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionLog, classifyCall, outcomeOf, readSession, listSessions, endAllSessions, safeStack, errorClass } from '../surface/session-log';
import { buildSessionReport, issueUrl, reportMarkdown } from '../surface/report';

beforeEach(() => {
  process.env.CLAWDCURSOR_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sess-'));
  delete process.env.CLAWDCURSOR_SESSION_LOG;
});

describe('classifyCall', () => {
  it('compact surface', () => {
    expect(classifyCall('computer', 'screenshot')).toBe('vision');
    expect(classifyCall('computer', 'zoom')).toBe('vision');
    expect(classifyCall('computer', 'click')).toBe('act-coords');
    expect(classifyCall('computer', 'type')).toBe('act-other');
    expect(classifyCall('accessibility', 'find')).toBe('blind');
    expect(classifyCall('accessibility', 'invoke')).toBe('act-name');
    expect(classifyCall('accessibility', 'smart_click')).toBe('act-name');
    expect(classifyCall('system', 'copy_all_text')).toBe('blind');
    expect(classifyCall('system', 'ocr')).toBe('blind');
    expect(classifyCall('browser', 'page_context')).toBe('blind');
  });
  it('granular surface', () => {
    expect(classifyCall('desktop_screenshot')).toBe('vision');
    expect(classifyCall('mouse_click')).toBe('act-coords');
    expect(classifyCall('read_screen')).toBe('blind');
    expect(classifyCall('smart_click')).toBe('act-name');
  });
});

describe('outcomeOf', () => {
  it('flags the results that make agents give up on blind reads', () => {
    expect(outcomeOf(false, '(no elements found)')).toBe('empty');
    expect(outcomeOf(true, 'PSRunner timeout: find-element')).toBe('timeout');
    expect(outcomeOf(false, 'FOCUSED WINDOW UI TREE (PARTIAL — …)')).toBe('partial');
    expect(outcomeOf(false, 'Session report — blind reads that came back empty / timed out: 1')).toBe('ok');
    expect(outcomeOf(false, 'Invoked "Save" via a11y.')).toBe('ok');
    expect(outcomeOf(true, 'boom')).toBe('error');
  });
});

describe('SessionLog', () => {
  it('tallies blind-first behaviour and writes no content', () => {
    const log = new SessionLog({ version: '9.9.9', surface: 'compact' });
    log.record('accessibility', 'find', true, 12, undefined, { name: 'claude-code', version: '2.1' }, { outcome: 'empty' });
    log.record('computer', 'screenshot', true, 300);
    log.record('computer', 'screenshot', true, 300);
    log.record('computer', 'click', true, 80, undefined, undefined, { space: 'image' });
    log.record('system', 'copy_all_text', true, 400);
    log.record('computer', 'screenshot', true, 300);
    log.record('accessibility', 'invoke', false, 50, 'no element named "Pay alice@example.com" in C:\\Users\\bob\\x');
    const t = log.summary;
    expect(t).toMatchObject({ calls: 7, blind: 2, vision: 3, actName: 1, actCoords: 1, errors: 1, firstPerception: 'blind',
      visionAfterBlind: 2, blindEmpty: 1, visionAfterBlindMiss: 1 });

    const raw = fs.readFileSync(log.file!, 'utf8');
    expect(raw).toContain('"client":"claude-code 2.1"');
    expect(raw).toContain('"space":"image"');
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('bob');
    const back = readSession(log.file!);
    expect(back.tally).toMatchObject({ calls: 7, vision: 3, blindEmpty: 1, visionAfterBlindMiss: 1 });
  });

  it('tracks the screenshot-only streak the nudge keys on', () => {
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    for (let i = 0; i < 3; i++) log.record('computer', 'screenshot', true, 1);
    expect(log.visionOnlyStreak).toBe(3);
    log.record('accessibility', 'read_tree', true, 1);
    expect(log.visionOnlyStreak).toBe(0);
  });

  it('records a safety-refused call with outcome "refused"', () => {
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    log.record('computer', 'key', false, 0, 'computer: safety block - blocked key combo', undefined, { outcome: 'refused' });
    const back = readSession(log.file!);
    expect(back.calls).toHaveLength(1);
    expect(back.calls[0]).toMatchObject({ tool: 'computer', action: 'key', ok: false, outcome: 'refused' });
    // a refusal is the guard working: counted apart from errors, in the live tally and when the file is read back
    expect(log.summary).toMatchObject({ errors: 0, refused: 1 });
    expect(back.tally).toMatchObject({ errors: 0, refused: 1 });
  });

  it('classifies batch steps one by one (not one act-other row)', () => {
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    log.record('batch', undefined, false, 900, undefined, undefined, { outcome: 'error', steps: [
      { tool: 'accessibility', action: 'find', ok: true, outcome: 'ok' },
      { tool: 'computer', action: 'click', ok: true, outcome: 'ok' },
      { tool: 'computer', action: 'screenshot', ok: false, outcome: 'refused' },
    ] });
    expect(log.summary).toMatchObject({ calls: 1, blind: 1, actCoords: 1, vision: 1, actOther: 0, firstPerception: 'blind' });
    const back = readSession(log.file!);
    expect(back.calls[0].steps!.map(s => s.cls)).toEqual(['blind', 'act-coords', 'vision']);
    expect(back.calls[0].steps![2]).toMatchObject({ ok: false, outcome: 'refused' });
    expect(back.tally).toMatchObject({ calls: 1, blind: 1, actCoords: 1, vision: 1, actOther: 0 });
  });

  it('CLAWDCURSOR_SESSION_LOG=0 writes nothing', () => {
    process.env.CLAWDCURSOR_SESSION_LOG = '0';
    const log = new SessionLog({ version: 'x', surface: 'compact' });
    log.record('computer', 'screenshot', true, 1);
    expect(log.file).toBeNull();
    expect(listSessions()).toEqual([]);
  });
});

describe('session report', () => {
  it('builds a GitHub-issue-ready summary of the newest session', () => {
    const log = new SessionLog({ version: '9.9.9', surface: 'compact' });
    log.record('accessibility', 'find', true, 10, undefined, { name: 'cursor' }, { outcome: 'empty' });
    for (let i = 0; i < 4; i++) log.record('computer', 'screenshot', true, 200);
    log.record('computer', 'click', true, 50);
    const r = buildSessionReport(undefined, 'clicks missed the Save button');
    expect(r.session?.client).toBe('cursor');
    expect(r.session?.sequence).toBe('blind vision×4 act-coords');
    const md = reportMarkdown(r);
    expect(md).toMatch(/1 blind .* vs 4 screenshots/);
    expect(md).toMatch(/screenshots right after one: 1/);
    const url = issueUrl(r);
    expect(url.startsWith('https://github.com/AmrDab/clawdcursor/issues/new?')).toBe(true);
    expect(url.length).toBeLessThan(8000);
    expect(new URL(url).searchParams.get('title')).toBe('Report: clicks missed the Save button');
  });

  // Mac run: three calls the pause guard refused showed up as "errors: 3" in the report.
  it('lists guard refusals apart from errors', () => {
    const log = new SessionLog({ version: '9.9.9', surface: 'compact' });
    log.record('computer', 'key', false, 0, 'computer {action:"key"}: paused — a pause is waiting for the user on screen', undefined, { outcome: 'refused' });
    log.record('computer', 'click', false, 5, 'click failed: no window', undefined, { outcome: 'error' });
    const r = buildSessionReport();
    expect(r.session?.errors).toEqual(['UNKNOWN']);  // a code, never the error text
    expect(r.session?.refusals).toEqual(['PAUSED']);
    expect(reportMarkdown(r)).toMatch(/errors: 1; refused by a guard: 1/);
  });
});

describe('how a server ended', () => {
  const dayLog = () => {
    const dir = process.env.CLAWDCURSOR_LOG_DIR!;
    return fs.readdirSync(dir).filter(f => f.endsWith('.log')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  };

  it('a clean exit names its reason and the call it cut off, in the session file and the day log', () => {
    const s = new SessionLog({ version: 't', surface: 'compact' });
    s.record('window', 'list', true, 12);
    s.running('batch');
    s.end('the host closed the connection (stdin ended)');
    const lines = fs.readFileSync(s.file!, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const end = lines[lines.length - 1];
    expect(end).toMatchObject({ type: 'end', reason: 'the host closed the connection (stdin ended)', cutOff: { tool: 'batch' } });
    expect(readSession(s.file!).calls).toHaveLength(1);  // the end line is not a call
    const log = dayLog();
    expect(log.some(r => r.msg === 'tool.done' && r.meta.tool === 'window' && r.meta.ms === 12 && r.meta.outcome === 'ok')).toBe(true);
    expect(log.some(r => r.msg === 'mcp.exit' && r.level === 'warn' && r.meta.cutOff.tool === 'batch')).toBe(true);
  });

  it('end is idempotent: a second end writes nothing', () => {
    const s = new SessionLog({ version: 't', surface: 'compact' });
    s.record('window', 'list', true, 1);
    s.end('first');
    s.end('second');
    const ends = fs.readFileSync(s.file!, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'end');
    expect(ends).toEqual([expect.objectContaining({ reason: 'first' })]);
    expect(dayLog().filter(r => r.msg === 'mcp.exit' && r.meta.reason === 'second')).toHaveLength(0);
  });

  it('a daemon HTTP session closing logs session.end, not mcp.exit; one that made no call logs nothing', () => {
    const used = new SessionLog({ version: 't', surface: 'compact' });
    used.record('window', 'list', true, 1);
    used.end('session-closed-used', 'session');
    new SessionLog({ version: 't', surface: 'compact' }).end('session-closed-unused', 'session');
    const log = dayLog();
    expect(log.filter(r => r.msg === 'session.end' && r.meta.reason === 'session-closed-used')).toHaveLength(1);
    expect(log.filter(r => r.meta?.reason?.startsWith('session-closed') && r.msg === 'mcp.exit')).toHaveLength(0);
    expect(log.filter(r => r.meta?.reason === 'session-closed-unused')).toHaveLength(0);
    expect(fs.readFileSync(used.file!, 'utf8')).toMatch(/"type":"end"/);
  });

  it('a server that was killed is reported once, at the next start', async () => {
    const { reportUncleanExits } = await import('../surface/session-log');
    const dir = process.env.CLAWDCURSOR_SESSION_DIR!;
    const dead = 2147483000;  // no such process
    const file = path.join(dir, `session-2026-01-01T00-00-00-000Z-${dead}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', started: 'x', pid: dead }),
      JSON.stringify({ t: '2026-01-01T00:00:01Z', tool: 'computer', action: 'type', cls: 'act-other', ok: true, ms: 5 }),
    ].join('\n') + '\n');
    // A file from before the header had a pid: its ending was never recorded, so it is not judged.
    const old = path.join(dir, 'session-2025-01-01T00-00-00-000Z-1.jsonl');
    fs.writeFileSync(old, JSON.stringify({ type: 'session', started: 'x' }) + '\n' + JSON.stringify({ t: 'y', tool: 'window' }) + '\n');
    reportUncleanExits();
    reportUncleanExits();
    const exits = dayLog().filter(r => r.msg === 'mcp.exit' && r.meta.pid === dead);
    expect(exits).toHaveLength(1);
    expect(exits[0].meta).toMatchObject({ reason: expect.stringMatching(/killed or crashed/), lastFinishedCall: { tool: "computer", action: "type" } });
    expect(fs.readFileSync(old, 'utf8')).not.toMatch(/"end"/);
  });
});

describe('what the logs may carry', () => {
  const dayLogText = () => {
    const dir = process.env.CLAWDCURSOR_LOG_DIR!;
    return fs.readdirSync(dir).filter(f => f.endsWith('.log')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  };

  it('error text (window titles, field contents, paths) reaches neither the day log, stderr nor the session file', () => {
    const err = vi.spyOn(process.stderr, 'write');
    const log = new SessionLog({ version: 't', surface: 'compact' });
    log.record('window', 'focus', false, 3, "Window not found: title='CANARY-title Q3 salaries'");
    log.record('accessibility', 'set_value', false, 3, "set-value did not stick (got 'CANARY-field hunter2') in C:\\Users\\x\\CANARY-dir");
    const stderr = err.mock.calls.map(c => String(c[0])).join('');
    err.mockRestore();
    for (const text of [dayLogText(), stderr, fs.readFileSync(log.file!, 'utf8')]) {
      expect(text).not.toContain('CANARY');
      expect(text).not.toContain('hunter2');
    }
    expect(dayLogText()).toMatch(/"code":"NOT_FOUND"/);  // the code stays
    expect(fs.readFileSync(log.file!, 'utf8')).toMatch(/"code":"NOT_FOUND"/);
  });

  it('safety.decision logs the rule, never the target text', async () => {
    const { evaluate } = await import('../core/safety');
    const err = vi.spyOn(process.stderr, 'write');
    const d = evaluate({ tool: 'mouse_click', args: {}, targetLabel: 'Delete CANARY-invoice for Jane Roe' });
    const stderr = err.mock.calls.map(c => String(c[0])).join('');
    err.mockRestore();
    expect(d.decision).toBe('confirm');
    expect((d as { reason: string }).reason).toContain('CANARY');   // the caller still tells the user why
    const day = dayLogText();
    expect(day).toMatch(/"msg":"safety.decision".*"rule":"label_pattern:/);
    expect(day).not.toContain('CANARY');
    expect(stderr).not.toContain('CANARY');
  });

  it('a crash stack keeps its frames and drops the message and the home path', () => {
    const home = os.homedir();
    const out = safeStack(`Error: Window not found: title='CANARY'\n    at f (${home}${path.sep}proj${path.sep}a.js:1:2)\n    at g (C:\\Users\\other\\b.js:3:4)`);
    expect(out).not.toContain('CANARY');
    expect(out).not.toContain(home);
    expect(out).not.toContain('other');
    expect(out.split('\n')).toHaveLength(2);
  });
});

describe('errorClass', () => {
  it('names the class of an Error and the typeof of anything else, never the message', () => {
    class WindowError extends Error { constructor(m: string) { super(m); this.name = 'WindowError'; } }
    expect(errorClass(new WindowError("title='CANARY'"))).toBe('WindowError');
    expect(errorClass(new TypeError('CANARY'))).toBe('TypeError');
    expect(errorClass("CANARY string")).toBe('string');
    expect(errorClass({ message: 'CANARY' })).toBe('object');
    expect(errorClass(undefined)).toBe('undefined');
  });
  it('crash logs it too', () => {
    const src = fs.readFileSync(path.join(__dirname, '../surface/cli.ts'), 'utf8');
    expect(src.slice(src.indexOf("process.on('uncaughtException'"), src.indexOf("process.on('unhandledRejection'"))).toMatch(/errorClass\(/);
  });
});

describe('unhandledRejection', () => {
  it('logs the code and stack frames, never the message', () => {
    const src = fs.readFileSync(path.join(__dirname, '../surface/cli.ts'), 'utf8');
    const h = src.slice(src.indexOf("process.on('unhandledRejection'"), src.indexOf('In server mode'));
    expect(h).toMatch(/safeStack\(/);
    expect(h).toMatch(/errorClass\(/);
    expect(h).not.toMatch(/\.message/);
    expect(h).not.toMatch(/String\(reason\)/);
    expect(h).not.toMatch(/, reason\)/);
  });
});

describe('the daemon ends its session logs', () => {
  it('endAllSessions closes every session that wrote a file, once', () => {
    const used = new SessionLog({ version: 't', surface: 'compact' });
    used.record('window', 'list', true, 1);
    const unused = new SessionLog({ version: 't', surface: 'compact' });
    endAllSessions('SIGTERM');
    endAllSessions('SIGTERM');
    const lines = fs.readFileSync(used.file!, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.filter(l => l.type === 'end')).toEqual([expect.objectContaining({ reason: 'SIGTERM' })]);
    expect(fs.existsSync(unused.file!)).toBe(false);
  });

  it('every daemon exit path calls it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../surface/cli.ts'), 'utf8');
    const daemon = src.slice(src.indexOf('async function runAgentMode'));
    expect(daemon).toContain("sessionLog.end(reason, 'session')");  // an HTTP session closing is not the daemon exiting
    expect(daemon).toMatch(/onStop: async \(\) => \{\s*endAllSessions\(/);
    expect(daemon).toMatch(/process\.on\('SIGINT', \(\) => \{[\s\S]{0,150}?endAllSessions\(/);
    expect(daemon).toMatch(/process\.on\('SIGTERM', \(\) => \{[\s\S]{0,150}?endAllSessions\(/);
  });

  const deadFile = () => {
    const dead = 2147483001;
    const file = path.join(process.env.CLAWDCURSOR_SESSION_DIR!, `session-2026-01-01T00-00-00-000Z-${dead}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', started: 'x', pid: dead }) + '\n' + JSON.stringify({ t: 'y', tool: 'window', ok: true }) + '\n');
    return file;
  };

  it('a live process we may not signal (EPERM, an elevated server) is not reported', async () => {
    const { isProcessAlive } = await import('../surface/pidfile');
    const { reportUncleanExits } = await import('../surface/session-log');
    const file = deadFile();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('perm'), { code: 'EPERM' }); });
    try {
      expect(isProcessAlive(2147483001)).toBe(true);
      reportUncleanExits();
    } finally { kill.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/"end"/);
    expect(isProcessAlive(2147483001)).toBe(false);  // ESRCH: really gone
  });

  it('a server that another is already reporting is left to it', async () => {
    const { reportUncleanExits } = await import('../surface/session-log');
    const file = deadFile();
    fs.writeFileSync(`${file}.lock`, '');
    reportUncleanExits();
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/"end"/);
    fs.rmSync(`${file}.lock`);
    reportUncleanExits();
    reportUncleanExits();
    expect(fs.readFileSync(file, 'utf8').match(/"type":"end"/g)).toHaveLength(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
  // /stop ends the sessions, then waits up to 2.5 s for a running call: its line lands after the end line.
  it('a file with any end line is ended, even when a call finished after it', async () => {
    const { reportUncleanExits } = await import('../surface/session-log');
    const file = deadFile();
    fs.appendFileSync(file, JSON.stringify({ type: 'end', reason: 'stop' }) + '\n' + JSON.stringify({ t: 'z', tool: 'computer', ok: true }) + '\n');
    reportUncleanExits();
    expect(fs.readFileSync(file, 'utf8').match(/"type":"end"/g)).toHaveLength(1);
  });

  it('a lock left by a dead reporter goes stale; an orphan lock is pruned', async () => {
    const { reportUncleanExits } = await import('../surface/session-log');
    const file = deadFile();
    fs.writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${file}.lock`, old, old);
    reportUncleanExits();
    expect(fs.readFileSync(file, 'utf8')).toMatch(/"type":"end"/);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    const orphan = path.join(process.env.CLAWDCURSOR_SESSION_DIR!, 'session-2020-01-01T00-00-00-000Z-1.jsonl.lock');
    fs.writeFileSync(orphan, '');
    new SessionLog({ version: 't', surface: 'compact' });
    expect(fs.existsSync(orphan)).toBe(false);
  });
});
