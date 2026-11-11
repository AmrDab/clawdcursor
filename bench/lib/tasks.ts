/** Task specs: load, validate, and evaluate their success predicate on fixture state. */
import * as fs from 'fs';
import * as path from 'path';
import { ARCHETYPES, MECHANISMS, OSES, type BenchOs, type Comparison, type FixtureState, type Predicate, type TaskSpec } from './types';

export const TASKS_DIR = path.join(__dirname, '..', 'tasks');

const COMPARISONS = ['equals', 'notEquals', 'matches', 'gte', 'lte', 'sameMembers', 'exists'] as const;

function predicateErrors(p: unknown, where: string): string[] {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [`${where}: a predicate is an object`];
  const o = p as Record<string, unknown>;
  if (Array.isArray(o.all) || Array.isArray(o.any)) {
    const list = (o.all ?? o.any) as unknown[];
    if (!list.length) return [`${where}: an empty all/any`];
    return list.flatMap((c, i) => predicateErrors(c, `${where}[${i}]`));
  }
  if ('not' in o) return predicateErrors(o.not, `${where}.not`);
  const errs: string[] = [];
  const hasPath = typeof o.path === 'string' && o.path.length > 0;
  const hasCount = !!o.count && typeof o.count === 'object';
  if (hasPath === hasCount) errs.push(`${where}: needs exactly one of path / count (or all / any / not)`);
  if (!COMPARISONS.some(k => k in o)) errs.push(`${where}: needs a comparison (${COMPARISONS.join(', ')})`);
  if (typeof o.matches === 'string') { try { new RegExp(o.matches); } catch { errs.push(`${where}: matches is not a regular expression`); } }
  return errs;
}

/** Every problem with one spec; empty when it is valid. */
export function validateTask(t: unknown): string[] {
  if (!t || typeof t !== 'object') return ['a task is an object'];
  const s = t as Partial<TaskSpec>;
  const errs: string[] = [];
  const id = typeof s.id === 'string' ? s.id : '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) errs.push('id: lower-case words joined by "-"');
  if (!ARCHETYPES.includes(s.archetype as never)) errs.push(`archetype: one of ${ARCHETYPES.join(', ')}`);
  if (!Array.isArray(s.os) || !s.os.length || s.os.some(o => !OSES.includes(o))) errs.push(`os: a non-empty list of ${OSES.join(', ')}`);
  if (!Array.isArray(s.mechanisms) || !s.mechanisms.length || s.mechanisms.some(m => !MECHANISMS.includes(m))) {
    errs.push(`mechanisms: a non-empty list of ${MECHANISMS.join(', ')}`);
  }
  if (typeof s.guards !== 'string' || !s.guards.trim()) errs.push('guards: one line saying what bug class this task catches');
  if (typeof s.prompt !== 'string' || s.prompt.trim().length < 20) errs.push('prompt: the instruction for the agent');
  const f = s.fixture as Record<string, unknown> | undefined;
  if (!f || !((f.kind === 'web' && typeof f.page === 'string' && /^[a-z]+$/.test(f.page))
    || (f.kind === 'native' && (f.mode === 'dialog' || f.mode === 'editor'))
    || (f.kind === 'app' && ['calculator', 'textedit', 'designcenter'].includes(String(f.app))))) {
    errs.push('fixture: {kind:"web",page} | {kind:"native",mode:"dialog"|"editor"} | {kind:"app",app}');
  }
  if (s.manualVerify) {
    if (s.success) errs.push('success: a manual-verify task has no predicate');
  } else if (!s.success) errs.push('success: a predicate on fixture state (or manualVerify: true)');
  else errs.push(...predicateErrors(s.success, 'success'));
  const int = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
  if (!s.oracle || !int(s.oracle.screenshots, 0) || !int(s.oracle.calls, 1)) errs.push('oracle: {screenshots >= 0, calls >= 1}');
  if (!s.caps || !int(s.caps.calls, 1) || !int(s.caps.seconds, 1)) errs.push('caps: {calls >= 1, seconds >= 1}');
  else if (s.oracle && int(s.oracle.calls, 1) && s.caps.calls < Math.ceil(s.oracle.calls * 1.5)) {
    errs.push('caps.calls: below the gate (1.5 x oracle.calls), so the watchdog would stop a passing run');
  }
  return errs;
}

/** Problems of the task set as a whole: duplicate ids, a mechanism guarded by fewer than two tasks. */
export function validateTaskSet(tasks: TaskSpec[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) { if (seen.has(t.id)) errs.push(`duplicate id ${t.id}`); seen.add(t.id); }
  for (const m of MECHANISMS) {
    const n = tasks.filter(t => t.mechanisms.includes(m)).length;
    if (n < 2) errs.push(`${m} is guarded by ${n} task(s): every mechanism needs at least two`);
  }
  return errs;
}

/** Every spec in bench/tasks, sorted by id. Throws on an invalid one. */
export function loadTasks(dir = TASKS_DIR): TaskSpec[] {
  const tasks: TaskSpec[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const errs = validateTask(t);
    if (errs.length) throw new Error(`${f}: ${errs.join('; ')}`);
    if (`${t.id}.json` !== f) throw new Error(`${f}: the file name must be <id>.json`);
    tasks.push(t);
  }
  const setErrs = validateTaskSet(tasks);
  if (setErrs.length) throw new Error(setErrs.join('; '));
  return tasks;
}

export function currentOs(platform: string = process.platform): BenchOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
}

function lookup(root: unknown, dotted: string): unknown {
  let v: unknown = root;
  for (const key of dotted.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function compare(v: unknown, c: Comparison): boolean {
  if ('exists' in c && (v !== undefined && v !== null) !== c.exists) return false;
  if ('equals' in c && !same(v, c.equals)) return false;
  if ('notEquals' in c && same(v, c.notEquals)) return false;
  if (c.matches !== undefined && !(typeof v === 'string' && new RegExp(c.matches).test(v))) return false;
  if (c.gte !== undefined && !(typeof v === 'number' && v >= c.gte)) return false;
  if (c.lte !== undefined && !(typeof v === 'number' && v <= c.lte)) return false;
  if (c.sameMembers !== undefined) {
    if (!Array.isArray(v) || v.length !== c.sameMembers.length) return false;
    const key = (x: unknown) => JSON.stringify(x);
    if (!same(v.map(key).sort(), c.sameMembers.map(key).sort())) return false;
  }
  return true;
}

/** Is the predicate true of this fixture state? */
export function evaluate(p: Predicate, fx: FixtureState): boolean {
  if ('all' in p) return p.all.every(c => evaluate(c, fx));
  if ('any' in p) return p.any.some(c => evaluate(c, fx));
  if ('not' in p) return !evaluate(p.not, fx);
  if ('count' in p) {
    const { type, target } = p.count;
    const n = fx.events.filter(e => (type === undefined || e.type === type) && (target === undefined || e.target === target)).length;
    return compare(n, p);
  }
  return compare(lookup(fx.state, p.path), p);
}
