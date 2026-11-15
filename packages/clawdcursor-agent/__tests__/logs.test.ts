import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dayFiles, formatRecord, matches, parseLines, parseSince, sessionFilter, shown, stepsText, type LogRecord } from '../src/logs';
import { findSession } from '../src/runlog';
import { paint } from '../src/trace';

/** Day-log lines as the logger writes them: two servers (pids 100 and 200) at once, and one line from before records had a pid. */
const DAY = [
  { ts: '2026-11-15T10:00:00.000Z', level: 'info', msg: 'mcp.start', pid: 100, meta: { version: '2.0.0', pid: 100, hostPid: 9, surface: 'compact', readyMs: 1054 } },
  { ts: '2026-11-15T10:00:01.000Z', level: 'info', msg: 'safety.decision', pid: 100, meta: { decision: 'allow' } },
  { ts: '2026-11-15T10:00:02.000Z', level: 'info', msg: 'tool.done', pid: 100, meta: { tool: 'computer', action: 'screenshot', ms: 1519, outcome: 'ok', steps: { 'ps-bridge list-displays': { n: 1, ms: 3 } } } },
  { ts: '2026-11-15T10:00:03.000Z', level: 'info', msg: 'tool.done', pid: 200, meta: { tool: 'window', action: 'list', ms: 241, outcome: 'ok' } },
  { ts: '2026-11-15T10:00:04.000Z', level: 'info', msg: 'step.slow', pid: 100, meta: { step: 'powershell', ms: 1192 } },
  { ts: '2026-11-15T10:00:05.000Z', level: 'info', msg: 'tool.done', pid: 100, meta: { tool: 'window', action: 'open_file', ms: 7413, outcome: 'error', code: 'UNKNOWN',
    steps: { 'ps-bridge list-windows': { n: 10, ms: 1955 }, powershell: { n: 2, ms: 1404 } } } },
  { ts: '2026-11-15T10:00:06.000Z', level: 'warn', msg: 'control.stop', pid: 100, meta: { by: 'pill', pid: 100 } },
  { ts: '2026-11-15T10:00:07.000Z', level: 'warn', msg: 'safety.refused', pid: 100, meta: { tool: 'computer', action: 'type', guard: 'stopped', reason: 'stopped by the user' } },
  { ts: '2026-11-15T10:00:08.000Z', level: 'info', msg: 'pause.end', pid: 100, meta: { outcome: 'replied' } },
  { ts: '2026-11-15T10:00:09.000Z', level: 'info', msg: 'tool.done', meta: { tool: 'system', action: 'system_time', ms: 21, outcome: 'ok' } },
  { ts: '2026-11-15T10:00:10.000Z', level: 'info', msg: 'mcp.exit', pid: 100, meta: { reason: 'the host closed the connection (stdin ended)', pid: 100 } },
  // pid 200 was killed: the next server (pid 300) reports it.
  { ts: '2026-11-15T10:05:00.000Z', level: 'warn', msg: 'mcp.exit', pid: 300, meta: { reason: 'killed or crashed: no clean exit was recorded', pid: 200, detectedAt: 'next start' } },
] as LogRecord[];

const pick = (f: Parameters<typeof matches>[1]) => DAY.filter(r => matches(r, f)).map(r => `${r.msg}:${r.meta?.tool ?? ''}${r.meta?.action ? `.${r.meta.action}` : ''}`);

describe('logs: what is shown', () => {
  it('tool calls and control events; not the per-call safety decisions or step.slow (tool.done has the steps)', () => {
    expect(shown(DAY[1])).toBe(false);
    expect(shown(DAY[4])).toBe(false);
    expect(DAY.filter(shown)).toHaveLength(DAY.length - 2);
  });
});

