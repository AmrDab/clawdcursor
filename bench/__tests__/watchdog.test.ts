import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Watchdog, readSessionCalls, tailSessionDir } from '../lib/watchdog';
import { appKey } from '../lib/rules';
import type { LogCall } from '../lib/types';

vi.useRealTimers();

const call = (tool: string, action: string, cls: LogCall['cls'], extra: Partial<LogCall> = {}): LogCall =>
  ({ t: new Date().toISOString(), tool, action, cls, ok: true, ms: 10, outcome: 'ok', ...extra });
const dog = (over: Partial<{ maxCalls: number; maxSeconds: number; fixtureApps: string[] }> = {}) =>
  new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Edge', 'msedge'], ...over });

describe('the watchdog rules', () => {
  it('lets a normal run through', () => {
    const d = dog();
    expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
    for (let i = 0; i < 5; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name', { app: 'Edge' }))).toBeNull();
    expect(d.onCall(call('accessibility', 'invoke', 'act-name'))).toBeNull();
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
      for (let i = 0; i < 6; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name'))).toBeNull();
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
      const fail = () => call('accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error', code: 'NOT_FOUND' });
      expect(d.onCall(fail())).toBeNull();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind'))).toBeNull();
      expect(d.onCall(fail())).toBeNull();
      expect(d.onCall(call('computer', 'screenshot', 'vision'))).toBeNull();
      expect(d.onCall(fail())).toEqual({ rule: 'repeat-failure', detail: 'NOT_FOUND 3 times' });
    });
    it('keeps codes apart', () => {
      const d = dog();
      for (const code of ['NOT_FOUND', 'TIMEOUT', 'NOT_FOUND', 'TIMEOUT']) {
        expect(d.onCall(call('accessibility', 'invoke', 'act-name', { ok: false, outcome: 'error', code }))).toBeNull();
      }
    });
  });

  it('call-cap: one call more than the task allows', () => {
    const d = dog({ maxCalls: 3 });
    for (let i = 0; i < 3; i++) expect(d.onCall(call('accessibility', 'set_value', 'act-name'))).toBeNull();
    expect(d.onCall(call('accessibility', 'set_value', 'act-name'))).toMatchObject({ rule: 'call-cap' });
  });

  it('time-cap', () => {
    const d = dog({ maxSeconds: 60 });
    expect(d.onTime(60)).toBeNull();
    expect(d.onTime(60.5)).toMatchObject({ rule: 'time-cap' });
  });

  describe('privacy: an acting call in an app that is not a fixture', () => {
    it('stops on the first one', () => {
      expect(dog().onCall(call('computer', 'click', 'act-coords', { app: 'Outlook' }))).toMatchObject({ rule: 'privacy' });
      expect(dog().onCall(call('computer', 'type', 'act-other', { app: 'File Explorer' }))).toMatchObject({ rule: 'privacy' });
    });
    it('allows the fixture app, however its name is written', () => {
      const d = dog({ fixtureApps: ['BenchFixture'] });
      for (const app of ['BenchFixture', 'benchfixture', 'Bench Fixture', 'BenchFixture.exe']) {
        expect(d.onCall(call('accessibility', 'invoke', 'act-name', { app }))).toBeNull();
      }
    });
    it('sees an acting step inside a batch', () => {
      const steps = [{ tool: 'computer', action: 'click', cls: 'act-coords' as const, ok: true, outcome: 'ok' }];
      expect(dog().onCall(call('batch', '', 'act-other', { app: 'Word', steps }))).toMatchObject({ rule: 'privacy' });
    });
    it('does not fire on a read, or on an action with no app recorded', () => {
      const d = dog();
      expect(d.onCall(call('accessibility', 'read_tree', 'blind', { app: 'Outlook' }))).toBeNull();
      expect(d.onCall(call('accessibility', 'invoke', 'act-name'))).toBeNull();
    });
    it('comes before every other rule', () => {
      const d = dog({ maxCalls: 0 });
      expect(d.onCall(call('computer', 'click', 'act-coords', { app: 'Outlook', ok: false, code: 'X' }))).toMatchObject({ rule: 'privacy' });
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
