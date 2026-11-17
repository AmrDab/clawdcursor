/**
 * Runs the macOS JXA scripts (scripts/mac/*.jxa) in node's vm against a fake System Events tree, on any OS: `el` / `coll`
 * build fake AX elements and the batched collections System Events answers with, `runInvoke` / `runFind` run
 * invoke-element.jxa / find-element.jxa with argv (and stdin, for -ArgsStdin). Nothing is sent to a real app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { getPackageRoot } from '../../paths';

/** expanded: the element's AXExpanded (absent: it has none); expandSettable: whether a write to it takes. */
export type Props = { name?: string | null; desc?: string; role: string; value?: unknown; x?: number; y?: number; expanded?: boolean; expandSettable?: boolean };
export type FakeEl = Record<string, any>;

export function coll(arr: FakeEl[]): any {
  // Callable like a JXA collection (`win.uiElements()`), and readable in one
  // batch (`win.uiElements.name()`). A function's own `name` is read-only, so
  // define it rather than assign.
  const c: any = () => arr;
  Object.defineProperty(c, 'name', { value: () => arr.map(e => e.name()) });
  c.description = () => arr.map(e => e.description());
  c.role = () => arr.map(e => e.role());
  for (const t of ['buttons', 'textFields', 'textAreas', 'checkboxes', 'radioButtons', 'popUpButtons', 'staticTexts', 'groups', 'menus']) c[t] = () => [];
  // `kids.uiElements.role()`: every child's children's roles, nested, in one Apple Event.
  Object.defineProperty(c, 'uiElements', { get: () => { reads.n++; return { role: () => arr.map(e => e.kidRoles()) }; } });
  c.whose = (q: { role: string }) => coll(arr.filter(e => e.role() === q.role));
  arr.forEach((e, i) => { c[i] = e; });
  Object.defineProperty(c, 'length', { value: arr.length });
  return c;
}

export const reads = { n: 0 };
export function el(p: Props, kids: FakeEl[] = []): FakeEl {
  const o: FakeEl = {
    name: () => p.name ?? null,
    description: () => p.desc ?? '',
    role: () => p.role,
    position: () => [p.x ?? 0, p.y ?? 0],
    size: () => [100, 20],
    click: () => { o.clicked = true; },
    actions: { AXPress: { perform: () => { o.pressed = true; if (p.role === 'AXCheckBox') p.value = p.value ? 0 : 1; } },
      AXShowMenu: { perform: () => { o.showedMenu = true; } } },
    attributes: { AXValue: { value: () => p.value } },
    subrole: () => '',
    miniaturized: () => false,
    uiElements: coll(kids),
    kidRoles: () => kids.map(k => k.role()),
  };
  // Count child reads so a test can prove leaf controls are never descended.
  const kidsColl = o.uiElements;
  Object.defineProperty(o, 'uiElements', { get: () => { reads.n++; return kidsColl; } });
  // JXA: `el.value()` reads, `el.value = x` writes.
  const read = () => p.value;
  Object.defineProperty(o, 'value', { get: () => read, set: (v) => { p.value = v; o.written = v; } });
  // attributes['AXExpanded'].value() reads it, `.value = x` writes it (or throws, as a read-only attribute does).
  if (p.expanded !== undefined) {
    const ax: Record<string, unknown> = {};
    Object.defineProperty(ax, 'value', { get: () => () => p.expanded,
      set: (v: boolean) => { if (!p.expandSettable) throw new Error('read-only'); p.expanded = v; } });
    o.attributes.AXExpanded = ax;
  }
  o.props = p;
  return o;
}

export function loadScript(file: string): string {
  return readFileSync(join(getPackageRoot(), 'scripts', 'mac', file), 'utf8').replace(/^#!.*\n/, '');
}

/** Foundation's stdin as the scripts read it (-ArgsStdin): readDataToEndOfFile → NSString → unwrap. */
export const stdinOf = (stdin = '') => ({
  NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: stdin } },
  NSString: { alloc: { initWithDataEncoding: (data: string) => data } },
  NSUTF8StringEncoding: 4,
});

export function runInvoke(fx: { Application: unknown }, argv: string[], stdin?: string) {
  const ctx = vm.createContext({
    Application: fx.Application, JSON, Date, String, Number, Math, Array, Object,
    ObjC: { unwrap: (x: unknown) => x }, $: stdinOf(stdin),
  });
  return JSON.parse(vm.runInContext(`${loadScript('invoke-element.jxa')}\nrun(${JSON.stringify(argv)})`, ctx));
}

export function runFind(fx: { Application: unknown }, argv: string[], stdin?: string) {
  const ctx = vm.createContext({
    Application: fx.Application, JSON, Date, String, Number, Math, Array, Object,
    ObjC: { unwrap: (x: unknown) => x, import: () => {} },
    $: {
      NSProcessInfo: { processInfo: { arguments: ['osascript', '-l', 'JavaScript', 'find-element.jxa', ...argv] } }, exit: () => {},
      ...stdinOf(stdin),
    },
  });
  return JSON.parse(vm.runInContext(loadScript('find-element.jxa'), ctx));
}


/** System Events with one process (pid 4242) holding the given windows. */
export function fakeApp(...windows: FakeEl[]): { Application: () => unknown } {
  const proc = { windows: coll(windows), unixId: () => 4242, name: () => 'app' };
  const app = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  return { Application: () => app };
}
