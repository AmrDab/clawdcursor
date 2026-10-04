/**
 * PR5 invariant tests — compact surface as a transform over the granular registry.
 *
 * Asserts:
 *   1. Every (compound, action) pair in the ACTION_MAP delegates to a granular
 *      tool that actually exists in getAllTools().
 *   2. For 5+ representative actions, dispatching via the compact compound
 *      produces the same result as calling the granular tool directly.
 *   3. The 6 compound names are exactly the expected set.
 *   4. actionCatalog (as used in compact descriptions) lists every route action.
 *   5. The `task` compound delegates to `delegate_to_agent` with instruction→task remap.
 *   6. getTools({ palette: 'compact' }) === getCompactSurface().
 *   7. getTools({ compactGroup: X }) returns only tools whose .compactGroup === X.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mocks for heavy native deps ─────────────────────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { getAllTools, getCompactSurface, getTools } from '../tools/registry';
import { getCompactTools, COMPOUND_ROUTE_INDEX } from '../tools/compact';
import type { ToolContext } from '../tools/types';
import { makeMockPlatform } from './helpers/mock-platform';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal mock ToolContext — enough for the handlers we test.
 *
 * - ctx.desktop and ctx.a11y are kept for non-migrated System A tools.
 * - ctx.platform is now populated via makeMockPlatform() so that
 *   projected System B tools (type_text, key_press, etc.) can call
 *   toolContextToAgent(ctx) → ctx.platform.* without throwing.
 */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    desktop: {
      mouseClick: vi.fn().mockResolvedValue(undefined),
      keyPress: vi.fn().mockResolvedValue(undefined),
      captureForLLM: vi.fn().mockResolvedValue({
        buffer: Buffer.from('fake'),
        llmWidth: 1280, llmHeight: 720,
        width: 2560, height: 1440,
        scaleFactor: 2,
      }),
      getScreenSize: vi.fn().mockReturnValue({ width: 2560, height: 1440 }),
      mouseMove: vi.fn().mockResolvedValue(undefined),
      mouseScroll: vi.fn().mockResolvedValue(undefined),
      mouseDrag: vi.fn().mockResolvedValue(undefined),
    },
    a11y: {
      getActiveWindow: vi.fn().mockResolvedValue({ title: 'Test', processName: 'test', processId: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
      invalidateCache: vi.fn(),
      getWindows: vi.fn().mockResolvedValue([]),
      readClipboard: vi.fn().mockResolvedValue('clipboard-text'),
      writeClipboard: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue({ success: true }),
      findElement: vi.fn().mockResolvedValue([]),
      invokeElement: vi.fn().mockResolvedValue({ success: true }),
      getFocusedElement: vi.fn().mockResolvedValue(null),
      getScreenContext: vi.fn().mockResolvedValue(''),
    },
    cdp: {
      isConnected: vi.fn().mockResolvedValue(false),
      getPage: vi.fn().mockReturnValue(null),
    },
    platform: makeMockPlatform(),
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Internal ACTION_MAP reconstruction ─────────────────────────────────────
// We reconstruct the mapping by inspecting the compact tool descriptions and
// the existing ACTION_MAP values. For invariant testing we use a typed table
// that mirrors compact.ts exactly (we don't export it from compact.ts, so we
// re-declare it here for assertion purposes only).

interface ActionRoute {
  compound: string;
  action: string;
  delegate: string;
  argRemap?: Record<string, string>;
}

const ACTION_MAP: ActionRoute[] = [
  // computer
  { compound: 'computer', action: 'screenshot',          delegate: 'desktop_screenshot' },
  { compound: 'computer', action: 'screenshot_region',   delegate: 'desktop_screenshot_region' },
  { compound: 'computer', action: 'click',               delegate: 'mouse_click' },
  { compound: 'computer', action: 'double_click',        delegate: 'mouse_double_click' },
  { compound: 'computer', action: 'right_click',         delegate: 'mouse_right_click' },
  { compound: 'computer', action: 'middle_click',        delegate: 'mouse_middle_click' },
  { compound: 'computer', action: 'triple_click',        delegate: 'mouse_triple_click' },
  { compound: 'computer', action: 'hover',               delegate: 'mouse_hover' },
  { compound: 'computer', action: 'move',                delegate: 'mouse_hover' },
  { compound: 'computer', action: 'move_relative',       delegate: 'mouse_move_relative' },
  { compound: 'computer', action: 'scroll',              delegate: 'mouse_scroll' },
  { compound: 'computer', action: 'scroll_horizontal',   delegate: 'mouse_scroll_horizontal' },
  { compound: 'computer', action: 'drag',                delegate: 'mouse_drag' },
  { compound: 'computer', action: 'drag_path',           delegate: 'mouse_drag_stepped', argRemap: { path: 'path' } },
  { compound: 'computer', action: 'mouse_down',          delegate: 'mouse_down' },
  { compound: 'computer', action: 'mouse_up',            delegate: 'mouse_up' },
  { compound: 'computer', action: 'type',                delegate: 'type_text' },
  { compound: 'computer', action: 'key',                 delegate: 'key_press', argRemap: { combo: 'key' } },
  { compound: 'computer', action: 'key_press',           delegate: 'key_press', argRemap: { combo: 'key' } },
  { compound: 'computer', action: 'key_down',            delegate: 'key_down',  argRemap: { combo: 'key' } },
  { compound: 'computer', action: 'key_up',              delegate: 'key_up',    argRemap: { combo: 'key' } },
  { compound: 'computer', action: 'wait',                delegate: 'wait' },
  // accessibility
  { compound: 'accessibility', action: 'read_tree',      delegate: 'read_screen' },
  { compound: 'accessibility', action: 'find',           delegate: 'find_element' },
  { compound: 'accessibility', action: 'get_element',    delegate: 'a11y_get_element' },
  { compound: 'accessibility', action: 'focused',        delegate: 'get_focused_element' },
  { compound: 'accessibility', action: 'invoke',         delegate: 'invoke_element' },
  { compound: 'accessibility', action: 'focus',          delegate: 'focus_element' },
  { compound: 'accessibility', action: 'set_value',      delegate: 'set_field_value' },
  { compound: 'accessibility', action: 'get_value',      delegate: 'a11y_get_value' },
  { compound: 'accessibility', action: 'expand',         delegate: 'a11y_expand' },
  { compound: 'accessibility', action: 'collapse',       delegate: 'a11y_collapse' },
  { compound: 'accessibility', action: 'toggle',         delegate: 'a11y_toggle' },
  { compound: 'accessibility', action: 'select',         delegate: 'a11y_select' },
  { compound: 'accessibility', action: 'state',          delegate: 'get_element_state' },
  { compound: 'accessibility', action: 'list_children',  delegate: 'a11y_list_children', argRemap: { name: 'parentName' } },
  { compound: 'accessibility', action: 'wait_for',       delegate: 'wait_for_element' },
  // window
  { compound: 'window', action: 'list',           delegate: 'get_windows' },
  { compound: 'window', action: 'active',         delegate: 'get_active_window' },
  { compound: 'window', action: 'focus',          delegate: 'focus_window' },
  { compound: 'window', action: 'maximize',       delegate: 'maximize_window' },
  { compound: 'window', action: 'minimize',       delegate: 'minimize_window_to_taskbar' },
  { compound: 'window', action: 'restore',        delegate: 'restore_window' },
  { compound: 'window', action: 'close',          delegate: 'close_window' },
  { compound: 'window', action: 'resize',         delegate: 'resize_window' },
  { compound: 'window', action: 'list_displays',  delegate: 'list_displays' },
  { compound: 'window', action: 'screen_size',    delegate: 'get_screen_size' },
  { compound: 'window', action: 'open_app',       delegate: 'open_app' },
  { compound: 'window', action: 'open_file',      delegate: 'open_file' },
  { compound: 'window', action: 'open_url',       delegate: 'open_url' },
  { compound: 'window', action: 'switch_tab',     delegate: 'switch_tab_os' },
  { compound: 'window', action: 'navigate',       delegate: 'navigate_browser' },
  // system
  { compound: 'system', action: 'clipboard_read',    delegate: 'read_clipboard' },
  { compound: 'system', action: 'clipboard_write',   delegate: 'write_clipboard' },
  { compound: 'system', action: 'system_time',       delegate: 'get_system_time' },
  { compound: 'system', action: 'ocr',               delegate: 'ocr_read_screen' },
  { compound: 'system', action: 'undo',              delegate: 'undo_last' },
  { compound: 'system', action: 'shortcuts_list',    delegate: 'shortcuts_list' },
  { compound: 'system', action: 'shortcuts_run',     delegate: 'shortcuts_execute' },
  { compound: 'system', action: 'delegate',          delegate: 'delegate_to_agent' },
  { compound: 'system', action: 'detect_webview',    delegate: 'detect_webview_apps' },
  { compound: 'system', action: 'relaunch_with_cdp', delegate: 'relaunch_with_cdp' },
  // browser
  { compound: 'browser', action: 'connect',        delegate: 'cdp_connect' },
  { compound: 'browser', action: 'page_context',   delegate: 'cdp_page_context' },
  { compound: 'browser', action: 'read_text',      delegate: 'cdp_read_text' },
  { compound: 'browser', action: 'click',          delegate: 'cdp_click' },
  { compound: 'browser', action: 'type',           delegate: 'cdp_type' },
  { compound: 'browser', action: 'select_option',  delegate: 'cdp_select_option' },
  { compound: 'browser', action: 'evaluate',       delegate: 'cdp_evaluate' },
  { compound: 'browser', action: 'wait_for',       delegate: 'cdp_wait_for_selector' },
  { compound: 'browser', action: 'list_tabs',      delegate: 'cdp_list_tabs' },
  { compound: 'browser', action: 'switch_tab',     delegate: 'cdp_switch_tab' },
  { compound: 'browser', action: 'scroll',         delegate: 'cdp_scroll' },
  { compound: 'browser', action: 'navigate',       delegate: 'navigate_browser' },
  // task — special: instruction→task remap, single pseudo-action
  { compound: 'task', action: '__task__', delegate: 'delegate_to_agent', argRemap: { instruction: 'task' } },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('compact-as-transform invariants', () => {

  // ── 1. Every ACTION_MAP delegate exists in getAllTools() ─────────────────
  describe('1. Every ACTION_MAP delegate resolves in getAllTools()', () => {
    const granularNames = new Set(getAllTools().map(t => t.name));

    for (const route of ACTION_MAP) {
      it(`${route.compound}.${route.action} → delegate "${route.delegate}" exists`, () => {
        expect(granularNames.has(route.delegate)).toBe(true);
      });
    }
  });

  // ── 1b. The LIVE route tables resolve too (no hand-copy drift) ───────────
  // The local ACTION_MAP above is a readable snapshot, but it drifted (it
  // missed compile_ui/find_*/smart_* — review 2026-06-11). This block iterates
  // the REAL tables exported from compact.ts, so a future action whose
  // delegate was never registered fails here even if the snapshot is stale.
  describe('1b. Every LIVE compact route delegate resolves in getAllTools()', () => {
    const granularNames = new Set(getAllTools().map(t => t.name));

    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      for (const route of routes) {
        it(`${compound}.${route.action} → delegate "${route.delegate}" exists (live table)`, () => {
          expect(granularNames.has(route.delegate)).toBe(true);
        });
      }
    }
  });

  // ── 2. 6 compound names are exactly the expected set ────────────────────
  it('2. Compact surface exposes the 6 primitive compounds + the batch meta-tool', () => {
    const compactTools = getCompactTools();
    const names = compactTools.map(t => t.name).sort();
    expect(names).toEqual(
      ['accessibility', 'batch', 'browser', 'computer', 'system', 'task', 'window'],
    );
  });

  // ── 3. actionCatalog lists every route action (via compact description) ─
  it('3. Each compact tool description mentions all its actions', () => {
    const compactTools = getCompactTools();
    const compoundGroups: Record<string, string[]> = {};
    for (const route of ACTION_MAP) {
      if (route.action === '__task__') continue; // task is special
      if (!compoundGroups[route.compound]) compoundGroups[route.compound] = [];
      compoundGroups[route.compound].push(route.action);
    }

    for (const compound of Object.keys(compoundGroups)) {
      const tool = compactTools.find(t => t.name === compound)!;
      expect(tool).toBeDefined();
      for (const action of compoundGroups[compound]) {
        expect(tool.description).toContain(action);
      }
    }
  });

  // ── 4. task compound delegates to delegate_to_agent with instruction→task ─
  it('4. task compound: missing action dispatches delegate_to_agent with instruction→task remap', async () => {
    const compactTools = getCompactTools();
    const taskTool = compactTools.find(t => t.name === 'task')!;
    expect(taskTool).toBeDefined();

    // The task compound only exposes `instruction` parameter
    expect(taskTool.parameters).toHaveProperty('instruction');

    // Calling it should attempt to delegate to delegate_to_agent.
    // Since delegate_to_agent tries to fetch http://127.0.0.1:3847/task,
    // it will fail with ECONNREFUSED. We assert it returns an isError result
    // (i.e., the dispatch reached delegate_to_agent and it returned an error),
    // NOT a "unknown action" or "delegate not registered" error.
    const ctx = makeCtx();
    const result = await taskTool.handler({ instruction: 'test task' }, ctx);
    // Must be an error (agent not running in test), but NOT a compound dispatch error
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('unknown action');
    expect(result.text).not.toContain('not registered');
    // Should contain an agent-related message (ECONNREFUSED → "not running" or similar)
    expect(
      result.text.includes('not running') ||
      result.text.includes('ECONNREFUSED') ||
      result.text.includes('agent') ||
      result.text.includes('clawdcursor'),
    ).toBe(true);
  });

  // ── 5. dispatch produces same result as calling granular tool directly ───
  describe('5. Dispatch result matches calling granular tool directly', () => {

    // 5a. computer.screenshot → desktop_screenshot
    it('computer(screenshot) matches desktop_screenshot()', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const computerTool = compactTools.find(t => t.name === 'computer')!;
      const granularTool = getAllTools().find(t => t.name === 'desktop_screenshot')!;

      const compactResult = await computerTool.handler({ action: 'screenshot' }, ctx);
      const granularResult = await granularTool.handler({}, ctx);

      // Both should succeed (no isError) and return an image
      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      expect(compactResult.image).toBeDefined();
      expect(granularResult.image).toBeDefined();
    });

    // 5b. computer(type) → type_text
    it('computer(type) matches type_text()', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const computerTool = compactTools.find(t => t.name === 'computer')!;
      const granularTool = getAllTools().find(t => t.name === 'type_text')!;

      const compactResult = await computerTool.handler({ action: 'type', text: 'hello' }, ctx);
      const granularResult = await granularTool.handler({ text: 'hello' }, ctx);

      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      expect(compactResult.text).toBe(granularResult.text);
    });

    // 5c. computer(key) → key_press (with combo→key remap)
    it('computer(key) with combo remap matches key_press(key)', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const computerTool = compactTools.find(t => t.name === 'computer')!;
      const granularTool = getAllTools().find(t => t.name === 'key_press')!;

      // compact sends combo: 'ctrl+c' → granular receives key: 'ctrl+c'
      const compactResult = await computerTool.handler({ action: 'key', combo: 'ctrl+c' }, ctx);
      const granularResult = await granularTool.handler({ key: 'ctrl+c' }, ctx);

      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      expect(compactResult.text).toBe(granularResult.text);
    });

    // 5d. window(active) → get_active_window
    it('window(active) matches get_active_window()', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const windowTool = compactTools.find(t => t.name === 'window')!;
      const granularTool = getAllTools().find(t => t.name === 'get_active_window')!;

      const compactResult = await windowTool.handler({ action: 'active' }, ctx);
      const granularResult = await granularTool.handler({}, ctx);

      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      expect(compactResult.text).toBe(granularResult.text);
    });

    // 5e. system(clipboard_read) → read_clipboard
    it('system(clipboard_read) matches read_clipboard()', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const systemTool = compactTools.find(t => t.name === 'system')!;
      const granularTool = getAllTools().find(t => t.name === 'read_clipboard')!;

      const compactResult = await systemTool.handler({ action: 'clipboard_read' }, ctx);
      const granularResult = await granularTool.handler({}, ctx);

      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      expect(compactResult.text).toBe(granularResult.text);
    });

    // 5f. system(system_time) → get_system_time
    it('system(system_time) matches get_system_time()', async () => {
      const ctx = makeCtx();
      const compactTools = getCompactTools();
      const systemTool = compactTools.find(t => t.name === 'system')!;
      const granularTool = getAllTools().find(t => t.name === 'get_system_time')!;

      const compactResult = await systemTool.handler({ action: 'system_time' }, ctx);
      const granularResult = await granularTool.handler({}, ctx);

      // Both should return valid JSON with an 'iso' field
      expect(compactResult.isError).toBeFalsy();
      expect(granularResult.isError).toBeFalsy();
      const cp = JSON.parse(compactResult.text);
      const gp = JSON.parse(granularResult.text);
      expect(cp).toHaveProperty('iso');
      expect(gp).toHaveProperty('iso');
    });
  });

  // ── 6. Unknown action returns error (not crash) ──────────────────────────
  it('6. Unknown action returns isError with valid-actions hint', async () => {
    const compactTools = getCompactTools();
    const computerTool = compactTools.find(t => t.name === 'computer')!;
    const ctx = makeCtx();

    const result = await computerTool.handler({ action: 'totally_invalid_action_xyz' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown action');
    expect(result.text).toContain('totally_invalid_action_xyz');
  });

  // ── 7. Missing action returns error ─────────────────────────────────────
  it('7. Missing action returns isError', async () => {
    const compactTools = getCompactTools();
    const accessibilityTool = compactTools.find(t => t.name === 'accessibility')!;
    const ctx = makeCtx();

    const result = await accessibilityTool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"action" is required');
  });

  // ── 8. getTools({ palette: 'compact' }) === getCompactSurface() ─────────
  it('8. getTools({ palette: "compact" }) returns the same set as getCompactSurface()', () => {
    const viaGetTools = getTools({ palette: 'compact' }).map(t => t.name).sort();
    const viaGetCompactSurface = getCompactSurface().map(t => t.name).sort();
    expect(viaGetTools).toEqual(viaGetCompactSurface);
  });

  // ── 9. getTools({ compactGroup: X }) returns only tools with that group ──
  it('9. getTools({ compactGroup: "computer" }) returns only computer-group tools', () => {
    const tools = getTools({ compactGroup: 'computer' });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.compactGroup).toBe('computer');
    }
    // Spot-check: known computer tools
    const names = tools.map(t => t.name);
    expect(names).toContain('mouse_click');
    expect(names).toContain('key_press');
    expect(names).toContain('desktop_screenshot');
    expect(names).toContain('type_text');
  });

  it('9b. getTools({ compactGroup: "accessibility" }) returns only accessibility-group tools', () => {
    const tools = getTools({ compactGroup: 'accessibility' });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.compactGroup).toBe('accessibility');
    }
    const names = tools.map(t => t.name);
    expect(names).toContain('read_screen');
    expect(names).toContain('find_element');
    expect(names).toContain('invoke_element');
  });

  it('9c. getTools({ compactGroup: "system" }) contains system tools', () => {
    const tools = getTools({ compactGroup: 'system' });
    const names = tools.map(t => t.name);
    expect(names).toContain('read_clipboard');
    expect(names).toContain('write_clipboard');
    expect(names).toContain('get_system_time');
    expect(names).toContain('ocr_read_screen');
    // delegate_to_agent's PRIMARY group is 'task' (it powers the whole task compound).
    // It also appears in system.delegate via ACTION_MAP, but a granular tool can
    // only carry one compactGroup — we assign 'task' as canonical.
    expect(names).not.toContain('delegate_to_agent');
    expect(names).toContain('detect_webview_apps');
    expect(names).toContain('relaunch_with_cdp');
  });

  it('9d. getTools({ compactGroup: "task" }) returns delegate_to_agent', () => {
    const tools = getTools({ compactGroup: 'task' });
    const names = tools.map(t => t.name);
    expect(names).toContain('delegate_to_agent');
  });

  // ── 10. granular tools not in any compactGroup ──────────────────────────
  it('10. smart_read, smart_click, smart_type, minimize_window have no compactGroup', () => {
    const all = getAllTools();
    const noGroup = ['smart_read', 'smart_click', 'smart_type', 'minimize_window'];
    for (const name of noGroup) {
      const tool = all.find(t => t.name === name);
      expect(tool, `tool ${name} should exist in getAllTools()`).toBeDefined();
      expect(tool!.compactGroup, `${name} should have no compactGroup`).toBeUndefined();
    }
  });

  // ── 11. getAllTools() back-compat === getTools() ────────────────────────
  it('11. getAllTools() equals getTools() (granular default)', () => {
    const via1 = getAllTools().map(t => t.name).sort();
    const via2 = getTools().map(t => t.name).sort();
    expect(via1).toEqual(via2);
  });
});

