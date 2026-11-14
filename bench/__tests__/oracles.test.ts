import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ORACLES, nativeDo, oracleCounts, runnable, scriptProblems, type OracleStep } from '../lib/oracles';
import { selfcheckOracles } from '../lib/selfcheck';
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

