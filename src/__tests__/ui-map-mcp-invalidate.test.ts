import { describe, it, expect } from 'vitest';
import { projectToToolDefinition } from '../tools/projected/project-mcp';
import { buildUnifiedTools } from '../tools/projected/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';
import type { ToolContext } from '../tools/types';

const mapWith = (id: string): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'notepad', window_title: 'Untitled - Notepad',
  window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1, compiled_at: '0',
  sources_used: ['window', 'a11y'], elements: [], anchors: {},
});

function ctxWith(holder: UIMapHolder): ToolContext {
  const platform = {
    getActiveWindow: async () => ({ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    mouseClick: async () => {}, mouseMove: async () => {}, keyPress: async () => {}, typeText: async () => {},
    getScreenSize: async () => ({ logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }),
    getFocusedElement: async () => null, getUiTree: async () => [],
  } as any;
  return {
    ensureInitialized: async () => {}, platform, cdp: null,
    desktop: { getScreenSize: () => ({ width: 800, height: 600 }) },
    getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
    uiMaps: holder,
  } as unknown as ToolContext;
}

describe('MCP path invalidates the shared UIMap holder on screen-changing tools', () => {
  it('a changesScreen System B tool invalidates the holder via the projector', async () => {
    const holder = new UIMapHolder();
    const id = holder.nextId();
    holder.put(mapWith(id), Date.now());
    expect(holder.resolve(id, Date.now()).ok).toBe(true); // current before

    // 'key' has changesScreen:true; mock platform.keyPress is a no-op above.
    const keyTool = buildUnifiedTools().find(t => t.name === 'key' && t.changesScreen)!;
    expect(keyTool).toBeDefined();
    const def = projectToToolDefinition(keyTool);
    await def.handler({ combo: 'a' }, ctxWith(holder));

    expect(holder.resolve(id, Date.now())).toEqual({ ok: false, reason: 'stale' }); // stale after
  });
});