// ── 12. Agent-friction regression fixes (from the v1-alpha live test) ─────────
describe('12. compound surface agent-friction fixes', () => {
  const computer = () => getCompactTools().find(t => t.name === 'computer')!;
  const system = () => getCompactTools().find(t => t.name === 'system')!;

  it('keyboard: compound publishes the granular `key` as an alias for `combo` (anti silent-drop)', () => {
    const params = computer().parameters as Record<string, { description?: string }>;
    expect(params).toHaveProperty('combo'); // canonical compound name
    expect(params).toHaveProperty('key');   // granular-native alias — was silently stripped before
    expect(params.key.description ?? '').toMatch(/alias/i);
  });

  it('keyboard: dispatching via the `key` alias reaches key_press (no drop, no crash)', async () => {
    const ctx = makeCtx();
    const res = await computer().handler({ action: 'key', key: 'super' }, ctx);
    expect(res.isError).toBeFalsy();
    // System B key tool routes through ctx.platform.keyPress (the real runtime path).
    expect(ctx.platform!.keyPress).toHaveBeenCalledWith('super');
  });

  it('keyboard: the canonical `combo` field still works (back-compat)', async () => {
    const ctx = makeCtx();
    await computer().handler({ action: 'key', combo: 'ctrl+c' }, ctx);
    expect(ctx.platform!.keyPress).toHaveBeenCalledWith('ctrl+c');
  });

  it('keyboard: space-separated combos are pressed in sequence', async () => {
    const ctx = makeCtx();
    await computer().handler({ action: 'key', combo: 'Down Down End' }, ctx);
    expect(ctx.platform!.keyPress).toHaveBeenNthCalledWith(1, 'Down');
    expect(ctx.platform!.keyPress).toHaveBeenNthCalledWith(2, 'Down');
    expect(ctx.platform!.keyPress).toHaveBeenNthCalledWith(3, 'End');
  });

  it('keyboard: a missing key/combo returns an actionable error, not a crash', async () => {
    const ctx = makeCtx();
    const res = await computer().handler({ action: 'key' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text.toLowerCase()).toContain('required');
    expect(ctx.platform!.keyPress).not.toHaveBeenCalled();
  });

  it('taxonomy: a misrouted action names the compound that owns it', async () => {
    const ctx = makeCtx();
    // `read_tree` lives only on `accessibility`; calling it on `system` should
    // point there (this exercises the direct/batch path — over MCP the enum
    // layer rejects first, which is why launch actions are aliased instead).
    const res = await system().handler({ action: 'read_tree' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('accessibility'); // hint points at the owning compound
    expect(res.text).not.toContain('not registered');
  });

  it('taxonomy: the launch family is reachable from `system` too (open_app alias)', () => {
    const sys = getCompactTools().find(t => t.name === 'system')!;
    const actions = (sys.parameters.action as { enum?: string[] }).enum ?? [];
    expect(actions).toContain('open_app'); // intuitive `system open_app` is now valid over MCP
    expect(actions).toContain('open_url');
  });

  // ── Regression: compound args the delegate does not accept ────────────────
  // The compound schema unions every delegate's parameters, so a param only one
  // action implements is published on the whole tool. Previously an action that
  // never declared it ignored it in silence: `max_cost: 'cheap'` still ran OCR
  // on smart_read, and `space: 'screen'` was dropped by pointer tools that
  // always image-scaled. Same class as GHSA-35pc-g74h-p476.
  describe('13. args the delegate does not declare are surfaced, not silently dropped', () => {
    it('warns, and names which actions DO accept the ignored arg', async () => {
      const acc = getCompactTools().find(t => t.name === 'accessibility')!;
      const res = await acc.handler(
        { action: 'smart_read', scope: 'window', max_cost: 'cheap' },
        makeCtx(),
      );
      expect(res.text).toContain('ignored');
      expect(res.text).toContain('max_cost');
      // the hint must point at the actions that really honor it
      expect(res.text).toMatch(/accepted by:.*compile_ui/);
    });

    it('does NOT warn when the delegate declares the arg', async () => {
      const acc = getCompactTools().find(t => t.name === 'accessibility')!;
      const res = await acc.handler(
        { action: 'compile_ui', max_cost: 'cheap' },
        makeCtx(),
      );
      expect(res.text ?? '').not.toContain('ignored an argument');
    });

    it('never warns about `expect` — projected System B tools honor it undeclared', async () => {
      const acc = getCompactTools().find(t => t.name === 'accessibility')!;
      const res = await acc.handler(
        { action: 'read_tree', scope: 'window', expect: 'something' },
        makeCtx(),
      );
      expect(res.text ?? '').not.toContain('expect (accepted by');
      expect(res.text ?? '').not.toMatch(/ignored .*expect/);
    });

    it('is a warning, not an error — a surplus arg must not fail a running agent', async () => {
      // read_tree succeeds under the mock platform and does NOT declare
      // max_cost, so this isolates the warning path: a call that would have
      // succeeded must still succeed, with the warning appended.
      const acc = getCompactTools().find(t => t.name === 'accessibility')!;
      const clean = await acc.handler({ action: 'read_tree', scope: 'window' }, makeCtx());
      const warned = await acc.handler(
        { action: 'read_tree', scope: 'window', max_cost: 'cheap' },
        makeCtx(),
      );
      expect(clean.isError).not.toBe(true);
      expect(warned.isError).toBe(clean.isError);   // surplus arg changed nothing
      expect(warned.text).toContain('max_cost');
    });
  });

  // ── Regression: `space` honored by every coordinate action ────────────────
  // SAFETY. These System A tools published `space` via the union but always
  // image-scaled, so a11y-snapshot (physical) coords were scaled a SECOND time
  // and the pointer landed on a different control than the agent resolved.
  describe('14. space:"screen" suppresses image-space scaling on every pointer action', () => {
    it.each([
      ['double_click', 'mouseDoubleClick'],
      ['right_click', 'mouseRightClick'],
      ['hover', 'mouseMove'],
    ])('computer.%s honors space:"screen"', async (action, desktopFn) => {
      const spy = vi.fn();
      const ctx = makeCtx({
        getMouseScaleFactor: () => 3,
        desktop: { ...makeCtx().desktop, [desktopFn]: spy } as never,
      });
      const comp = getCompactTools().find(t => t.name === 'computer')!;
      await comp.handler({ action, x: 100, y: 200, space: 'screen' }, ctx);
      expect(spy).toHaveBeenCalledWith(100, 200);
    });

    it('computer.double_click still scales when space is omitted', async () => {
      const spy = vi.fn();
      const ctx = makeCtx({
        getMouseScaleFactor: () => 3,
        desktop: { ...makeCtx().desktop, mouseDoubleClick: spy } as never,
      });
      const comp = getCompactTools().find(t => t.name === 'computer')!;
      await comp.handler({ action: 'double_click', x: 100, y: 200 }, ctx);
      expect(spy).toHaveBeenCalledWith(300, 600);
    });

    it('every computer action that takes x/y also declares space', () => {
      const routes = COMPOUND_ROUTE_INDEX.computer ?? [];
      const coordActions = routes.filter(r => {
        const d = getAllTools().find(t => t.name === r.delegate);
        return !!d && 'x' in d.parameters && 'y' in d.parameters;
      });
      expect(coordActions.length).toBeGreaterThan(3);
      for (const r of coordActions) {
        const d = getAllTools().find(t => t.name === r.delegate)!;
        expect(Object.keys(d.parameters), `${r.action} -> ${r.delegate}`).toContain('space');
      }
    });
  });
});
