import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Watchdog, readSessionCalls, tailSessionDir, type Proof } from '../lib/watchdog';
import { appKey } from '../lib/rules';
import type { LogCall } from '../lib/types';

vi.useRealTimers();

const call = (tool: string, action: string, cls: LogCall['cls'], extra: Partial<LogCall> = {}): LogCall =>
  ({ t: new Date().toISOString(), tool, action, cls, ok: true, ms: 10, outcome: 'ok', ...extra });
/** By default the runner can prove everything: the tests of the other rules are not about privacy. */
const dog = (over: Partial<{ maxCalls: number; maxSeconds: number; fixtureApps: string[] }> = {}, proof: Partial<Proof> = {}) =>
  new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Edge'], ...over }, { ownsFocus: () => true, cdpIsFixture: () => true, ...proof });

describe('the watchdog rules', () => {
  it('lets a normal run through', () => {
    const d = dog();
    expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
    for (let i = 0; i < 5; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name', { app: 'Edge' }))).toBeNull();
    expect(d.onCall(call('accessibility', 'invoke', 'act-name', { app: 'Edge' }))).toBeNull();
    expect(d.onTime(59)).toBeNull();
  });

  describe('loop: the same call 3 times in a row', () => {
    it('by adapter signature', () => {
      const d = dog();
      expect(d.onSig({ tool: 'computer', sig: 'a' })).toBeNull();
      expect(d.onSig({ tool: 'computer', sig: 'a' })).toBeNull();
      expect(d.onSig({ tool: 'computer', sig: 'a' })).toMatchObject({ rule: 'loop' });
    });
    it('not when another call comes in between', () => {
      const d = dog();
      for (const sig of ['a', 'a', 'b', 'a', 'a']) expect(d.onSig({ tool: 'computer', sig })).toBeNull();
    });
    it('from the log alone: the same read three times', () => {
      const d = dog();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toMatchObject({ rule: 'loop' });
    });
    it('from the log alone: three actions of one kind are not a loop (the log has no arguments)', () => {
      const d = dog();
      for (let i = 0; i < 6; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name', { app: 'Edge' }))).toBeNull();
    });
    it('once signatures arrive, the log comparison is off: three reads of different things pass', () => {
      const d = dog();
      for (const sig of ['a', 'b', 'c']) {
        expect(d.onSig({ tool: 'accessibility', sig })).toBeNull();
        expect(d.onCall(call('accessibility', 'find', 'blind'))).toBeNull();
      }
    });
  });

  describe('repeat-failure: the same failure code 3 times', () => {
    it('counts a code across the task, not only in a row', () => {
      const d = dog();
      const fail = () => call('accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error', code: 'NOT_FOUND', app: 'Edge' });
      expect(d.onCall(fail())).toBeNull();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
      expect(d.onCall(fail())).toBeNull();
      expect(d.onCall(call('computer', 'screenshot', 'vision'))).toBeNull();
      expect(d.onCall(fail())).toEqual({ rule: 'repeat-failure', detail: 'NOT_FOUND 3 times' });
    });
    it('keeps codes apart', () => {
      const d = dog();
      for (const code of ['NOT_FOUND', 'TIMEOUT', 'NOT_FOUND', 'TIMEOUT']) {
        expect(d.onCall(call('accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error', code, app: 'Edge' }))).toBeNull();
      }
    });
  });

  it('call-cap: one call more than the task allows', () => {
    const d = dog({ maxCalls: 3 });
    for (let i = 0; i < 3; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name', { app: 'Edge' }))).toBeNull();
    expect(d.onCall(call('accessibility', 'set_value', 'act-name', { app: 'Edge' }))).toMatchObject({ rule: 'call-cap' });
  });

  it('call-cap counts a batch by its steps, like the scorer', () => {
    const d = dog({ maxCalls: 4 });
    const step = { tool: 'accessibility', action: 'set_value', cls: 'act-name' as const, ok: true, outcome: 'ok' };
    expect(d.onCall(call('batch', '', 'act-other', { steps: [step, step, step] }))).toBeNull();
    expect(d.onCall(call('batch', '', 'act-other', { steps: [step, step] }))).toMatchObject({ rule: 'call-cap' });
  });

  it('time-cap', () => {
    const d = dog({ maxSeconds: 60 });
    expect(d.onTime(60)).toBeNull();
    expect(d.onTime(60.5)).toMatchObject({ rule: 'time-cap' });
  });

  describe('privacy: fails closed', () => {
    const step = (tool: string, action: string, cls: LogCall['cls'], extra: object = {}) => ({ tool, action, cls, ok: true, outcome: 'ok', ...extra });
    const none: Partial<Proof> = { ownsFocus: () => false, cdpIsFixture: () => false };

    it('stops on an act in an app that is not the fixture', async () => {
      expect(await dog().judge(call('computer', 'click', 'act-coords', { app: 'Outlook' }))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('computer', 'type', 'act-other', { app: 'File Explorer' }))).toMatchObject({ rule: 'privacy' });
    });

    it('stops on input or an act by name with NO app recorded (a background process)', async () => {
      expect(await dog().judge(call('accessibility', 'invoke', 'act-name'))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('accessibility', 'set_value', 'act-name'))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('computer', 'click', 'act-coords'))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('computer', 'key', 'act-other'))).toMatchObject({ rule: 'privacy' });
    });

    it('a fixture app NAME is not enough: the focus must be in a process the benchmark started', async () => {
      // The owner's own Edge window has the same name as the fixture browser.
      const v = await dog({}, { ownsFocus: () => false }).judge(call('computer', 'click', 'act-coords', { app: 'Edge' }));
      expect(v).toMatchObject({ rule: 'privacy' });
      expect(v!.detail).toMatch(/not in a process the benchmark started/);
      expect(await dog().judge(call('computer', 'click', 'act-coords', { app: 'Edge' }))).toBeNull();
    });

    it('accepts the fixture app however its name is written, with the proof', async () => {
      const d = dog({ fixtureApps: ['BenchFixture'] });
      for (const app of ['BenchFixture', 'benchfixture', 'Bench Fixture', 'BenchFixture.exe']) {
        expect(await d.judge(call('accessibility', 'invoke', 'act-name', { app }))).toBeNull();
      }
    });

    it('a CDP act (the log names no app) passes only when the reachable browser is proven to be the fixture\'s', async () => {
      expect(await dog().judge(call('browser', 'click', 'act-other'))).toBeNull();
      expect(await dog().judge(call('browser', 'navigate', 'act-other'))).toBeNull();
      expect(await dog({}, { cdpIsFixture: () => false }).judge(call('browser', 'click', 'act-other'))).toMatchObject({ rule: 'privacy' });
      expect(await dog({}, { cdpIsFixture: () => false }).judge(call('browser', 'evaluate', 'act-other'))).toMatchObject({ rule: 'privacy' });
    });

    it('a window or launch call with no app passes only when the focus ends in a process the benchmark started', async () => {
      expect(await dog().judge(call('window', 'focus', 'act-other'))).toBeNull();
      expect(await dog({}, none).judge(call('window', 'focus', 'act-other'))).toMatchObject({ rule: 'privacy' });
      expect(await dog({}, none).judge(call('window', 'open_app', 'act-other'))).toMatchObject({ rule: 'privacy' });
      expect(await dog({}, none).judge(call('system', 'clipboard_write', 'act-other'))).toMatchObject({ rule: 'privacy' });
    });

    it('checks every step of a batch, with the batch line\'s app', async () => {
      const steps = [step('accessibility', 'read_tree', 'blind'), step('computer', 'click', 'act-coords'), step('accessibility', 'set_value', 'act-name')];
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Word', steps }))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('batch', '', 'act-other', { steps }))).toMatchObject({ rule: 'privacy' });   // no app at all
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Edge', steps }))).toBeNull();
      expect(await dog({}, { ownsFocus: () => false }).judge(call('batch', '', 'act-other', { app: 'Edge', steps }))).toMatchObject({ rule: 'privacy' });
    });

    it('a step that names its own app is judged by it', async () => {
      const steps = [step('computer', 'click', 'act-coords', { app: 'Edge' }), step('computer', 'click', 'act-coords', { app: 'Outlook' })];
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Edge', steps }))).toMatchObject({ rule: 'privacy' });
    });

    it('a CDP step inside a batch needs the CDP proof, an input step next to it needs the app', async () => {
      const steps = [step('browser', 'click', 'act-other')];
      expect(await dog().judge(call('batch', '', 'act-other', { steps }))).toBeNull();
      expect(await dog({}, { cdpIsFixture: () => false }).judge(call('batch', '', 'act-other', { steps }))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('batch', '', 'act-other', { steps: [...steps, step('computer', 'type', 'act-other')] }))).toMatchObject({ rule: 'privacy' });
    });

    it('a batch whose steps the log does not list is judged like input', async () => {
      expect(await dog().judge(call('batch', '', 'act-other'))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Edge' }))).toBeNull();
    });

    it('does not fire on reads, on calls that touch no window, or on a call a guard refused', async () => {
      const d = dog({}, none);
      expect(await d.judge(call('accessibility', 'read_tree', 'blind', { app: 'Outlook' }))).toBeNull();
      expect(await d.judge(call('computer', 'screenshot', 'vision'))).toBeNull();
      expect(await d.judge(call('computer', 'wait', 'act-other'))).toBeNull();
      expect(await d.judge(call('browser', 'connect', 'act-other'))).toBeNull();
      expect(await d.judge(call('computer', 'hover', 'act-coords'))).toBeNull();
      expect(await d.judge(call('computer', 'click', 'act-coords', { ok: false, outcome: 'refused' }))).toBeNull();
    });

    it('an unknown acting action is not assumed harmless', async () => {
      expect(await dog({}, none).judge(call('system', 'some_new_action', 'act-other'))).toMatchObject({ rule: 'privacy' });
    });

    it('asks for the focus proof once per log line', async () => {
      let asked = 0;
      const d = dog({}, { ownsFocus: () => { asked++; return true; } });
      const steps = [step('computer', 'click', 'act-coords'), step('computer', 'type', 'act-other'), step('window', 'focus', 'act-other')];
      expect(await d.judge(call('batch', '', 'act-other', { app: 'Edge', steps }))).toBeNull();
      expect(asked).toBe(1);
    });

    it('a probe that fails or throws counts as "not ours"', async () => {
      const broken: Partial<Proof> = { ownsFocus: () => Promise.reject(new Error('probe failed')), cdpIsFixture: () => { throw new Error('probe failed'); } };
      expect(await dog({}, broken).judge(call('computer', 'click', 'act-coords', { app: 'Edge' }))).toMatchObject({ rule: 'privacy' });
      expect(await dog({}, { cdpIsFixture: () => Promise.reject(new Error('x')) }).judge(call('browser', 'click', 'act-other'))).toMatchObject({ rule: 'privacy' });
    });

    it('comes before every other rule', async () => {
      const d = dog({ maxCalls: 0 });
      expect(await d.judge(call('computer', 'click', 'act-coords', { app: 'Outlook', ok: false, code: 'X' }))).toMatchObject({ rule: 'privacy' });
    });
  });

  it('appKey folds case, spaces and the extension', () => {
    expect(appKey('Microsoft Edge')).toBe('microsoftedge');
    expect(appKey('TextEdit.app')).toBe('textedit');
  });
});

