/**
 * Bug telemetry (#366): what reaches the wire is only allowlisted fields with closed values, opt-out wins, stacks keep only
 * clawdcursor's own frames, and the Worker accepts what the client sends and nothing else.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ~/.clawdcursor in a temp folder: these tests write and delete the state file.
vi.mock('../paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('../paths')>();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return { ...real, DATA_DIR: mkdtempSync(join(tmpdir(), 'clawd-data-')) };
});

import { logger } from '../core/observability/logger';
import {
  offReason, reduceStack, flush, allowNames, setHost, setTelemetryEnabled, readState, toEvent, spoolBeforeExit,
  __setSenderForTests, COMMON_FIELDS, SENT_FIELDS, STATE_FILE, SPOOL_FILE, TELEMETRY_URL,
} from '../core/observability/telemetry';
import { getPackageRoot } from '../paths';
import { VERSION } from '../surface/version';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { withSteps, timeWait } from '../core/observability/steps';
import worker, { validate, validEvent, RESULT_CODES, MAX_EVENTS, MAX_BODY, type Env } from '../../telemetry-worker/src/index';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-telemetry-')), 'telemetry.json');

/** Telemetry is off in test runs; these turn it on for one test. */
function enableForTest(): string[] {
  for (const k of ['VITEST', 'NODE_ENV', 'CI', 'DO_NOT_TRACK', 'CLAWD_TELEMETRY']) vi.stubEnv(k, '');
  const bodies: string[] = [];
  __setSenderForTests(async (_url, body) => { bodies.push(body); });
  return bodies;
}

afterEach(() => {
  vi.unstubAllEnvs();
  __setSenderForTests(null);
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(SPOOL_FILE, { force: true });
  vi.restoreAllMocks();
});

