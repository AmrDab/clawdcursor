/**
 * `accessibility find "Model"` in Designcenter NX (live Win11 2026-11-10) returned the text of a web view the window
 * does not show (its Discovery Center panel), laid out down to y = 31,000: on no monitor, yet listed with a position
 * like any element. read_tree already flagged such rects offscreen (#340); find and the focused element did not, because
 * the rule lived inside getUiTree and they read through other bridge commands (find-element, get-focused-element).
 *
 * One rule for every element the Windows adapter hands out: a rect that overlaps no monitor is not a position. The
 * element is marked offscreen, loses its bounds, and is listed after the ones on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

let replies: Record<string, unknown> = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: (c: { cmd: string }) => Promise.resolve(replies[c.cmd]), start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';
import { getA11yTools } from '../tools/a11y';

// Physical pixels, as the bridge reports: a 3840x2400 primary at 225% and a 1920x1080 monitor at 100% above it.
const monitors = [
  { name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 3840, height: 2400, scale: 2.25 },
  { name: 'DISPLAY2', primary: false, x: 2796, y: -1080, width: 1920, height: 1080, scale: 1 },
];
const el = (name: string, bounds: object, controlType = 'ControlType.Text') => ({ name, controlType, bounds, processId: 3648, isEnabled: true });
const NONE = { x: 0, y: 0, width: 0, height: 0 };

// The hidden web view first, as the tree has it; then the part's tab in the window on the second monitor.
const hiddenHeading = el('Model Based Definition', { x: 2850, y: 31000, width: 400, height: 28 });
const hiddenLink = el('Modeling tutorials', { x: 2850, y: 4200, width: 300, height: 20 }, 'ControlType.Hyperlink');
const tab = el('model1.prt', { x: 3100, y: -960, width: 120, height: 24 }, 'ControlType.TabItem');

describe('WindowsAdapter.findElements: an element on no monitor is offscreen, as in getUiTree', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 3648, processName: 'ugraf', title: 'Designcenter Modeling' } as never);
    replies = { 'list-displays': { success: true, displays: monitors }, 'find-element': [hiddenHeading, hiddenLink, tab] };
  });

  it('marks the hidden web view\'s text offscreen and takes its position away', async () => {
    const found = await adapter.findElements({ name: 'Model' });
    for (const name of ['Model Based Definition', 'Modeling tutorials']) {
      expect(found.find(e => e.name === name)).toMatchObject({ offscreen: true, bounds: NONE });
    }
  });

  it('keeps the element on the monitor above the primary, and lists it first', async () => {
    const found = await adapter.findElements({ name: 'Model' });
    expect(found[0]).toMatchObject({ name: 'model1.prt', bounds: tab.bounds });
    expect(found[0].offscreen).not.toBe(true);
    expect(found.map(e => e.name)).toEqual(['model1.prt', 'Model Based Definition', 'Modeling tutorials']);
  });

  it('judges nothing when the bridge cannot list the monitors', async () => {
    replies['list-displays'] = { success: false };
    const found = await adapter.findElements({ name: 'Model' });
    expect(found.map(e => e.bounds)).toEqual([hiddenHeading.bounds, hiddenLink.bounds, tab.bounds]);
    expect(found.some(e => e.offscreen)).toBe(false);
  });

  it('the focused element follows the same rule', async () => {
    replies['get-focused-element'] = { ...hiddenLink, success: true };
    expect(await adapter.getFocusedElement()).toMatchObject({ name: 'Modeling tutorials', offscreen: true, bounds: NONE });
    replies['get-focused-element'] = { ...tab, success: true };
    expect(await adapter.getFocusedElement()).toMatchObject({ name: 'model1.prt', bounds: tab.bounds });
  });

  it('getUiTree still does (one helper for all three)', async () => {
    replies['get-screen-context'] = { uiTree: [{ ...hiddenHeading, children: [] }, { ...tab, children: [] }] };
    const tree = await adapter.getUiTree();
    expect(tree.find(e => e.name === 'Model Based Definition')).toMatchObject({ offscreen: true, bounds: NONE });
    expect(tree.find(e => e.name === 'model1.prt')).toMatchObject({ bounds: tab.bounds });
  });
});

describe('accessibility find: an offscreen element is listed without a position to click', () => {
  it('prints "(offscreen)" instead of @x,y for it, after the elements on screen', async () => {
    const adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 3648, processName: 'ugraf', title: 'Designcenter Modeling' } as never);
    replies = { 'list-displays': { success: true, displays: monitors }, 'find-element': [hiddenHeading, hiddenLink, tab] };
    const find = getA11yTools().find(t => t.name === 'find_element')!;
    const r = await find.handler({ name: 'Model' }, { ensureInitialized: async () => {}, platform: adapter } as never);
    const lines = r.text.split('\n').filter(l => l.startsWith('['));
    expect(lines).toEqual([
      '[TabItem] "model1.prt" @3100,-960 120x24',
      '[Text] "Model Based Definition" (offscreen)',
      '[Hyperlink] "Modeling tutorials" (offscreen)',
    ]);
    expect(r.text).not.toMatch(/31000|4200|@0,0/);
  });
});

