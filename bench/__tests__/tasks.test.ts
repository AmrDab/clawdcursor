import { describe, it, expect } from 'vitest';
import { evaluate, loadTasks, validateTask, validateTaskSet, currentOs } from '../lib/tasks';
import { stationCode } from '../lib/fixture-server';
import { ARCHETYPES, MECHANISMS, type FixtureState, type TaskSpec } from '../lib/types';

const valid: TaskSpec = {
  id: 'web-sample', archetype: 'web-form', os: ['windows'], mechanisms: ['M1'], guards: 'a sample',
  fixture: { kind: 'web', page: 'form' }, prompt: 'Fill the form and press Confirm.',
  success: { path: 'submitted.name', equals: 'Ada' }, oracle: { screenshots: 0, calls: 4 }, caps: { calls: 12, seconds: 60 },
};

describe('the task set', () => {
  const tasks = loadTasks();

  it('has 12 or more valid tasks', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(12);
    for (const t of tasks) expect(validateTask(t)).toEqual([]);
  });

  it('covers every archetype, and every mechanism at least twice', () => {
    for (const a of ARCHETYPES) expect(tasks.some(t => t.archetype === a), a).toBe(true);
    for (const m of MECHANISMS) expect(tasks.filter(t => t.mechanisms.includes(m)).length, m).toBeGreaterThanOrEqual(2);
  });

  it('runs the native dialog tasks on every OS', () => {
    for (const t of tasks.filter(x => x.archetype === 'native-dialog')) expect(t.os.sort()).toEqual(['linux', 'macos', 'windows']);
  });

  it('gates every task except the manual-verify ones, which have no predicate', () => {
    for (const t of tasks) expect(!!t.success).toBe(!t.manualVerify);
    expect(tasks.filter(t => t.manualVerify).map(t => t.id)).toEqual(['cad-designcenter-orbit']);
  });

  it('asks the reading task for the code the page really shows', () => {
    const t = tasks.find(x => x.id === 'web-long-read')!;
    expect(t.success).toEqual({ path: 'submitted', equals: stationCode(17) });
  });

  it('never uses Notepad', () => {
    for (const t of tasks) expect(JSON.stringify(t).toLowerCase()).not.toContain('notepad');
  });
});

describe('validateTask', () => {
  it('accepts a valid spec', () => expect(validateTask(valid)).toEqual([]));

  it.each([
    ['a bad id', { id: 'Web Form' }, 'id'],
    ['an unknown archetype', { archetype: 'spreadsheet' }, 'archetype'],
    ['an empty OS list', { os: [] }, 'os'],
    ['an unknown mechanism', { mechanisms: ['M9'] }, 'mechanisms'],
    ['no guards line', { guards: '' }, 'guards'],
    ['no prompt', { prompt: 'do it' }, 'prompt'],
    ['an unknown fixture', { fixture: { kind: 'web' } }, 'fixture'],
    ['no predicate', { success: undefined }, 'success'],
    ['a predicate with no comparison', { success: { path: 'a' } }, 'success'],
    ['a predicate with both path and count', { success: { path: 'a', count: {}, equals: 1 } }, 'success'],
    ['a bad regular expression', { success: { path: 'a', matches: '(' } }, 'success'],
    ['an oracle with no calls', { oracle: { screenshots: 0, calls: 0 } }, 'oracle'],
    ['a cap below the gate', { caps: { calls: 5, seconds: 60 } }, 'caps.calls'],
    ['a manual task with a predicate', { manualVerify: true }, 'success'],
  ])('rejects %s', (_name, patch, field) => {
    const errs = validateTask({ ...valid, ...patch });
    expect(errs.some(e => e.startsWith(field)), errs.join(' | ')).toBe(true);
  });

  it('accepts a manual-verify task with no predicate', () => {
    expect(validateTask({ ...valid, manualVerify: true, success: undefined })).toEqual([]);
  });
});

describe('validateTaskSet', () => {
  it('reports a duplicate id and a mechanism guarded by fewer than two tasks', () => {
    const errs = validateTaskSet([valid, valid]);
    expect(errs).toContain('duplicate id web-sample');
    expect(errs.some(e => e.startsWith('M2 is guarded by 0'))).toBe(true);
    expect(errs.some(e => e.startsWith('M1'))).toBe(false);
  });
});

describe('evaluate', () => {
  const fx: FixtureState = {
    state: { submitted: { name: 'Ada', qty: 7 }, inked: ['r2c2', 'r1c1'], saved: null, text: 'one\ntwo\n' },
    events: [{ t: 1, type: 'click', target: 'new' }, { t: 2, type: 'click', target: 'whatsNew' }, { t: 3, type: 'input', target: 'name' }],
  };

  it.each([
    [{ path: 'submitted.name', equals: 'Ada' }, true],
    [{ path: 'submitted.name', equals: 'ada' }, false],
    [{ path: 'submitted.name', notEquals: 'Bob' }, true],
    [{ path: 'submitted.qty', gte: 7, lte: 7 }, true],
    [{ path: 'submitted.qty', gte: 8 }, false],
    [{ path: 'submitted.name', gte: 1 }, false],
    [{ path: 'inked', sameMembers: ['r1c1', 'r2c2'] }, true],
    [{ path: 'inked', sameMembers: ['r1c1'] }, false],
    [{ path: 'saved', exists: false }, true],
    [{ path: 'missing.deep.key', exists: false }, true],
    [{ path: 'submitted', exists: true }, true],
    [{ path: 'text', matches: '^one\\ntwo\\s*$' }, true],
    [{ path: 'submitted.qty', matches: '7' }, false],
    [{ count: { type: 'click' }, equals: 2 }, true],
    [{ count: { type: 'click', target: 'new' }, equals: 1 }, true],
    [{ count: { target: 'gone' }, equals: 0 }, true],
    [{ all: [{ path: 'submitted.name', equals: 'Ada' }, { path: 'submitted.qty', equals: 7 }] }, true],
    [{ all: [{ path: 'submitted.name', equals: 'Ada' }, { path: 'submitted.qty', equals: 8 }] }, false],
    [{ any: [{ path: 'submitted.name', equals: 'Bob' }, { path: 'submitted.qty', equals: 7 }] }, true],
    [{ not: { path: 'submitted.name', equals: 'Ada' } }, false],
  ])('%j is %s', (p, want) => expect(evaluate(p as never, fx)).toBe(want));

  it('is false on empty state', () => {
    expect(evaluate({ path: 'submitted.name', equals: 'Ada' }, { state: {}, events: [] })).toBe(false);
  });
});

describe('currentOs', () => {
  it('maps node platforms', () => {
    expect(currentOs('win32')).toBe('windows');
    expect(currentOs('darwin')).toBe('macos');
    expect(currentOs('linux')).toBe('linux');
  });
});