describe('what is sent', () => {
  it('a window title, a URL, a user path, an email and typed text never reach the payload', async () => {
    const bodies = enableForTest();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    allowNames(['computer', 'type', 'browser', 'navigate']);
    const root = getPackageRoot();
    const title = 'Inbox - Quarterly Secrets - Outlook';
    const url = 'https://bank.example.com/account?id=991';
    const userPath = 'C:\\Users\\alice\\Documents\\secret.txt';
    const email = 'alice@example.com';
    const typed = 'hunter2 my password';

    logger.info('mcp.start', { version: '1.0.0', pid: 4242, hostPid: 77, surface: 'compact', readyMs: 30, title });
    setHost('claude-code');
    logger.info('tool.done', { tool: 'computer', action: 'type', ms: 1234, outcome: 'error', code: 'NOT_FOUND', app: 'Quarterly Secrets Viewer', text: typed, title, error: userPath });
    logger.info('tool.done', { tool: 'computer', action: url, ms: 9, outcome: 'timeout', code: email, app: 'chrome' });
    logger.info('tool.done', { tool: typed, ms: 12_000, outcome: 'ok',
      steps: { powershell: { n: 2, ms: 5000 }, [userPath]: { n: 1, ms: 3000 }, notepad: { n: 1, ms: 2000 }, 'ps-bridge find-element': { n: 1, ms: 1500 } } });
    logger.warn('mcp.exit', { reason: `stdin error: ${title} ${email}`, pid: 4242, cutOff: { tool: 'computer', action: 'type', ranMs: 300 } });
    logger.error('crash', { name: 'TypeError', code: 'ENOENT', message: typed,
      stack: [`    at run (${root}${path.sep}dist${path.sep}surface${path.sep}cli.js:10:5)`, `    at ${userPath}:1:1`,
        '    at node:internal/process/task_queues:95:5', `    at ${root}/node_modules/dep/index.js:3:3`].join('\n') });
    logger.info('tool.done', { tool: 'computer', action: 'type', ms: 50, outcome: 'ok' });   // a call that worked: nothing

    await flush();
    const body = bodies.join('\n');
    for (const canary of [title, url, 'alice', email, typed, 'hunter2', 'notepad', 'secret', '4242', 'bank.example']) {
      expect(body).not.toContain(canary);
    }
    const events = bodies.flatMap(b => JSON.parse(b) as Array<Record<string, unknown>>);
    expect(events.map(e => e.event)).toEqual(['start', 'call_failed', 'call_failed', 'slow_call', 'exit', 'crash']);
    for (const e of events) {
      expect(Object.keys(e).every(k => (COMMON_FIELDS as readonly string[]).includes(k) || SENT_FIELDS[e.event as string].includes(k))).toBe(true);
      expect(validEvent(e)).toBe(true);   // the Worker takes everything the client sends
    }
    expect(events[0]).toMatchObject({ host: 'claude-code', surface: 'compact' });
    expect(events[1]).toMatchObject({ tool: 'computer', action: 'type', code: 'NOT_FOUND', outcome: 'error', app: 'native' });
    expect(events[2]).toMatchObject({ action: 'other', app: 'browser' });
    expect(events[2]).not.toHaveProperty('code');
    expect(events[3]).toMatchObject({ tool: 'other', steps: [{ name: 'powershell', ms: 5000, n: 2 }, { name: 'other', ms: 3000, n: 1 },
      { name: 'other', ms: 2000, n: 1 }, { name: 'ps-bridge find-element', ms: 1500, n: 1 }] });
    expect(events[4]).toMatchObject({ reason: 'stdin_error', tool: 'computer', action: 'type', ms: 300 });
    expect(events[5]).toMatchObject({ kind: 'uncaught', cls: 'TypeError', code: 'ENOENT', frames: ['dist/surface/cli.js:10'] });
    expect(new Set(events.map(e => e.id)).size).toBe(1);
  });

  it('a clean exit with nothing running is not sent; a kill found at the next start sends the reason alone', () => {
    allowNames(['accessibility', 'read_tree']);
    expect(toEvent('mcp.exit', { reason: 'the host closed the connection (stdin ended)', pid: 1 })).toBeNull();
    // lastFinishedCall worked: it is not the call the kill cut off.
    const killed = toEvent('mcp.exit', { reason: 'killed or crashed: no clean exit was recorded', pid: 1, detectedAt: 'next start',
      lastFinishedCall: { tool: 'accessibility', action: 'read_tree' } });
    expect(killed).toMatchObject({ event: 'exit', reason: 'killed_or_crashed' });
    expect(killed).not.toHaveProperty('tool');
  });

  it('an exit keeps what is queued for the next start instead of waiting on the network', async () => {
    const bodies = enableForTest();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
    spoolBeforeExit();
    expect(bodies).toEqual([]);
    expect(fs.existsSync(SPOOL_FILE)).toBe(true);
    await flush();   // the next process's first flush
    expect(bodies.flatMap(b => JSON.parse(b) as unknown[])).toHaveLength(1);
    expect(fs.existsSync(SPOOL_FILE)).toBe(false);
  });

  it('slow_call counts only clawdcursor\'s own time: a wait for the user, `wait` or a wait_for is slow by design', async () => {
    allowNames(['system', 'pause_for_user', 'batch']);
    // A wait is timed as the step "wait", inside the call.
    const run = await withSteps('system', 'pause_for_user', () => timeWait(() => new Promise(r => setTimeout(r, 20))));
    expect(run.steps.wait).toMatchObject({ n: 1 });
    // The real `wait` a batch step runs is timed the same way.
    const wait = getAllTools().find(t => t.name === 'wait')!;
    const inBatch = await withSteps('batch', undefined, () => wait.handler({ seconds: 0.1 }, {} as never));
    expect(inBatch.steps.wait).toMatchObject({ n: 1 });
    expect(toEvent('tool.done', { tool: 'system', action: 'pause_for_user', ms: 45_000, outcome: 'ok', steps: { wait: { n: 1, ms: 44_990 } } })).toBeNull();
    // A batch that waited 20 s and spent 13 s on its own work: slow, by its own work, without the wait.
    expect(toEvent('tool.done', { tool: 'batch', ms: 33_000, outcome: 'ok', steps: { wait: { n: 2, ms: 20_000 }, powershell: { n: 4, ms: 12_000 } } }))
      .toMatchObject({ event: 'slow_call', tool: 'batch', ms: 13_000, steps: [{ name: 'powershell', ms: 12_000, n: 4 }] });
  });

  it('an empty result (a find that found nothing) is not a failed call', () => {
    allowNames(['accessibility', 'find']);
    expect(toEvent('tool.done', { tool: 'accessibility', action: 'find', ms: 300, outcome: 'empty' })).toBeNull();
    expect(validEvent({ event: 'call_failed', id: '0f8fad5b-d9cb-469f-a165-70867728950e', v: VERSION, os: 'win32', tool: 'x', outcome: 'empty', ms: 1, app: 'native' })).toBe(false);
  });

  it('the 200-event cap is per UTC day: a long-running daemon reports again the next day', async () => {
    const bodies = enableForTest();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
      for (let i = 0; i < 201; i++) logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
      await flush();
      expect(bodies.flatMap(b => JSON.parse(b) as unknown[])).toHaveLength(200);
      bodies.length = 0;
      vi.setSystemTime(new Date('2030-01-02T00:00:01Z'));
      logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
      await flush();
      expect(bodies.flatMap(b => JSON.parse(b) as unknown[])).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('goes to the project\'s own domain, never a host anyone could register', () => {
    expect(new URL(TELEMETRY_URL).hostname).toMatch(/(^|\.)clawdcursor\.com$/);
  });

  it('the notice goes to stderr once, and is remembered', () => {
    enableForTest();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write');
    logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
    logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
    const notices = err.mock.calls.filter(c => String(c[0]).includes('clawdcursor optout'));
    expect(notices).toHaveLength(1);
    expect(out.mock.calls.some(c => String(c[0]).includes('optout'))).toBe(false);
    expect(readState().noticeShown).toBe(true);
  });

  it('opting out drops what is queued', async () => {
    const bodies = enableForTest();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
    expect(setTelemetryEnabled(false)).toBe(true);
    await flush();
    expect(bodies).toEqual([]);
  });
});

describe('when it is off', () => {
  it('the environment wins over the file; the file wins over the default', () => {
    const file = tmpFile();
    expect(offReason({}, file)).toBeNull();                                   // missing file: on
    expect(offReason({ CLAWD_TELEMETRY: '0' }, file)).toBe('CLAWD_TELEMETRY');
    expect(offReason({ CLAWD_TELEMETRY: 'off' }, file)).toBe('CLAWD_TELEMETRY');
    expect(offReason({ DO_NOT_TRACK: '1' }, file)).toBe('DO_NOT_TRACK');
    expect(offReason({ CI: 'true' }, file)).toBe('CI');
    expect(offReason({ CI: 'false' }, file)).toBeNull();
    expect(offReason({ CLAWD_FENCE_PIDS: '4120,4188' }, file)).toBe('CLAWD_FENCE_PIDS');   // a benchmark run (bench/lib/isolated.ts)
    expect(offReason({ VITEST: 'true' }, file)).toBe('test run');
    expect(offReason({ NODE_ENV: 'test' }, file)).toBe('test run');
    setTelemetryEnabled(false, file);
    expect(offReason({}, file)).toBe('clawdcursor optout');
    expect(offReason({ CLAWD_TELEMETRY: '1' }, file)).toBe('clawdcursor optout');   // the env only turns it off
    setTelemetryEnabled(true, file);
    expect(offReason({}, file)).toBeNull();
    expect(offReason({ CI: '1' }, file)).toBe('CI');
  });

  it('an unreadable file is on with a random id, and the id stays once written', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    const s = readState(file);
    expect(s.enabled).toBe(true);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    setTelemetryEnabled(true, file);
    expect(readState(file).id).toBe(s.id);
  });

  it('a hand-written {"enabled":false} is off, and stays off after an event', () => {
    enableForTest();
    fs.writeFileSync(STATE_FILE, '{"enabled":false}');
    expect(offReason()).toBe('clawdcursor optout');
    logger.info('tool.done', { tool: 'x', ms: 1, outcome: 'error' });
    expect(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))).toEqual({ enabled: false });
  });
});