describe('following the session log', () => {
  const dirs: string[] = [];
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tail-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const header = JSON.stringify({ type: 'session', started: 'x', version: '2.0.0' }) + '\n';
  const line = (c: LogCall) => JSON.stringify(c) + '\n';

  it('delivers each complete call line once, across files, and skips header / end lines', async () => {
    const dir = mk();
    const seen: string[] = [];
    const stop = tailSessionDir(dir, c => seen.push(`${c.tool}/${c.action}`), 20);
    const a = path.join(dir, 'session-a.jsonl');
    fs.writeFileSync(a, header + line(call('accessibility', 'read_tree', 'blind')));
    await new Promise(r => setTimeout(r, 80));
    expect(seen).toEqual(['accessibility/read_tree']);
    // Half a line, then its rest: delivered only when whole.
    const second = line(call('computer', 'click', 'act-coords'));
    fs.appendFileSync(a, second.slice(0, 20));
    await new Promise(r => setTimeout(r, 80));
    expect(seen).toHaveLength(1);
    fs.appendFileSync(a, second.slice(20));
    fs.writeFileSync(path.join(dir, 'session-b.jsonl'), header + line(call('computer', 'screenshot', 'vision')));
    fs.writeFileSync(path.join(dir, 'other.txt'), 'not a session');
    await new Promise(r => setTimeout(r, 80));
    fs.appendFileSync(a, JSON.stringify({ type: 'end', reason: 'done' }) + '\n' + line(call('accessibility', 'invoke', 'act-name')));
    stop();   // the stop reads what is left
    expect(seen.sort()).toEqual(['accessibility/invoke', 'accessibility/read_tree', 'computer/click', 'computer/screenshot']);
  });

  it('waits for a directory that does not exist yet', async () => {
    const dir = path.join(mk(), 'sessions');
    const seen: LogCall[] = [];
    const stop = tailSessionDir(dir, c => seen.push(c), 20);
    await new Promise(r => setTimeout(r, 50));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), line(call('system', 'ocr', 'blind')));
    await new Promise(r => setTimeout(r, 80));
    stop();
    expect(seen).toHaveLength(1);
  });

  it('readSessionCalls returns every call in time order', () => {
    const dir = mk();
    fs.writeFileSync(path.join(dir, 'session-b.jsonl'), header + line(call('b', 'x', 'blind', { t: '2026-11-11T10:00:02.000Z' })));
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), header + line(call('a', 'x', 'blind', { t: '2026-11-11T10:00:03.000Z' }))
      + line(call('c', 'x', 'blind', { t: '2026-11-11T10:00:01.000Z' })) + '{"broken');
    expect(readSessionCalls(dir).map(c => c.tool)).toEqual(['c', 'b', 'a']);
    expect(readSessionCalls(path.join(dir, 'missing'))).toEqual([]);
  });
});
