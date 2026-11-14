/**
 * Epic #387 (M3, perception without a tree): the cost of a look (#354), clicks along a path (#355), the opaque-area
 * line (#356) and tooltips on read_tree / find lines (#359). The OS-specific reads are in the bridges; this is the shared code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { imageCost, imageScale } from '../platform/coord-scale';
import { opaqueArea, opaqueAreaLine, shownHelp } from '../tools/blind-hints';
import { buildUnifiedTools } from '../tools/projected/tools';
import { stopControl, __setControlDirForTests } from '../core/control';
import type { UiElement } from '../platform/types';

const el = (name: string, controlType: string, x: number, y: number, width: number, height: number, extra: Partial<UiElement> = {}): UiElement =>
  ({ name, controlType, bounds: { x, y, width, height }, ...extra });

describe('the cost of a look (#354)', () => {
  it('states size and image tokens the way the issue measured them', () => {
    expect(imageCost(1175, 979)).toBe('1175x979px, about 1.5k image tokens');
    expect(imageCost(700, 420)).toBe('700x420px, about 390 image tokens');
  });

  it('a screenshot taken with max_edge is clicked with its own scale, not the default one', () => {
    const screen = { physicalWidth: 2560, physicalHeight: 1440 };
    expect(imageScale({ screen, _platform: 'win32' })).toBe(2);
    expect(imageScale({ screen, _platform: 'win32', imageToMouse: 5 })).toBe(5);
  });
});

describe('opaque area (#356)', () => {
  const toolbar = Array.from({ length: 6 }, (_, i) => el(`Tool ${i}`, 'Button', i * 40, 0, 36, 36));

  it('a board with nothing named inside is reported, with its share of the window', () => {
    const tree = [el('Freeform', 'Window', 0, 0, 1000, 800), ...toolbar, el('', 'Group', 0, 100, 1000, 700)];
    const o = opaqueArea(tree);
    expect(o).toEqual({ bounds: { x: 0, y: 100, width: 1000, height: 700 }, share: 0.875 });
    expect(opaqueAreaLine(o!)).toMatch(/^→ Opaque area @0,100 1000×700 \(88% of the window\): nothing inside has a name/);
  });

  it('a pane full of named controls, a document with text, or a small blank area is not', () => {
    const form = [el('Settings', 'Window', 0, 0, 1000, 800), el('Main', 'Pane', 0, 100, 1000, 700),
      el('Name', 'Edit', 100, 200, 300, 30), el('Save', 'Button', 100, 300, 80, 30)];
    expect(opaqueArea(form)).toBeNull();
    const editor = [el('Notes', 'Window', 0, 0, 1000, 800), el('', 'Edit', 0, 50, 1000, 750, { value: 'some text' })];
    expect(opaqueArea(editor)).toBeNull();
    const small = [el('App', 'Window', 0, 0, 1000, 800), ...toolbar, el('', 'Image', 500, 500, 100, 100)];
    expect(opaqueArea(small)).toBeNull();
    const paragraph = [el('About', 'Window', 0, 0, 1000, 800), ...toolbar, el('A long paragraph of text', 'Text', 0, 100, 1000, 600)];
    expect(opaqueArea(paragraph)).toBeNull();
  });

  it('an editor or a list is never a canvas: with text, empty, or inside a scroll wrapper of its own size', () => {
    const win = el('TextEdit', 'Window', 0, 0, 1000, 800);
    expect(opaqueArea([win, el('', 'ScrollArea', 0, 50, 1000, 750), el('', 'TextArea', 0, 50, 1000, 750, { value: 'hello' })])).toBeNull();
    expect(opaqueArea([win, el('', 'Pane', 0, 50, 1000, 750), el('', 'Edit', 0, 50, 1000, 750)])).toBeNull();
    expect(opaqueArea([win, el('Text editor', 'Document', 0, 50, 1000, 750)])).toBeNull();
    expect(opaqueArea([win, ...toolbar, el('', 'List', 0, 100, 1000, 700)])).toBeNull();
  });

  it('a canvas inside a named page is still reported: the page around it is not its content', () => {
    const tree = [el('Board - Browser', 'Window', 0, 0, 1000, 800), el('Board', 'Document', 0, 50, 1000, 750),
      ...toolbar.map(b => ({ ...b, bounds: { ...b.bounds, y: 60 } })), el('', 'Image', 0, 120, 1000, 680)];
    expect(opaqueArea(tree)?.bounds).toEqual({ x: 0, y: 120, width: 1000, height: 680 });
  });
});

// opaqueArea sees only what the bridges send: Windows and macOS dropped every unnamed childless node, the drawn surface included.
describe('the bridges keep a large unnamed leaf (#356)', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../scripts', f), 'utf8');
  it('ps-bridge: the pass-through branch returns a role-only node for a leaf covering a quarter of the walk root', () => {
    const ps = read('ps-bridge.ps1');
    expect(ps).toMatch(/if \(\$RawDepth -eq 0\) \{ \$r0 = \$cur\.BoundingRectangle; \$script:walkRootArea = /);
    const leaf = ps.slice(ps.indexOf('if ($childNodes.Count -eq 0) {'), ps.indexOf('return $childNodes'));
    expect(leaf).toMatch(/\$r\.Width \* \$r\.Height -ge 0\.25 \* \$script:walkRootArea/);
    expect(leaf).toMatch(/return \[ordered\]@\{ name = ""; automationId = ""; controlType = \$typeName/);
  });
  it('ax-helper: the keep rule keeps a node covering a quarter of the walk root', () => {
    const swift = read('mac/ax-helper.swift');
    expect(swift).toMatch(/if depth == 0 \{ w\.rootArea = sz\.width \* sz\.height \}/);
    expect(swift).toMatch(/let large = w\.rootArea > 0 && sz\.width \* sz\.height >= 0\.25 \* w\.rootArea/);
    expect(swift).toMatch(/\|\| !children\.isEmpty \|\| large\n/);
  });
});

describe('tooltips on element lines (#359)', () => {
  it('shown only when they say more than the name, quoted on one line', () => {
    expect(shownHelp({ name: 'Bold', help: 'Bold (Ctrl+B)\nMake text bold' })).toBe(' help="Bold (Ctrl+B)\\nMake text bold"');
    expect(shownHelp({ name: 'Bold', help: 'Bold' })).toBe('');
    expect(shownHelp({ name: 'Bold' })).toBe('');
    expect(shownHelp({ name: '', help: 'x'.repeat(100) })).toBe(` help="${'x'.repeat(80)}"…`);
  });

  it('read_tree lists them', async () => {
    const t = buildUnifiedTools().find(x => x.name === 'read_screen')!;
    const tree = Array.from({ length: 12 }, (_, i) => el(`B${i}`, 'Button', i * 50, 0, 40, 40, i === 0 ? { help: 'Insert a sticky note' } : {}));
    const platform = { getUiTree: vi.fn(async () => tree), getActiveWindow: vi.fn(async () => null), listWindows: vi.fn(async () => []) };
    const r = await t.execute({}, { platform, screen: {} } as any);
    expect(r.text).toContain('[Button] "B0" @0,0 40×40 help="Insert a sticky note"');
  });
});

describe('click with a path (#355)', () => {
  afterEach(() => __setControlDirForTests(null));
  const click = () => buildUnifiedTools().find(x => x.name === 'click')!;
  const ctxWith = (mouseClick: (...a: unknown[]) => Promise<void>) => ({
    platform: { mouseClick: vi.fn(mouseClick), getActiveWindow: vi.fn(async () => null) },
    screen: { physicalWidth: 2560, physicalHeight: 1440, logicalWidth: 2560, logicalHeight: 1440, dpiRatio: 1 },
    imageToMouse: 2,
  }) as any;

  it('clicks every point in order, scaled like a single click, in one reply line', async () => {
    const ctx = ctxWith(async () => {});
    const r = await click().execute({ path: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }], space: 'image', interval_ms: 0 }, ctx);
    expect(r.success).toBe(true);
    expect(ctx.platform.mouseClick.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([[20, 40], [60, 80], [100, 120]]);
    expect(r.text).toMatch(/^Clicked left x1 at 3 image points → screen \(20,40\)…\(100,120\)/);
  });

  it('a stop between points ends it and says how many landed', async () => {
    let n = 0;
    const ctx = ctxWith(async () => { if (++n === 1) stopControl('pill'); });
    await expect(click().execute({ path: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], space: 'screen', interval_ms: 0 }, ctx))
      .rejects.toThrow(/^stopped by the user[\s\S]*\(1 of 3 points were clicked first\)$/);
    expect(n).toBe(1);
  });

  it('a path that would outlast a client timeout is refused before anything is clicked', async () => {
    const ctx = ctxWith(async () => {});
    const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
    expect((await click().execute({ path: pts(101), interval_ms: 0 }, ctx)).text).toMatch(/at most 100 points and 30 s/);
    expect((await click().execute({ path: pts(20), interval_ms: 5000 }, ctx)).success).toBe(false);
    expect(ctx.platform.mouseClick).not.toHaveBeenCalled();
  });

  it('a malformed path is refused before anything is clicked', async () => {
    const ctx = ctxWith(async () => {});
    const r = await click().execute({ path: [{ x: 1 }] }, ctx);
    expect(r.success).toBe(false);
    expect(ctx.platform.mouseClick).not.toHaveBeenCalled();
  });
});
