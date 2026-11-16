/**
 * `clawdcursor agent`'s live log (surface/live-log.ts): the line for each event, and the follower of the shared day log
 * (starts at its end, joins a torn line, survives a rotation and a missing file, moves to the next day's file).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pc from 'picocolors';
import { formatLiveLine, followDayLog, startAgentLiveLog, type LiveLog } from '../surface/live-log';
import { logger } from '../core/observability/logger';

const plain = pc.createColors(false);
const OWN = 100;
// 08:58:10 local time, whatever the machine's time zone: the clock column is local.
const TS = new Date(2026, 10, 16, 8, 58, 10).toISOString();
const line = (msg: string, meta?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  formatLiveLine({ ts: TS, level: 'info', msg, pid: 44116, ...(meta ? { meta } : {}), ...extra }, OWN, plain);

describe('formatLiveLine', () => {
  it('a tool call: time, source, tool and action, outcome with its code, duration', () => {
    expect(line('tool.done', { tool: 'computer', action: 'click', ms: 12, outcome: 'ok' }))
      .toBe('08:58:10  mcp 44116  computer click  ok  12 ms');
    expect(line('tool.done', { tool: 'computer', action: 'key', ms: 3, outcome: 'refused', code: 'STOPPED' }))
      .toBe('08:58:10  mcp 44116  computer key  refused · STOPPED  3 ms');
    expect(line('tool.done', { tool: 'accessibility', action: 'invoke', ms: 851.4, outcome: 'error', code: 'NOT_FOUND' }))
      .toBe('08:58:10  mcp 44116  accessibility invoke  failed · NOT_FOUND  851 ms');
    expect(line('tool.done', { tool: 'system', action: 'pause_for_user', ms: 45_000, outcome: 'ok' }))
      .toBe('08:58:10  mcp 44116  system pause_for_user  ok  45.0 s');
    expect(line('tool.done', { tool: 'window', action: 'list', ms: 0, outcome: 'consent_required' }))
      .toBe('08:58:10  mcp 44116  window list  refused · CONSENT_REQUIRED  0 ms');
    expect(line('tool.done', { tool: 'read_screen', ms: 40, outcome: 'empty' }))
      .toBe('08:58:10  mcp 44116  read_screen  empty  40 ms');
  });

  it('the daemon\'s own lines say "agent"', () => {
    expect(line('tool.done', { tool: 'computer', action: 'wait', ms: 3008, outcome: 'ok' }, { pid: OWN }))
      .toBe('08:58:10  agent      computer wait  ok  3008 ms');
  });

  it('a server connecting and leaving; a 2.0.0 writer has its pid only in the event', () => {
    expect(line('mcp.start', { version: '2.1.0', pid: 44116, hostPid: 31464, surface: 'compact', readyMs: 4300 }))
      .toBe('08:58:10  mcp 44116  connected (compact, v2.1.0)');
    expect(line('mcp.exit', { reason: 'the host closed the connection (stdin ended)', pid: 11044 }, { pid: undefined }))
      .toBe('08:58:10  mcp 11044  left (the host closed the connection (stdin ended))');
    // An unclean exit is written by the next server: the line is about the one that went.
    expect(formatLiveLine({ ts: TS, level: 'warn', msg: 'mcp.exit', pid: OWN,
      meta: { reason: 'killed or crashed: no clean exit was recorded', pid: 9000, detectedAt: 'next start' } }, OWN, plain))
      .toBe('08:58:10  mcp 9000   left (killed or crashed: no clean exit was recorded)');
  });

  it('pause, stop and resume', () => {
    expect(line('pause.start')).toBe('08:58:10  mcp 44116  waiting for you');
    expect(line('pause.end', { outcome: 'replied' })).toBe('08:58:10  mcp 44116  pause answered: replied');
    expect(line('control.stop', { by: 'pill', pid: OWN }, { level: 'warn' })).toBe('08:58:10  agent      stopped (by pill)');
    expect(line('control.resume', { by: 'cli', pid: 44116 })).toBe('08:58:10  mcp 44116  resumed (by cli)');
  });

  it('everything else is left out', () => {
    for (const msg of ['step.slow', 'safety.refused', 'session.end', 'crash', 'host.ancestry_failed', 'agent.think']) {
      expect(line(msg, { tool: 'computer', text: 'x' })).toBeNull();
    }
    expect(formatLiveLine({}, OWN, plain)).toBeNull();
  });

  it('prints no typed, clipboard or screen text, even from a record that carries it', () => {
    const typed = 'hunter2 my secret';
    const out = [
      line('tool.done', { tool: 'computer', action: typed, ms: 5, outcome: 'ok', app: 'Quarterly Secrets Viewer', text: typed,
        title: 'Inbox - me@example.com', code: `NOT ${typed}`, error: typed }),
      line('tool.done', { tool: typed, ms: 5, outcome: typed }),
      line('control.stop', { by: typed }),
      line('pause.end', { outcome: typed, reply: typed }),
      line('mcp.start', { surface: typed, version: typed }),
    ].join('\n');
    expect(out).not.toMatch(/hunter2|secret|Secrets|example\.com|Inbox/i);
    expect(out).toContain('computer  ok  5 ms');
    expect(out).toContain('?  failed  5 ms');
  });

  it('an exit reason is one short line with no terminal escapes', () => {
    const esc = String.fromCharCode(27);
    const got = line('mcp.exit', { reason: `stdin error: ${esc}[2Jboom\nnext line ${'x'.repeat(200)}`, pid: 7 })!;
    expect(got).not.toContain(esc);
    expect(got).not.toContain('\n');
    expect(got.length).toBeLessThan(120);
  });

  it('colours: ok green, refused yellow, failed red', () => {
    const c = pc.createColors(true);
    const ok = formatLiveLine({ ts: TS, msg: 'tool.done', meta: { tool: 'computer', outcome: 'ok' } }, OWN, c)!;
    const refused = formatLiveLine({ ts: TS, msg: 'tool.done', meta: { tool: 'computer', outcome: 'refused' } }, OWN, c)!;
    const failed = formatLiveLine({ ts: TS, msg: 'tool.done', meta: { tool: 'computer', outcome: 'timeout' } }, OWN, c)!;
    expect(ok).toContain(c.green('ok'));
    expect(refused).toContain(c.yellow('refused'));
    expect(failed).toContain(c.red('failed'));
  });
});

// ── The follower ──

const DAY1 = new Date('2026-11-16T12:00:00Z');
const rec = (msg: string, meta: Record<string, unknown>, pid = 44116) =>
  JSON.stringify({ ts: DAY1.toISOString(), level: 'info', msg, pid, meta }) + '\n';
const done = (action: string) => rec('tool.done', { tool: 'computer', action, ms: 7, outcome: 'ok' });

let follower: LiveLog | null = null;
afterEach(() => { follower?.stop(); follower = null; vi.useRealTimers(); });

function setup(now: () => Date = () => DAY1) {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-livelog-'));
  const file = path.join(dir, 'clawdcursor-20261116.log');
  const lines: string[] = [];
  const start = () => { follower = followDayLog({ dir, now, ownPid: OWN, colors: plain, out: l => lines.push(l) }); };
  const poll = () => vi.advanceTimersByTime(500);
  return { dir, file, lines, start, poll };
}

describe('followDayLog', () => {
  it('starts at the end of the day log: only lines written from then on are printed', () => {
    const t = setup();
    fs.writeFileSync(t.file, done('before') + rec('step.slow', { step: 'x' }));
    t.start();
    t.poll();
    expect(t.lines).toEqual([]);
    fs.appendFileSync(t.file, done('after') + rec('step.slow', { step: 'y' }));
    t.poll();
    expect(t.lines.map(l => l.slice(10))).toEqual(['mcp 44116  computer after  ok  7 ms']);
  });

  it('a line torn across two reads is printed once, whole, even inside a UTF-8 character', () => {
    const t = setup();
    t.start();
    const whole = Buffer.from(rec('mcp.exit', { reason: 'stdin error: café', pid: 5 }), 'utf8');
    const cut = whole.indexOf(Buffer.from('é', 'utf8')) + 1;   // between the two bytes of é
    fs.writeFileSync(t.file, whole.subarray(0, cut));
    t.poll();
    expect(t.lines).toEqual([]);
    fs.appendFileSync(t.file, whole.subarray(cut));
    t.poll();
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain('mcp 5      left (stdin error: café)');
  });

  it('a missing day log is waited for; a rotated one (smaller, same name) is read from its top', () => {
    const t = setup();
    t.start();
    t.poll();   // no file yet: nothing, no throw
    fs.writeFileSync(t.file, done('first') + done('second'));
    t.poll();
    expect(t.lines.map(l => l.slice(10))).toEqual(['mcp 44116  computer first  ok  7 ms', 'mcp 44116  computer second  ok  7 ms']);
    fs.renameSync(t.file, `${t.file}.0`);   // logger.ts rotateIfNeeded
    t.poll();
    fs.writeFileSync(t.file, done('third'));
    t.poll();
    expect(t.lines.map(l => l.slice(10))).toContain('mcp 44116  computer third  ok  7 ms');
    expect(t.lines).toHaveLength(3);
  });

  it('moves to the next UTC day\'s file, after the last lines of the old one', () => {
    let now = new Date('2026-11-16T23:59:59Z');
    const t = setup(() => now);
    fs.writeFileSync(t.file, done('old'));
    t.start();
    fs.appendFileSync(t.file, done('last_of_the_day'));
    now = new Date('2026-11-17T00:00:01Z');
    const next = path.join(t.dir, 'clawdcursor-20261117.log');
    fs.writeFileSync(next, done('new_day'));
    t.poll();
    expect(t.lines.map(l => l.slice(10))).toEqual(['mcp 44116  computer last_of_the_day  ok  7 ms', 'mcp 44116  computer new_day  ok  7 ms']);
    fs.appendFileSync(next, done('later'));
    t.poll();
    expect(t.lines).toHaveLength(3);
  });

  it('stop() ends it', () => {
    const t = setup();
    t.start();
    follower!.stop();
    fs.writeFileSync(t.file, done('after_stop'));
    t.poll();
    expect(t.lines).toEqual([]);
  });
});

describe('startAgentLiveLog (what runAgentMode calls once the daemon is ready)', () => {
  it('not a terminal (a service, a pipe): nothing extra, no follower', () => {
    const write = vi.fn();
    expect(startAgentLiveLog({ isTTY: false, write })).toBeNull();
    expect(startAgentLiveLog({ write })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('a terminal: the heading, then the live log; the daemon\'s own events print there only once', () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-livelog-'));
    const written: string[] = [];
    follower = startAgentLiveLog({ isTTY: true, write: (s: string) => written.push(s) }, { dir, now: () => DAY1, colors: plain });
    expect(follower).not.toBeNull();
    expect(written).toEqual(['Live log of every clawdcursor action on this computer (Ctrl+C to stop):\n']);
    fs.writeFileSync(path.join(dir, 'clawdcursor-20261116.log'), done('typed'));
    vi.advanceTimersByTime(500);
    expect(written[1]).toContain('computer typed  ok  7 ms');

    // The logger stops echoing the live log's events to the terminal (the file still gets them); others still echo.
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.info('tool.done', { tool: 'computer', action: 'click', ms: 1, outcome: 'ok' });
      logger.info('step.slow', { step: 'x', ms: 1 });
      const echoed = err.mock.calls.map(c => String(c[0])).join('');
      expect(echoed).not.toContain('tool.done');
      expect(echoed).toContain('step.slow');
    } finally { err.mockRestore(); }
  });
});
