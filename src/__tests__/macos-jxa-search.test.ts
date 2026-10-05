/**
 * The macOS JXA bridge scripts, run against a fake System Events tree.
 *
 * Live macOS run (GitHub-hosted Mac, 2026-10) found, in scripts/mac:
 *  - find-element.jxa only scanned a window's direct children (+ one level of
 *    groups), so nothing inside a scroll area was findable;
 *  - both scripts matched the AX name only, but AppKit text fields expose their
 *    accessibilityLabel as the DESCRIPTION — set_value "First name" wrote into
 *    the static label next to the field;
 *  - a -ControlType role ('text field') never matched System Events' 'AXTextField';
 *  - toggle read attributes['AXValue'].value without calling it (an always-truthy
 *    specifier), so it always wrote 0 and reported "Off".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { getPackageRoot } from '../paths';

type Props = { name?: string | null; desc?: string; role: string; value?: unknown; x?: number; y?: number };
type FakeEl = Record<string, any>;

function coll(arr: FakeEl[]): any {
  // Callable like a JXA collection (`win.uiElements()`), and readable in one
  // batch (`win.uiElements.name()`). A function's own `name` is read-only, so
  // define it rather than assign.
  const c: any = () => arr;
  Object.defineProperty(c, 'name', { value: () => arr.map(e => e.name()) });
  c.description = () => arr.map(e => e.description());
  c.role = () => arr.map(e => e.role());
  for (const t of ['buttons', 'textFields', 'textAreas', 'checkboxes', 'radioButtons', 'popUpButtons', 'staticTexts', 'groups', 'menus']) c[t] = () => [];
  arr.forEach((e, i) => { c[i] = e; });
  Object.defineProperty(c, 'length', { value: arr.length });
  return c;
}

function el(p: Props, kids: FakeEl[] = []): FakeEl {
  const o: FakeEl = {
    name: () => p.name ?? null,
    description: () => p.desc ?? '',
    role: () => p.role,
    position: () => [p.x ?? 0, p.y ?? 0],
    size: () => [100, 20],
    click: () => { o.clicked = true; },
    actions: { AXPress: { perform: () => { o.pressed = true; if (p.role === 'AXCheckBox') p.value = p.value ? 0 : 1; } } },
    attributes: { AXValue: { value: () => p.value } },
    uiElements: coll(kids),
  };
  // JXA: `el.value()` reads, `el.value = x` writes.
  const read = () => p.value;
  Object.defineProperty(o, 'value', { get: () => read, set: (v) => { p.value = v; o.written = v; } });
  o.props = p;
  return o;
}

function fixture() {
  const label = el({ name: 'First name', role: 'AXStaticText', value: 'First name' });
  const field = el({ name: null, desc: 'First name', role: 'AXTextField', value: '' });
  const sub = el({ name: 'Subscribe', role: 'AXCheckBox', value: 0 });
  const rows = Array.from({ length: 60 }, (_, i) => el({ name: `Row ${String(i + 1).padStart(2, '0')}`, role: 'AXButton', y: i * 26 }));
  const scroll = el({ role: 'AXScrollArea' }, [el({ role: 'AXGroup' }, rows)]);
  const win = el({ name: 'CC Target', role: 'AXWindow' }, [label, field, sub, scroll]);
  const proc = { windows: coll([win]), unixId: () => 4242 };
  const app = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  return { label, field, sub, rows, Application: () => app };
}

function loadScript(file: string): string {
  return readFileSync(join(getPackageRoot(), 'scripts', 'mac', file), 'utf8').replace(/^#!.*\n/, '');
}

function runInvoke(fx: ReturnType<typeof fixture>, argv: string[]) {
  const ctx = vm.createContext({ Application: fx.Application, JSON, Date, String, Number, Math, Array, Object });
  return JSON.parse(vm.runInContext(`${loadScript('invoke-element.jxa')}\nrun(${JSON.stringify(argv)})`, ctx));
}

function runFind(fx: ReturnType<typeof fixture>, argv: string[]) {
  const ctx = vm.createContext({
    Application: fx.Application, JSON, Date, String, Number, Math, Array, Object,
    ObjC: { unwrap: (x: unknown) => x, import: () => {} },
    $: { NSProcessInfo: { processInfo: { arguments: ['osascript', '-l', 'JavaScript', 'find-element.jxa', ...argv] } }, exit: () => {} },
  });
  return JSON.parse(vm.runInContext(loadScript('find-element.jxa'), ctx));
}

describe('macOS invoke-element.jxa', () => {
  it('set-value lands on the text field labelled "First name", not the static label', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Name', 'First name', '-Action', 'set-value', '-Value', 'Ada']);
    expect(r.success).toBe(true);
    expect(fx.field.written).toBe('Ada');
    expect(fx.label.written).toBeUndefined();
  });

  it('a -ControlType Edit role matches AXTextField', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Name', 'First name', '-ControlType', 'Edit', '-Action', 'set-value', '-Value', 'Zed']);
    expect(r.success).toBe(true);
    expect(fx.field.written).toBe('Zed');
  });

  it('toggle presses the checkbox and reports its real new state', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Name', 'Subscribe', '-Action', 'toggle']);
    expect(fx.sub.pressed).toBe(true);
    expect(r.data.toggleState).toBe('On');
  });

  it('clicks a button nested inside a scroll area', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Name', 'Row 50', '-Action', 'click']);
    expect(r.success).toBe(true);
    expect(fx.rows[49].clicked).toBe(true);
  });
});

describe('macOS find-element.jxa', () => {
  it('finds a button nested inside a scroll area', () => {
    const out = runFind(fixture(), ['-Name', 'Row 50', '-ProcessId', '4242']);
    expect(out.map((e: any) => e.name)).toEqual(['Row 50']);
    expect(out[0].role).toBe('AXButton');
  });

  it('finds a text field by its description (AppKit accessibilityLabel)', () => {
    const out = runFind(fixture(), ['-Name', 'First name', '-ProcessId', '4242']);
    expect(out.map((e: any) => e.role)).toContain('AXTextField');
  });
});
