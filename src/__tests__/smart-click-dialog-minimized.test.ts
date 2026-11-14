/**
 * Review of the visible-target rule (smart-click-visible-target.test.ts) against 1.5.27, which pressed the first match:
 *  - a toolbar and a dialog inside the same window both have "OK" / "Close" (WinUI, Electron, a web page's modal): the
 *    rule answered AMBIGUOUS where the one in the dialog the user is in is plainly meant;
 *  - a MINIMIZED window has every element at -32000, on no monitor: the rule answered `hidden`, yet a pattern invoke by
 *    processId on a minimized window worked (it needs no place on screen). `hidden` stays for an element on no monitor
 *    inside a window that is shown, and a place on no monitor is never handed out as a point to click;
 *  - a compile_ui element_id that hit AMBIGUOUS answered a bare "missed", without the list the name path gives.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { buildUnifiedTools } from '../tools/projected/tools';
import { structuredMissFields } from '../core/miss-text';
import { classifyResult } from '../core/result-codes';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';
import type { AgentToolContext } from '../tools/projected/types';

const root = join(__dirname, '../..');

describe('invoke by element_id: an ambiguous name answers with the list, as the name path does', () => {
  const AMBIGUOUS = { success: false, reason: 'ambiguous', candidates: [
    { name: 'Send', controlType: 'ControlType.MenuItem', bounds: { x: 2800, y: -1070, width: 40, height: 20 } },
    { name: 'Send', controlType: 'ControlType.Button', bounds: { x: 2816, y: -1030, width: 64, height: 72 } },
  ] };
  const element: UIElement = { id: 'el_0', role: 'button', text: 'Send', normalized_text: 'send', bounds: [10, 20, 40, 12],
    confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true };
  const map: UIMap = { snapshot_id: 'obs_1', platform: 'windows', active_app: 'notepad', process_id: '9',
    window_title: 'Untitled - Notepad', window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
    compiled_at: '0', sources_used: ['window', 'a11y'], elements: [element], anchors: {} };
  const run = async (reply: Record<string, unknown>) => {
    const holder = new UIMapHolder();
    while (holder.nextId() !== map.snapshot_id) { /* advance the counter to the map's id */ }
    holder.put(map, Date.now());
    const invokeElement = vi.fn(async () => ({ success: false, data: structuredMissFields(reply) }));
    const mouseClick = vi.fn(async () => {});
    const platform = { invokeElement, mouseClick, listDisplays: async () => [],
      getActiveWindow: async () => ({ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } }) };
    const ctx = { platform, task: 't', screen: { logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
    const r = await buildUnifiedTools().find(t => t.name === 'invoke_element')!.execute({ element_id: 'el_0', snapshot_id: 'obs_1' }, ctx);
    return { r, invokeElement, mouseClick };
  };

  it('lists the candidates and is AMBIGUOUS, after one bridge call and no click', async () => {
    const { r, invokeElement, mouseClick } = await run(AMBIGUOUS);
    expect(r.success).toBe(false);
    expect(invokeElement).toHaveBeenCalledTimes(1);
    expect(mouseClick).not.toHaveBeenCalled();
    expect(r.text).toContain('el_0');
    expect(r.text).toContain('[MenuItem] "Send" @2800,-1070 40x20');
    expect(r.text).toContain('[Button] "Send" @2816,-1030 64x72');
    expect(classifyResult(r.text, true, true, 'mcp')?.code).toBe('AMBIGUOUS');
  });

  it('a hidden element says so (ELEMENT_HIDDEN), not a bare "missed"', async () => {
    const { r } = await run({ success: false, reason: 'hidden' });
    expect(classifyResult(r.text, true, true, 'mcp')?.code).toBe('ELEMENT_HIDDEN');
  });
});

describe('stale text about the OCR reply', () => {
  it('the tool description ties `confidence` to the whole-screen JSON, which is where it is', async () => {
    const { getOcrTools } = await import('../tools/ocr');
    const d = getOcrTools()[0].description;
    expect(d).not.toMatch(/\. An element's `confidence`/);
    expect(d).toMatch(/scope:"screen"[^.]*JSON[^.]*`confidence`/);
  });
  it('registry.ts no longer says the OCR tool always answers structured JSON', () => {
    const reg = readFileSync(join(root, 'src/tools/registry.ts'), 'utf8');
    expect(reg).not.toMatch(/No format change\./);
    expect(reg).not.toMatch(/whose structured JSON \(elements\[\] \+ bounds \+\n\s*\/\/ coordinateSystem\) is what external agents need/);
    expect(reg).toMatch(/`@x,y "text"` rows[^\n]*scope:"window"/);
  });
});
