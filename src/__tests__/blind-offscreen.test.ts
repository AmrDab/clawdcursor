/**
 * Below-the-fold elements must stay readable blind.
 *
 * Live Win11 re-test 2026-10-15: Settings → System → About lists "Windows 11
 * Pro" and "25H2" below the fold. UIA reports them with EMPTY bounds (0×0), and:
 *   - read_tree showed 60 of 144 elements ("… +84 more") with no way to page,
 *     and the values sat in the hidden tail;
 *   - compile_ui dropped every zero-bounds element (and OCR can't see them);
 *   - list_children("Windows specifications") failed: "parent has zero bounds".
 * The agent only got the values by guessing names for `find`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PlatformAdapter, UiElement } from '../platform/types';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext, UnifiedTool } from '../core/agent-loop/types';
import { captureSnapshot } from '../core/sense/snapshot';
import { compileUIMap } from '../core/sense/ui-map';
import { renderUIMap } from '../core/sense/ui-map-render';
import { getA11yDepthTools } from '../tools/a11y_depth';

function tool(name: string): UnifiedTool {
  const t = buildUnifiedTools().find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

const on = (name: string, controlType: string, y: number, depth?: number): UiElement =>
  ({ name, controlType, bounds: { x: 300, y, width: 200, height: 20 }, ...(depth !== undefined ? { depth } : {}) });
const off = (name: string, controlType: string, depth?: number): UiElement =>
  ({ name, controlType, bounds: { x: 0, y: 0, width: 0, height: 0 }, ...(depth !== undefined ? { depth } : {}) });

/** About page as the bridge returns it: offscreen values interleaved in tree order. */
function aboutTree(): UiElement[] {
  return [
    on('Settings', 'Window', 32, 0),
    on('Device specifications', 'Group', 566, 1),
    off('Windows specifications', 'Group', 1),
    off('Edition', 'Text', 2),
    off('Windows 11 Pro', 'Text', 2),
    off('Version', 'Text', 2),
    off('25H2', 'Text', 2),
    on('Rename this PC', 'Button', 513, 1),
  ];
}

function ctxWith(tree: UiElement[]): AgentToolContext {
  const platform = {
    platform: 'win32',
    getUiTree: vi.fn(async () => tree),
    getActiveWindow: vi.fn(async () => ({ processId: 7, processName: 'ApplicationFrameHost', title: 'Settings', bounds: { x: 40, y: 32, width: 816, height: 641 } })),
    getFocusedElement: vi.fn(async () => null),
    getScreenSize: vi.fn(async () => ({ width: 1024, height: 768, dpiRatio: 1 })),
    findElements: vi.fn(async ({ name }: { name?: string }) => tree.filter(e => e.name === name)),
    lastTreeTruncated: false,
  } as unknown as PlatformAdapter;
  return { platform, task: 't', mcpSurface: true, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext;
}

describe('read_screen — offscreen elements', () => {
  it('lists on-screen elements first, then offscreen ones marked "scroll to see"', async () => {
    const res = await tool('read_screen').execute({}, ctxWith(aboutTree()));
    const lines = res.text.split('\n');
    const idx = (s: string) => lines.findIndex(l => l.includes(`"${s}"`));
    expect(idx('Rename this PC')).toBeLessThan(idx('Windows 11 Pro'));
    expect(lines[idx('Windows 11 Pro')]).toMatch(/offscreen/i);
    expect(lines[idx('25H2')]).toMatch(/offscreen/i);
    expect(lines[idx('Rename this PC')]).not.toMatch(/offscreen/i);
    expect(res.text).toMatch(/scroll to see/i);
  });

  it('pages past the cap with offset/limit, and the cap says how', async () => {
    const big: UiElement[] = Array.from({ length: 70 }, (_, i) => on(`Item ${i}`, 'Text', 100 + i));
    const first = await tool('read_screen').execute({}, ctxWith(big));
    expect(first.text).toMatch(/\+10 more/);
    expect(first.text).toMatch(/offset:\s*60/);
    const second = await tool('read_screen').execute({ offset: 60 }, ctxWith(big));
    expect(second.text).toContain('"Item 60"');
    expect(second.text).toContain('"Item 69"');
    expect(second.text).not.toContain('"Item 59"');
    const small = await tool('read_screen').execute({ offset: 5, limit: 3 }, ctxWith(big));
    expect(small.text).toContain('"Item 5"');
    expect(small.text).toContain('"Item 7"');
    expect(small.text).not.toContain('"Item 8"');
  });
});

describe('compile_ui — offscreen elements', () => {
  it('keeps named zero-bounds elements as an offscreen, read-only tail', async () => {
    const platform = ctxWith(aboutTree()).platform;
    const snap = await captureSnapshot(platform);
    expect(snap.elements.map(e => e.name)).not.toContain('Windows 11 Pro'); // on-screen list unchanged
    expect(snap.offscreen?.map(e => e.name)).toEqual(expect.arrayContaining(['Windows 11 Pro', '25H2']));

    const map = await compileUIMap({
      captureSnapshot: async () => snap,
      ocr: async () => ({ elements: [], fullText: '', durationMs: 0 }),
      vision: async () => { throw new Error('no'); },
      getScreenSize: async () => ({ width: 1024, height: 768, dpiRatio: 1 } as any),
      getFocusedElement: async () => null,
      now: 1, snapshotId: 'obs_1',
    }, { max_cost: 'cheap' });
    // Never actionable by id (no bounds to click), never mixed into the ranked list.
    expect(map.elements.some(e => e.text === 'Windows 11 Pro')).toBe(false);
    const text = renderUIMap(map);
    expect(text).toMatch(/offscreen/i);
    expect(text).toContain('"Windows 11 Pro"');
    expect(text).toContain('"25H2"');
    expect(text.indexOf('"Rename this PC"')).toBeLessThan(text.indexOf('"Windows 11 Pro"'));
  });
});

describe('list_children — zero-bounds parent', () => {
  it('falls back to the tree structure when the parent has no bounds', async () => {
    const tree = aboutTree();
    const t = getA11yDepthTools().find(x => x.name === 'a11y_list_children')!;
    const ctx = {
      ensureInitialized: vi.fn(async () => {}),
      platform: ctxWith(tree).platform,
    } as any;
    const res = await t.handler({ parentName: 'Windows specifications', processId: 7 }, ctx);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.text);
    expect(out.children.map((c: { name: string }) => c.name)).toEqual(['Edition', 'Windows 11 Pro', 'Version', '25H2']);
    expect(out.offscreen).toBe(true);
  });

  it('reads the WINDOW\'s tree when the element reports a hosted content process (UWP)', async () => {
    // Settings: the frame window is ApplicationFrameHost (pid 7); its page's
    // elements report SystemSettings (pid 99), whose own top-level read is empty.
    const tree = aboutTree();
    const t = getA11yDepthTools().find(x => x.name === 'a11y_list_children')!;
    const platform = ctxWith(tree).platform as any;
    platform.findElements = vi.fn(async ({ name }: { name?: string }) => tree.filter(e => e.name === name).map(e => ({ ...e, processId: 99 })));
    platform.getUiTree = vi.fn(async (pid?: number) => (pid === 99 ? [] : tree));
    const res = await t.handler({ parentName: 'Windows specifications', processId: 7 }, { ensureInitialized: vi.fn(async () => {}), platform } as any);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.text).children.map((c: { name: string }) => c.name)).toContain('25H2');
  });
});