describe('logs filters', () => {
  it('--tool: a tool, tool.action, or an action', () => {
    expect(pick({ tool: 'window' })).toEqual(['tool.done:window.list', 'tool.done:window.open_file']);
    expect(pick({ tool: 'computer.type' })).toEqual(['safety.refused:computer.type']);
    expect(pick({ tool: 'screenshot' })).toEqual(['tool.done:computer.screenshot']);
  });

  it('--errors: failed calls, refusals, stops and warnings; not ok calls', () => {
    expect(pick({ errors: true })).toEqual(['tool.done:window.open_file', 'control.stop:', 'safety.refused:computer.type', 'mcp.exit:']);
  });

  it('--since: only what came after', () => {
    expect(parseSince('10m', Date.parse('2026-11-15T10:10:00Z'))).toBe(Date.parse('2026-11-15T10:00:00Z'));
    expect(parseSince('2h', 0)).toBe(-7_200_000);
    expect(() => parseSince('yesterday')).toThrow(/--since takes a duration/);
    expect(pick({ sinceMs: Date.parse('2026-11-15T10:00:08.500Z') })).toEqual(['tool.done:system.system_time', 'mcp.exit:', 'mcp.exit:']);
  });

  it('--session: that server\'s records only (by pid), within its time', () => {
    const s = { pid: 100, fromMs: Date.parse('2026-11-15T10:00:02Z'), toMs: Date.parse('2026-11-15T10:00:15Z') };
    const got = pick({ session: s });
    expect(got).toContain('mcp.start:');             // before its first call made the session file
    expect(got).toContain('tool.done:computer.screenshot');
    expect(got).not.toContain('tool.done:window.list');   // pid 200's call at the same time
    expect(got).toContain('tool.done:system.system_time');   // an old line with no pid: matched on time
  });

  it('--session of a killed server includes its exit, reported by the next server', () => {
    const s = { pid: 200, fromMs: Date.parse('2026-11-15T10:00:03Z'), toMs: Date.parse('2026-11-15T10:05:05Z') };
    expect(pick({ session: s })).toEqual(['tool.done:window.list', 'tool.done:system.system_time', 'mcp.exit:']);
  });

  it('filters combine', () => {
    expect(pick({ tool: 'window', errors: true })).toEqual(['tool.done:window.open_file']);
  });
});

describe('logs lines', () => {
  const p = paint(false);
  it('a call with its outcome, code, time and where the time went (slowest first)', () => {
    expect(formatRecord(DAY[5], p)).toBe('window.open_file  error UNKNOWN  7413 ms  · ps-bridge list-windows 10× 1955 ms, powershell 2× 1404 ms');
    expect(formatRecord(DAY[2], p)).toBe('computer.screenshot  ok  1519 ms  · ps-bridge list-displays 1× 3 ms');
    expect(stepsText(undefined)).toBe('');
  });
  it('control events: who stopped, which guard refused, how a pause ended, server start and exit', () => {
    expect(formatRecord(DAY[6], p)).toBe('■ control.stop  by pill');
    expect(formatRecord(DAY[7], p)).toBe('⊘ safety.refused  computer.type · guard stopped');
    expect(formatRecord(DAY[8], p)).toBe('‖ pause.end  outcome=replied');
    expect(formatRecord(DAY[0], p)).toBe('● mcp.start  v2.0.0 · pid 100 · compact · ready 1054 ms');
    expect(formatRecord(DAY[11], p)).toBe('○ mcp.exit  pid 200 · killed or crashed: no clean exit was recorded · seen at the next start');
  });
  it('torn and foreign lines are skipped', () => {
    expect(parseLines(`${JSON.stringify(DAY[0])}\n{"ts":\nplain text\n`)).toHaveLength(1);
  });
});

describe('logs files', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-logs-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('day files from --since\'s day on, rotated parts first (oldest first); else the newest day', () => {
    for (const f of ['clawdcursor-20261113.log', 'clawdcursor-20261114.log', 'clawdcursor-20261114.log.0', 'clawdcursor-20261114.log.1', 'clawdcursor-20261115.log', 'other.txt']) {
      fs.writeFileSync(path.join(dir, f), '');
    }
    expect(dayFiles(dir).map(f => path.basename(f))).toEqual(['clawdcursor-20261115.log']);
    expect(dayFiles(dir, Date.parse('2026-11-14T12:00:00Z')).map(f => path.basename(f)))
      .toEqual(['clawdcursor-20261114.log.1', 'clawdcursor-20261114.log.0', 'clawdcursor-20261114.log', 'clawdcursor-20261115.log']);
  });

  it('a session by id or "last", with its pid and its time', () => {
    const write = (name: string, lines: object[]) => fs.writeFileSync(path.join(dir, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    write('session-2026-11-15T10-00-00-000Z-100-1.jsonl', [{ type: 'session', started: '2026-11-15T10:00:02.000Z', pid: 100, run: 'r1' },
      { t: '2026-11-15T10:00:02.000Z', tool: 'computer' }, { type: 'end', t: '2026-11-15T10:00:10.000Z', reason: 'x' }]);
    write('session-2026-11-15T11-00-00-000Z-300-1.jsonl', [{ type: 'session', started: '2026-11-15T11:00:00.000Z', pid: 300 }]);
    expect(findSession(dir, 'last')).toMatchObject({ id: 'session-2026-11-15T11-00-00-000Z-300-1', pid: 300, ended: null });
    const s = findSession(dir, 'session-2026-11-15T10-00-00-000Z-100-1')!;
    expect(s).toMatchObject({ pid: 100, run: 'r1', started: '2026-11-15T10:00:02.000Z', ended: '2026-11-15T10:00:10.000Z' });
    expect(sessionFilter(s)).toEqual({ pid: 100, fromMs: Date.parse('2026-11-15T10:00:02Z'), toMs: Date.parse('2026-11-15T10:00:15Z') });
    expect(findSession(dir, 'session-nope')).toBeNull();
  });
});
