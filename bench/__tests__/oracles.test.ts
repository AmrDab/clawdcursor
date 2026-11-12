import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ORACLES, nativeDo, oracleCounts, runnable, scriptProblems, type OracleStep } from '../lib/oracles';
import { selfcheckOracles } from '../lib/selfcheck';
import { GATE } from '../lib/scorer';
import { loadTasks } from '../lib/tasks';

const tasks = loadTasks();
const step = (kind: OracleStep['kind'], extra: Partial<OracleStep> = {}): OracleStep => ({ kind, call: kind, ...extra });

describe('every oracle is the count of a scripted trajectory, not a number someone typed', () => {
  it('every task has a script, and no script is left without a task', () => {
    expect(Object.keys(ORACLES).sort()).toEqual(tasks.map(t => t.id).sort());
  });

  it.each(tasks.map(t => [t.id, t] as const))('%s: the spec carries exactly the counts of its script', (_id, task) => {
    expect(task.oracle).toEqual({ screenshots: oracleCounts(ORACLES[task.id]).screenshots, calls: oracleCounts(ORACLES[task.id]).calls });
  });

  it.each(tasks.map(t => [t.id] as const))('%s: its script is minimal but realistic: focus, one look, the actions, one verifying look', id => {
    expect(scriptProblems(ORACLES[id])).toEqual([]);
  });

  it('the scripts of the web and native tasks can be run with no app on screen; only the real-app ones cannot', () => {
    const kinds = Object.fromEntries(tasks.map(t => [t.id, `${t.fixture.kind}:${runnable(ORACLES[t.id])}`]));
    for (const t of tasks) {
      if (t.fixture.kind === 'web') expect(kinds[t.id], t.id).toBe('web:web');
      else if (t.fixture.kind === 'native') expect(kinds[t.id], t.id).toBe('native:native');
      else expect(kinds[t.id], t.id).toBe('app:null');
    }
  });

  it('a task without an accessibility tree looks with screenshots: before acting and to verify', () => {
    for (const t of tasks.filter(x => x.archetype === 'web-canvas' || x.archetype === 'cad-viewport')) expect(oracleCounts(ORACLES[t.id]).screenshots, t.id).toBe(2);
    for (const t of tasks.filter(x => x.archetype !== 'web-canvas' && x.archetype !== 'cad-viewport')) expect(oracleCounts(ORACLES[t.id]).screenshots, t.id).toBe(0);
  });

  it('the trajectory the first Codex run took on a trap task (focus, read, press, verify) passes the gate', () => {
    const trap = tasks.find(t => t.id === 'web-trap-new')!;
    expect(trap.oracle.calls).toBe(4);
    expect(4).toBeLessThanOrEqual(Math.ceil(trap.oracle.calls * GATE.callFactor));
    // The gate itself is unchanged, and 22 calls on the form still fails it.
    expect(GATE).toEqual({ screenshotSlack: 1, callFactor: 1.5 });
    const form = tasks.find(t => t.id === 'web-form-fill')!;
    expect(22).toBeGreaterThan(Math.ceil(form.oracle.calls * GATE.callFactor));
  });

  it('the watchdog\'s cap leaves room for a run that passes the gate', () => {
    for (const t of tasks) expect(t.caps.calls, t.id).toBeGreaterThanOrEqual(Math.ceil(t.oracle.calls * GATE.callFactor));
  });
});

describe('counting a script', () => {
  it('one call per step, one screenshot per step that looks at pixels', () => {
    const s = [step('focus'), step('read', { shot: true }), step('act'), step('act'), step('verify', { shot: true })];
    expect(oracleCounts(s)).toEqual({ calls: 5, screenshots: 2 });
    expect(oracleCounts([step('focus'), step('read'), step('act'), step('verify')])).toEqual({ calls: 4, screenshots: 0 });
  });

  it('says what is wrong with a script that is not minimal but realistic', () => {
    expect(scriptProblems([step('read'), step('act'), step('verify')])[0]).toMatch(/start by focusing/);
    expect(scriptProblems([step('focus'), step('act'), step('verify')])[0]).toMatch(/look .* before its first action/);
    expect(scriptProblems([step('focus'), step('read'), step('act')])[0]).toMatch(/end with one verifying look/);
    expect(scriptProblems([step('focus'), step('read'), step('verify')])[0]).toMatch(/no action/);
    expect(scriptProblems([step('focus'), step('read'), step('read'), step('act'), step('verify')])[0]).toMatch(/one read before acting/);
    expect(scriptProblems([step('focus'), step('read'), step('act'), step('wait'), step('act'), step('verify')])).toEqual([]);
  });

  it('gives the native fixture its actions in order', () => {
    expect(nativeDo(ORACLES['native-dialog-fill'])).toBe('name=Grace Hopper;email=grace@example.com;priority=High;subscribe=on;click=apply');
    expect(nativeDo(ORACLES['native-dialog-modal'])).toBe('click=delete;click=modalOk');
    expect(nativeDo(ORACLES['editor-type-lines'])).toBe('text=Benchmark line one\\nBenchmark line two');
  });
});

describe('the selfcheck holds the specs to their scripts', () => {
  it('passes on the specs as they are', () => {
    const lines: string[] = [];
    expect(selfcheckOracles([], false, l => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(tasks.length);
    expect(lines.every(l => l.startsWith('ok'))).toBe(true);
  });

  it('says which scripts were run and which were only counted', () => {
    const lines: string[] = [];
    selfcheckOracles([{ task: 'web-trap-new', calls: 4, screenshots: 0, spec: { calls: 4, screenshots: 0 }, ran: 'web' }], false, l => lines.push(l));
    expect(lines.find(l => l.includes('web-trap-new'))).toContain('script run: web');
    expect(lines.find(l => l.includes('calc-multiply'))).toContain('counted, not run here');
  });

  it('the README table shows the same oracles', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    for (const t of tasks) expect(readme, t.id).toContain(`| ${t.id} |`);
    for (const t of tasks) {
      const row = readme.split('\n').find(l => l.startsWith(`| ${t.id} |`))!;
      expect(row, t.id).toContain(`| ${t.oracle.calls} / ${t.oracle.screenshots} |`);
    }
  });
});

// The WinForms fixture runs a script of actions in its self-test (off screen, never activated).
describe.runIf(process.platform === 'win32')('the Windows fixture runs each native task\'s oracle script', () => {
  it('after the script the task\'s predicate holds; an unknown action is an error', async () => {
    const { execFileSync } = await import('child_process');
    const os = await import('os');
    const { evaluate } = await import('../lib/tasks');
    const { readStateFile, nativeArgs } = await import('../lib/live-fixtures');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-oracle-test-'));
    try {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'fixtures', 'native', 'windows', 'build.ps1'), '-OutDir', dir],
        { timeout: 90_000, cwd: dir });
      const exe = path.join(dir, 'BenchFixture.exe');
      for (const task of tasks.filter(t => t.fixture.kind === 'native')) {
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
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);
});
