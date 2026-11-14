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
import vm from 'node:vm';
import { el, coll, reads, loadScript, runInvoke, runFind } from './helpers/jxa-harness';

function fixture() {
  const label = el({ name: 'First name', role: 'AXStaticText', value: 'First name' });
  const field = el({ name: null, desc: 'First name', role: 'AXTextField', value: '' });
  const sub = el({ name: 'Subscribe', role: 'AXCheckBox', value: 0 });
  const rows = Array.from({ length: 60 }, (_, i) => el({ name: `Row ${String(i + 1).padStart(2, '0')}`, role: 'AXButton', y: i * 26 }));
  const scroll = el({ role: 'AXScrollArea' }, [el({ role: 'AXGroup' }, rows)]);
  const win = el({ name: 'CC Target', role: 'AXWindow' }, [label, field, sub, scroll]);
  const proc = { windows: coll([win]), unixId: () => 4242, name: () => 'cctarget' };
  const app = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  return { label, field, sub, rows, Application: () => app };
}

/** Freeform with "Insert Shape" open: AppKit hangs the AXPopover under the AXMenuButton that presented it (#273). */
function popoverFixture() {
  const pen = el({ name: 'Draw with Pen', role: 'AXButton' });
  const icon = el({ name: 'shape icon', role: 'AXImage' });
  const insert = el({ name: 'Insert Shape', role: 'AXMenuButton' }, [icon, el({ role: 'AXPopover' }, [el({ role: 'AXGroup' }, [pen])])]);
  const win = el({ name: 'Board', role: 'AXWindow' }, [el({ role: 'AXToolbar' }, [insert])]);
  const proc = { windows: coll([win]), unixId: () => 4242, name: () => 'Freeform' };
  const app = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  return { pen, Application: () => app };
}

describe('macOS invoke-element.jxa', () => {
  it('set-value lands on the text field labelled "First name", not the static label', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Name', 'First name', '-Action', 'set-value', '-Value', 'Ada']);
    expect(r.success).toBe(true);
    expect(fx.field.written).toBe('Ada');
    expect(fx.label.written).toBeUndefined();
  });

  it('-ArgsStdin: the name and the value come from stdin (never argv, where every process can read them)', () => {
    const fx = fixture();
    const r = runInvoke(fx, ['-ProcessId', '4242', '-Action', 'set-value', '-ArgsStdin'], JSON.stringify({ name: 'First name', value: 'hunter2' }));
    expect(r.success).toBe(true);
    expect(fx.field.written).toBe('hunter2');
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

  it('a prefix counts only up to a word boundary: "Sub" for "Subscribe" is listed, not pressed; "Row" for "Row 01" is pressed (#386)', () => {
    const fx = fixture();
    expect(runInvoke(fx, ['-ProcessId', '4242', '-Name', 'Sub', '-Action', 'toggle'])).toMatchObject({ success: false, reason: 'ambiguous', inexact: true });
    expect(fx.sub.pressed).toBeUndefined();
    expect(runInvoke(fx, ['-ProcessId', '4242', '-Name', 'Row', '-Action', 'click']).success).toBe(true);
  });
});

describe('macOS find-element.jxa', () => {
  it('-ArgsStdin: the name comes from stdin', () => {
    const out = runFind(fixture(), ['-ProcessId', '4242', '-ArgsStdin'], JSON.stringify({ name: 'Row 50' }));
    expect(out.map((e: { name: string }) => e.name)).toContain('Row 50');
  });

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

function runScreenContext(fx: Pick<ReturnType<typeof fixture>, 'Application'>) {
  const ctx = vm.createContext({
    Application: fx.Application, JSON, Date, String, Number, Math, Array, Object,
    ObjC: { unwrap: (x: unknown) => x, import: () => {} },
    $: { NSProcessInfo: { processInfo: { arguments: ['osascript', '-l', 'JavaScript', 'get-screen-context.jxa', '-FocusedProcessId', '4242', '-MaxDepth', '8'] } }, exit: () => {} },
  });
  return JSON.parse(vm.runInContext(loadScript('get-screen-context.jxa'), ctx));
}

describe('macOS get-screen-context.jxa (what compile_ui reads)', () => {
  it('includes controls nested in a scroll area and names text fields by their description', () => {
    const out = runScreenContext(fixture());
    const flat: any[] = [];
    (function walk(n: any) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(out.uiTree);
    expect(flat.filter(n => n.controlType === 'AXButton').map(n => n.name)).toContain('Row 50');
    expect(flat.find(n => n.controlType === 'AXTextField')?.name).toBe('First name');
  });

  it('never descends into leaf controls (keeps a large window inside the timeout)', () => {
    const fx = fixture();
    reads.n = 0;
    runScreenContext(fx);
    // window + scroll area + group + root reads; the 63 leaf controls add none.
    expect(reads.n).toBeLessThan(10);
  });
});

describe('macOS JXA walks into a popover a leaf control presented (#273)', () => {
  it('get-screen-context.jxa: the popover appears under its button; the button\'s decoration does not', () => {
    const flat: any[] = [];
    (function walk(n: any) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(runScreenContext(popoverFixture()).uiTree);
    const insert = flat.find(n => n.name === 'Insert Shape');
    expect(insert.children.map((n: any) => n.controlType)).toEqual(['AXPopover']);
    expect(flat.map(n => n.name)).toContain('Draw with Pen');
  });

  it('find-element.jxa finds a button inside the popover', () => {
    expect(runFind(popoverFixture(), ['-Name', 'Draw with Pen', '-ProcessId', '4242']).map((e: any) => e.name)).toEqual(['Draw with Pen']);
  });

  it('invoke-element.jxa clicks a button inside the popover', () => {
    const fx = popoverFixture();
    expect(runInvoke(fx, ['-ProcessId', '4242', '-Name', 'Draw with Pen', '-Action', 'click']).success).toBe(true);
    expect(fx.pen.clicked).toBe(true);
  });
});
