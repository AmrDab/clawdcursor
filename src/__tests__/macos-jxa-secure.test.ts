/**
 * Secure text fields on the osascript path.
 *
 * The compiled helper never reads a secure field's value; the osascript scripts it falls back to (no Command Line Tools,
 * the first seconds after install, CLAWD_NO_MAC_AX) did: get-focused-element, find-element and invoke-element get-value
 * returned AXValue without looking at the subrole. macOS masks the text (what leaks is its length), but the rule is that a
 * secure field's value never leaves the machine's accessibility layer — get-screen-context.jxa already blanks it (audit M2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { getPackageRoot } from '../paths';

const SECRET = 'hunter2';
const script = (file: string) => readFileSync(join(getPackageRoot(), 'scripts', 'mac', file), 'utf8').replace(/^#!.*\n/, '');

/** A JXA-style collection: callable, indexable, with batched `.name()` / `.description()` / `.role()` reads. */
function coll(arr: any[]): any {
  const c: any = () => arr;
  Object.defineProperty(c, 'name', { value: () => arr.map(e => e.name()) });
  c.description = () => arr.map(e => e.description());
  c.role = () => arr.map(e => e.role());
  arr.forEach((e, i) => { c[i] = e; });
  Object.defineProperty(c, 'length', { value: arr.length });
  return c;
}

function field(p: { name: string; role?: string; subrole?: string; value?: string }, kids: any[] = []) {
  const o: any = {
    name: () => p.name,
    description: () => '',
    role: () => p.role ?? 'AXTextField',
    subrole: () => p.subrole ?? '',
    value: () => p.value ?? '',
    position: () => [10, 20],
    size: () => [100, 22],
    uiElements: coll(kids),
    attributes: { byName: (n: string) => ({ value: () => (n === 'AXSubrole' ? p.subrole ?? '' : undefined) }) },
  };
  return o;
}

function app(win: any, extra: Record<string, unknown> = {}) {
  const proc = { windows: coll([win]), unixId: () => 4242, name: () => 'cctarget', ...extra };
  return { processes: { where: () => [proc] }, includeStandardAdditions: false };
}

const ctxFor = (application: any, args: string[], file: string) => vm.createContext({
  Application: () => application, JSON, Date, String, Number, Math, Array, Object,
  ObjC: { unwrap: (x: unknown) => x, import: () => {} },
  $: { NSProcessInfo: { processInfo: { arguments: ['osascript', '-l', 'JavaScript', file, ...args] } }, exit: () => {} },
});

describe('find-element.jxa', () => {
  it('flags a secure field and does not return its value', () => {
    const win = field({ name: 'Window', role: 'AXWindow' }, [
      field({ name: 'Password', subrole: 'AXSecureTextField', value: SECRET }),
      field({ name: 'Username', value: 'ada' }),
    ]);
    const out = JSON.parse(vm.runInContext(script('find-element.jxa'), ctxFor(app(win), ['-Name', 'Password', '-ProcessId', '4242'], 'find-element.jxa')));
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out[0]).toMatchObject({ name: 'Password', secure: true });
  });

  it('still returns an ordinary field\'s value', () => {
    const win = field({ name: 'Window', role: 'AXWindow' }, [field({ name: 'Username', value: 'ada' })]);
    const out = JSON.parse(vm.runInContext(script('find-element.jxa'), ctxFor(app(win), ['-Name', 'Username', '-ProcessId', '4242'], 'find-element.jxa')));
    expect(out[0].value).toBe('ada');
    expect(out[0].secure).toBeUndefined();
  });
});

describe('invoke-element.jxa get-value', () => {
  const run = (name: string) => {
    const win = field({ name: 'Window', role: 'AXWindow' }, [
      field({ name: 'Password', subrole: 'AXSecureTextField', value: SECRET }),
      field({ name: 'Username', value: 'ada' }),
    ]);
    const src = `${script('invoke-element.jxa')}\nrun(${JSON.stringify(['-ProcessId', '4242', '-Name', name, '-Action', 'get-value'])})`;
    return JSON.parse(vm.runInContext(src, vm.createContext({ Application: () => app(win), JSON, Date, String, Number, Math, Array, Object })));
  };

  it('refuses to read a secure field', () => {
    const r = run('Password');
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/secure/i);
  });

  it('reads an ordinary field', () => {
    expect(run('Username')).toMatchObject({ success: true, value: 'ada' });
  });
});

describe('get-focused-element.jxa', () => {
  const run = (focused: any) => {
    const proc = { unixId: () => 4242, name: () => 'cctarget', focusedUIElement: () => focused, windows: () => [] };
    const procs: any = [proc];
    const se = { includeStandardAdditions: false, applicationProcesses: { whose: () => procs } };
    return JSON.parse(vm.runInContext(`${script('get-focused-element.jxa')}\nrun()`, vm.createContext({ Application: () => se, JSON, String, Number })));
  };

  it('does not return a focused secure field\'s value', () => {
    const r = run(field({ name: 'Password', subrole: 'AXSecureTextField', value: SECRET }));
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.secure).toBe(true);
  });

  it('returns an ordinary focused field\'s value', () => {
    expect(run(field({ name: 'Username', value: 'ada' }))).toMatchObject({ name: 'Username', value: 'ada' });
  });
});