describe('reduceStack', () => {
  it('keeps clawdcursor\'s own file:line, drops Node, dependencies and anything outside the package', () => {
    const stack = [
      'TypeError: Cannot read properties of undefined (reading \'hunter2\')',
      '    at Object.run (C:\\pkg\\dist\\tools\\a11y.js:12:7)',
      '    at C:\\pkg\\dist\\surface\\mcp-server.js:400:3',
      '    at file:///C:/pkg/dist/core/control.js:5:1',
      '    at ~\\pkg\\dist\\core\\fence.js:9:2',
      '    at C:\\pkg\\node_modules\\zod\\index.js:1:1',
      '    at C:\\Users\\bob\\other\\x.js:1:1',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    expect(reduceStack(stack, ['C:/pkg', '~/pkg'])).toEqual([
      'dist/tools/a11y.js:12', 'dist/surface/mcp-server.js:400', 'dist/core/control.js:5', 'dist/core/fence.js:9',
    ]);
    expect(reduceStack('    at /usr/lib/node_modules/clawdcursor/dist/cli.js:3:1', ['/usr/lib/node_modules/clawdcursor'])).toEqual(['dist/cli.js:3']);
    expect(reduceStack(undefined)).toEqual([]);
  });
});

describe('the Worker', () => {
  const good = { event: 'call_failed', id: '0f8fad5b-d9cb-469f-a165-70867728950e', v: VERSION, os: 'win32',
    tool: 'computer', action: 'click', code: 'NOT_FOUND', outcome: 'error', ms: 120, app: 'native' };

  it('accepts a good batch', () => {
    const start = { event: 'start', id: good.id, v: '2.0.1-beta.1', os: 'darwin', osVer: 24, arch: 'arm64', node: 22, host: 'other', surface: 'granular' };
    expect(validate(JSON.stringify([good, start]))).toHaveLength(2);
  });

  it('drops an event with an extra field, a wrong value or a missing field', () => {
    const bad = [
      { ...good, title: 'Inbox' },
      { ...good, app: 'Outlook' },
      { ...good, action: 'C:\\Users\\alice' },
      { ...good, ms: -1 },
      { ...good, ms: '120' },
      { ...good, event: 'usage' },
      { ...good, id: 'not-a-uuid' },
      { ...good, code: 'free text' },
      (({ outcome: _o, ...rest }) => rest)(good),
      { ...good, event: 'crash', kind: 'uncaught', cls: 'Error', frames: ['C:\\Users\\alice\\x.js:1'] },
      { event: 'slow_call', id: good.id, v: good.v, os: good.os, tool: 'computer', ms: 12000, steps: [{ name: 'keepassxc', ms: 2000, n: 1 }] },
    ];
    expect(validate(JSON.stringify([...bad, good]))).toEqual([good]);
  });

  it('drops, without throwing, an extra field named after an Object.prototype member', () => {
    const text = '"alice@example.com https://bank.example/x"';
    const g = JSON.stringify(good).slice(0, -1);
    for (const k of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(validate(`[${g},"${k}":${text}}, ${JSON.stringify(good)}]`)).toEqual([good]);
    }
  });

  it('takes every tool and action name clawdcursor registers', () => {
    for (const t of [...getAllTools(), ...getCompactSurface()]) {
      for (const action of [undefined, ...(t.parameters.action?.enum ?? [])]) {
        expect(validEvent(JSON.parse(JSON.stringify({ ...good, tool: t.name, action }))), `${t.name} ${action ?? ''}`).toBe(true);
      }
    }
  });

  it('rejects a body that is not a JSON array, too long, or too big', () => {
    expect(validate('{"event":"start"}')).toBeNull();
    expect(validate('not json')).toBeNull();
    expect(validate(JSON.stringify(Array(MAX_EVENTS + 1).fill(good)))).toBeNull();
    expect(validate(JSON.stringify([{ ...good, pad: 'x'.repeat(33 * 1024) }]))).toBeNull();
  });

  it('refuses a body declared too big before reading it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const req = { url: 'https://telemetry.clawdcursor.com/v1/events', method: 'POST',
      headers: new Headers({ 'content-length': String(MAX_BODY + 1) }), arrayBuffer } as unknown as Request;
    expect((await worker.fetch(req, {} as Env)).status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('knows every result code the client can send', () => {
    const src = fs.readFileSync(path.join(getPackageRoot(), 'src', 'core', 'result-codes.ts'), 'utf8');
    const union = /export type ResultCode =([^;]+);/.exec(src)![1];
    expect([...union.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort()).toEqual([...RESULT_CODES].sort());
  });
});
