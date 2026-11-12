import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Watchdog, readSessionCalls, tailSessionDir, type Proof } from '../lib/watchdog';
import { appKey, isSharedHostName } from '../lib/rules';
import { fenceEnv, inFixtureFence } from '../lib/ownership';
import { isolatedEnv } from '../lib/isolated';
import { __setFenceProcessTableForTests, inFence } from '../../src/core/fence';
import type { LogCall } from '../lib/types';

vi.useRealTimers();

const call = (tool: string, action: string, cls: LogCall['cls'], extra: Partial<LogCall> = {}): LogCall =>
  ({ t: new Date().toISOString(), tool, action, cls, ok: true, ms: 10, outcome: 'ok', ...extra });
/** By default the runner can prove everything: the tests of the other rules are not about privacy. */
const dog = (over: Partial<{ maxCalls: number; maxSeconds: number; fixtureApps: string[] }> = {}, proof: Partial<Proof> = {}) =>
  new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Edge'], ...over }, { ownsFocus: () => true, ownsPid: () => true, cdpIsFixture: () => true, ...proof });

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

  describe('privacy: an act is judged by the process it went to, recorded WITH the act', () => {
    // The desk: ApplicationFrameHost (38636) owns both Store app frames. Calculator is process 6768, started by the
    // benchmark; Settings is 7100, the owner's. clawdcursor writes the app's process and the window's handle on the act line.
    const CALC = 6768, SETTINGS = 7100;
    /** The focus proof is whatever the test says: these lines must not be decided by it. */
    const calcDog = (focusIsOurs: boolean) => new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Calculator'] },
      { ownsFocus: () => focusIsOurs, ownsPid: pid => pid === CALC, cdpIsFixture: () => false });
    const invoke = (app: string, appPid?: number) => call('accessibility', 'invoke', 'act-name', { app, ...(appPid ? { appPid, appHandle: 18814450 } : {}) });

    it('a frame-host act whose recorded process is the Calculator the benchmark started passes', async () => {
      // What stopped the second Codex run: every invoke was logged under the host's name.
      expect(await calcDog(false).judge(invoke('Application Frame Host', CALC))).toBeNull();
      expect(await calcDog(false).judge(invoke('ApplicationFrameHost', CALC))).toBeNull();
      expect(await calcDog(false).judge(call('computer', 'type', 'act-other', { app: 'Application Frame Host', appPid: CALC }))).toBeNull();
      expect(await calcDog(false).judge(invoke('Calculator', CALC))).toBeNull();
    });

    it('with the process of another Store app (Settings) it stops the run', async () => {
      const v = await calcDog(true).judge(invoke('Application Frame Host', SETTINGS));
      expect(v).toMatchObject({ rule: 'privacy' });
      expect(v!.detail).toContain(`process ${SETTINGS}`);
      // ... wherever the focus is by the time the line is read, and even if the line says "Calculator".
      expect(await calcDog(true).judge(invoke('Calculator', SETTINGS))).toMatchObject({ rule: 'privacy' });
      // The frame host's own process is not an app.
      expect(await calcDog(true).judge(invoke('Application Frame Host', 38636))).toMatchObject({ rule: 'privacy' });
    });

    it('with NO process recorded it stops the run: where the focus is now does not decide', async () => {
      const v = await calcDog(true).judge(invoke('Application Frame Host'));
      expect(v).toMatchObject({ rule: 'privacy' });
      expect(v!.detail).toMatch(/no verified record of which process/);
      for (const bad of [0, -1, 1.5, NaN]) {
        expect(await calcDog(true).judge({ ...invoke('Application Frame Host'), appPid: bad }), String(bad)).toMatchObject({ rule: 'privacy' });
      }
    });

    it('the live focus check is not asked for a line that carries its process', async () => {
      let asked = 0;
      const d = new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Calculator'] },
        { ownsFocus: () => { asked++; return true; }, ownsPid: pid => pid === CALC, cdpIsFixture: () => false });
      await d.judge(invoke('Application Frame Host', CALC));
      await d.judge(invoke('Calculator', CALC));
      await d.judge(invoke('Application Frame Host', SETTINGS));
      expect(asked).toBe(0);
    });

    describe('a batch: every step is judged by the process THAT STEP recorded', () => {
      const s = (tool: string, action: string, cls: LogCall['cls'], app?: string, appPid?: number) =>
        ({ tool, action, cls, ok: true, outcome: 'ok', ...(app ? { app } : {}), ...(appPid ? { appPid, appHandle: 18814450 } : {}) });
      const batch = (steps: ReturnType<typeof s>[], line: Partial<LogCall> = {}) => call('batch', '', 'act-other', { steps, ...line });

      it('every step in the Calculator the benchmark started: passes', async () => {
        const steps = [s('accessibility', 'invoke', 'act-name', 'Calculator', CALC), s('computer', 'type', 'act-other', 'Application Frame Host', CALC), s('computer', 'wait', 'act-other')];
        expect(await calcDog(false).judge(batch(steps, { app: 'Calculator', appPid: CALC }))).toBeNull();
      });

      it('one step in the middle went to Settings, the last one back to Calculator: the run stops', async () => {
        // The batch LINE carries its last act (Calculator). Judged by the line, this batch would pass.
        const steps = [s('accessibility', 'invoke', 'act-name', 'Calculator', CALC), s('computer', 'type', 'act-other', 'Application Frame Host', SETTINGS),
          s('accessibility', 'invoke', 'act-name', 'Calculator', CALC)];
        const v = await calcDog(true).judge(batch(steps, { app: 'Calculator', appPid: CALC }));
        expect(v).toMatchObject({ rule: 'privacy' });
        expect(v!.detail).toMatch(/^batch step computer type .*process 7100/);
      });

      it('a step with no process of its own is unproven, whatever the batch line says: the run stops', async () => {
        const steps = [s('accessibility', 'invoke', 'act-name', 'Calculator', CALC), s('computer', 'type', 'act-other')];
        expect(await calcDog(true).judge(batch(steps, { app: 'Calculator', appPid: CALC }))).toMatchObject({ rule: 'privacy' });
        const named = [s('computer', 'type', 'act-other', 'Calculator')];   // a name, but no verified process
        expect(await calcDog(true).judge(batch(named, { app: 'Calculator', appPid: CALC }))).toMatchObject({ rule: 'privacy' });
        const shared = [s('computer', 'type', 'act-other', 'Application Frame Host')];
        expect(await calcDog(true).judge(batch(shared, { app: 'Application Frame Host', appPid: CALC }))).toMatchObject({ rule: 'privacy' });
      });

      it('a step that touches no window needs nothing, and a refused step never ran', async () => {
        const steps = [s('computer', 'wait', 'act-other'), s('accessibility', 'read_tree', 'blind'), { ...s('computer', 'type', 'act-other'), ok: false, outcome: 'refused' }];
        expect(await calcDog(false).judge(batch(steps))).toBeNull();
      });
    });

    it('a pid the log marks as anything but a positive integer is no evidence', async () => {
      for (const bad of ['6768', true, null, {}, [6768]]) {
        expect(await calcDog(true).judge({ ...invoke('Application Frame Host'), appPid: bad as never }), JSON.stringify(bad)).toMatchObject({ rule: 'privacy' });
      }
    });

    it('a proof that fails or throws counts as "not ours"', async () => {
      const d = new Watchdog({ maxCalls: 20, maxSeconds: 60, fixtureApps: ['Calculator'] },
        { ownsFocus: () => true, ownsPid: () => Promise.reject(new Error('no process list')), cdpIsFixture: () => false });
      expect(await d.judge(invoke('Calculator', CALC))).toMatchObject({ rule: 'privacy' });
    });

    it('only the shared host\'s name is exempt from the name check: any other unknown name stops at once', async () => {
      expect(isSharedHostName('Application Frame Host')).toBe(true);
      expect(isSharedHostName('ApplicationFrameHost.exe')).toBe(true);
      expect(isSharedHostName('Application Frame Host Helper')).toBe(false);
      expect(await calcDog(true).judge(invoke('Outlook', CALC))).toMatchObject({ rule: 'privacy' });
    });

    it('a log that records no process at all (an older build) still falls back to the name and the focus, for a named app', async () => {
      expect(await calcDog(true).judge(invoke('Calculator'))).toBeNull();
      expect(await calcDog(false).judge(invoke('Calculator'))).toMatchObject({ rule: 'privacy' });
    });
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

    it('checks every step of a batch by what the step itself recorded, never by the batch line', async () => {
      const bare = [step('accessibility', 'read_tree', 'blind'), step('computer', 'click', 'act-coords'), step('accessibility', 'set_value', 'act-name')];
      // Steps that recorded nothing are unproven, with a fixture's name on the line or not.
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Word', steps: bare }))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('batch', '', 'act-other', { steps: bare }))).toMatchObject({ rule: 'privacy' });
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Edge', appPid: 500, steps: bare }))).toMatchObject({ rule: 'privacy' });
      // Steps with their own app and process, all the fixture's: allowed.
      const own = [step('accessibility', 'read_tree', 'blind'), step('computer', 'click', 'act-coords', { app: 'Edge', appPid: 500 }), step('accessibility', 'set_value', 'act-name', { app: 'Edge', appPid: 500 })];
      expect(await dog().judge(call('batch', '', 'act-other', { app: 'Edge', appPid: 500, steps: own }))).toBeNull();
      expect(await dog({}, { ownsPid: () => false }).judge(call('batch', '', 'act-other', { app: 'Edge', appPid: 500, steps: own }))).toMatchObject({ rule: 'privacy' });
    });

    it('a step that names its own app is judged by it', async () => {
      const steps = [step('computer', 'click', 'act-coords', { app: 'Edge', appPid: 500 }), step('computer', 'click', 'act-coords', { app: 'Outlook', appPid: 500 })];
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
      // Two window steps (no process is ever recorded for those: the focus decides) and an input step with its own process.
      const steps = [step('window', 'focus', 'act-other'), step('computer', 'type', 'act-other', { app: 'Edge', appPid: 500 }), step('window', 'maximize', 'act-other')];
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

describe('privacy: the watchdog trusts the same process identity as the fence', () => {
  // The first full run (2026-11-12), qwen2.5:7b on web-long-read, with Ollama loading the CPU: the fence let
  // `computer type` into the fixture Edge (process 52324) and the keys reached the fixture page, but the watchdog asked
  // again by scanning command lines; that one probe took about 40 s (its timeout is 30 s, and a failed scan reads as no
  // process), did not list 52324, and the run was stopped for privacy.
  // The owner's own Edge was process 21792 and was never touched.
  const FIXTURE_EDGE = 52324, RENDERER = 52410, OWNER_EDGE = 21792;
  const fencePids = [FIXTURE_EDGE, 52400];   // what the daemon was started with (CLAWD_FENCE_PIDS)
  const typed = call('computer', 'type', 'act-other', { app: 'Microsoft Edge', appPid: FIXTURE_EDGE, appHandle: 10230290 });
  let scans = 0;
  /** The process table the fence reads (pid -> parent). `null`: the read fails, as a starved WMI query does. */
  const table = (t: Array<[number, number]> | null) => __setFenceProcessTableForTests(async () => {
    scans++;
    if (!t) throw new Error('timed out');
    return new Map(t);
  });
  const edgeDog = () => new Watchdog({ maxCalls: 20, maxSeconds: 180, fixtureApps: ['Edge', 'Microsoft Edge'] },
    { ownsFocus: () => false, ownsPid: inFixtureFence(fencePids), cdpIsFixture: () => false });
  afterEach(() => { __setFenceProcessTableForTests(null); scans = 0; });

  it('the exact line that was stopped passes, with no scan at all, even when every scan fails', async () => {
    table(null);
    expect(await edgeDog().judge(typed)).toBeNull();
    expect(scans).toBe(0);
  });

  it('a child of a fenced process passes, as the fence lets it through', async () => {
    table([[RENDERER, FIXTURE_EDGE], [FIXTURE_EDGE, 900], [OWNER_EDGE, 900]]);
    expect(await edgeDog().judge({ ...typed, appPid: RENDERER })).toBeNull();
  });

  it('an act in a process the benchmark did not start still stops the run: the owner\'s Edge, or anything with no answer', async () => {
    table([[RENDERER, FIXTURE_EDGE], [FIXTURE_EDGE, 900], [OWNER_EDGE, 900]]);
    const v = await edgeDog().judge({ ...typed, appPid: OWNER_EDGE });
    expect(v).toMatchObject({ rule: 'privacy' });
    expect(v!.detail).toContain(`process ${OWNER_EDGE}`);
    // The fixture's parent is not the fixture.
    expect(await edgeDog().judge({ ...typed, appPid: 900 })).toMatchObject({ rule: 'privacy' });
    // No process table: a pid that is not itself fenced cannot be proven, so it stops (fails closed).
    table(null);
    expect(await edgeDog().judge({ ...typed, appPid: OWNER_EDGE })).toMatchObject({ rule: 'privacy' });
    expect(await edgeDog().judge({ ...typed, appPid: RENDERER })).toMatchObject({ rule: 'privacy' });
  });

  it('the daemon is fenced to exactly the list the watchdog judges by, and both give the same answer for every pid', async () => {
    const env = isolatedEnv({}, { home: 'h', sessionDir: 's', cdpPort: 1, fencePids });
    expect(env.CLAWD_FENCE_PIDS).toBe(fenceEnv(fencePids).CLAWD_FENCE_PIDS);
    table([[RENDERER, FIXTURE_EDGE], [FIXTURE_EDGE, 900], [OWNER_EDGE, 900]]);
    for (const pid of [FIXTURE_EDGE, 52400, RENDERER, OWNER_EDGE, 900]) {
      expect(await inFixtureFence(fencePids)(pid), String(pid)).toBe(await inFence(pid, env));
    }
    // Nothing fenced: nothing is the fixture's, for the daemon and the watchdog alike.
    expect(isolatedEnv({}, { home: 'h', sessionDir: 's', cdpPort: 1, fencePids: [] }).CLAWD_FENCE_PIDS).toBe('none');
    expect(await inFixtureFence([])(FIXTURE_EDGE)).toBe(false);
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
