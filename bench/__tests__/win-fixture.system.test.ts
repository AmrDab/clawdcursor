// The Windows native fixture, built once for every test here (build.ps1, Add-Type) and run with --selftest: off screen,
// never activated, closes itself. Plus the one runner check that needs Windows' icacls.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluate, loadTasks } from '../lib/tasks';
import { ORACLES, nativeDo } from '../lib/oracles';
import { nativeArgs, nativeStatePath, readStateFile } from '../lib/live-fixtures';
import { agentRoot, writeTaskResults } from '../run';
import type { FixtureState } from '../lib/types';

vi.useRealTimers();

describe.runIf(process.platform === 'win32')('the Windows native fixture', () => {
  let dir = '';
  let exe = '';
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const selftest = (mode: string): FixtureState => {
    const state = path.join(dir, `${mode}.json`);
    execFileSync(exe, ['--state', state, '--mode', mode, '--selftest'], { timeout: 30_000 });
    return JSON.parse(fs.readFileSync(state, 'utf8'));
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fixture-test-'));
    exe = path.join(dir, 'BenchFixture.exe');
    execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '..', 'fixtures', 'native', 'windows', 'build.ps1'), '-OutDir', dir], { timeout: 90_000, cwd: dir });
  }, 120_000);
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records the dialog: fields, list, checkbox, the duplicate buttons and the modal', () => {
    const fx = selftest('dialog');
    expect(fx.state).toEqual({ name: 'Self Test', email: 'self@test.example', priority: 'High', subscribe: true,
      applied: { name: 'Self Test', email: 'self@test.example', priority: 'High', subscribe: true },
      billingEdit: 0, shippingEdit: 1, mainOk: 0, mainCancel: 0, modalOpen: false, modalResult: 'ok' });
    expect(fx.events.map(e => `${e.type}:${e.target}`)).toEqual(['input:name', 'input:email', 'select:priority', 'toggle:subscribe',
      'click:shippingEdit', 'click:apply', 'click:delete', 'click:modalOk']);
    expect(fx.events.every(e => Math.abs(e.t - Date.now()) < 60_000)).toBe(true);
    // The state has the keys the native tasks read.
    const modal = loadTasks().find(t => t.id === 'native-dialog-modal')!;
    expect(evaluate(modal.success!, { ...fx, state: { ...fx.state, shippingEdit: 0 } })).toBe(true);
    expect(evaluate(modal.success!, { ...fx, state: { ...fx.state, shippingEdit: 0, mainOk: 1 } })).toBe(false);
  });

  it('records the editor text with plain line breaks', () => {
    const fx = selftest('editor');
    expect(fx.state).toEqual({ text: 'first line\nsecond line' });
    const task = loadTasks().find(t => t.id === 'editor-type-lines')!;
    expect(evaluate(task.success!, fx)).toBe(false);
    expect(evaluate(task.success!, { state: { text: 'Benchmark line one\nBenchmark line two' }, events: [] })).toBe(true);
  });

  it('exits with an error when it is not told where to write its state', () => {
    expect(() => execFileSync(exe, ['--selftest'], { timeout: 30_000 })).toThrow();
  });

  it('runs each native task\'s oracle script: after it the task\'s predicate holds; an unknown action is an error', () => {
    const tasks = loadTasks();
    for (const task of tasks) {
      if (task.fixture.kind !== 'native') continue;
      const state = path.join(dir, `${task.id}.json`);
      execFileSync(exe, [...nativeArgs({ state, mode: task.fixture.mode }), '--selftest', '--do', nativeDo(ORACLES[task.id])], { timeout: 30_000 });
      expect(evaluate(task.success!, readStateFile(state)!), task.id).toBe(true);
    }
    // The trap of the duplicate-button task, through the same door: the other Edit.
    const wrong = path.join(dir, 'wrong.json');
    execFileSync(exe, ['--state', wrong, '--mode', 'dialog', '--selftest', '--do', 'click=billingEdit']);
    expect(evaluate(tasks.find(t => t.id === 'native-dialog-duplicate')!.success!, readStateFile(wrong)!)).toBe(false);
    expect(() => execFileSync(exe, ['--state', path.join(dir, 'bad.json'), '--mode', 'dialog', '--selftest', '--do', 'click=nothing'])).toThrow();
  });

  it('a task\'s results directory with the real fixture writing its state: one writer per file', () => {
    const agent = { finalText: 'BENCH_RESULT: DONE', exitCode: 0, sigs: [], seconds: 1 };
    for (const [i, mode] of ['editor', 'dialog', 'editor'].entries()) {
      const workDir = path.join(dir, `run-${i}`);
      fs.mkdirSync(workDir);
      const live = nativeStatePath(workDir);
      execFileSync(exe, ['--state', live, '--mode', mode, '--selftest'], { timeout: 30_000 });
      const state = readStateFile(live);
      writeTaskResults(workDir, state, agent);
      expect(state?.events.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(workDir, 'fixture-state.json'))).toBe(true);
    }
  });
});

describe.runIf(process.platform === 'win32')('where the agents run', () => {
  it('is readable by the current user alone: it holds the MCP config with the bearer token', () => {
    const dir = agentRoot();
    try {
      const acl = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [dir], { encoding: 'utf8' });
      const entries = acl.split(/\r?\n/).map(l => l.replace(dir, '').trim()).filter(l => /:\(/.test(l));
      expect(entries).toHaveLength(1);                                   // one entry: no inherited Users / Everyone / INTERACTIVE
      expect(entries[0]).toMatch(/:\(OI\)\(CI\)\(F\)$/);
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|INTERACTIVE|Authenticated Users/i);
      fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');                // and the owner can still use it
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
