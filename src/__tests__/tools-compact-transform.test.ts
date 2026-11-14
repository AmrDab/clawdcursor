/**
 * PR5 invariant tests — compact surface as a transform over the granular registry.
 *
 * Asserts:
 *   1. Every (compound, action) route of compact.ts delegates to a granular
 *      tool that actually exists in getAllTools().
 *   3. Each compact description lists every route action.
 *   5. For representative actions, dispatching via the compact compound
 *      produces the same result as calling the granular tool directly.
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

vi.mock('../platform/ocr-engine', () => {
  class OcrEngine {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  }
  return { OcrEngine, ocrEngine: () => new OcrEngine() };
});

// ── Imports after mocks ──────────────────────────────────────────────────────

import { getAllTools, getTools } from '../tools/registry';
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('compact-as-transform invariants', () => {

  // ── 1. Every compact route delegate exists in getAllTools() ─────────────
  describe('1. Every compact route delegate resolves in getAllTools()', () => {
    const granularNames = new Set(getAllTools().map(t => t.name));

    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      for (const route of routes) {
        it(`${compound}.${route.action} → delegate "${route.delegate}" exists `, () => {
          expect(granularNames.has(route.delegate)).toBe(true);
        });
      }
    }
  });

  // ── 3. actionCatalog lists every route action (via compact description) ─
  it('3. Each compact tool description mentions all its actions', () => {
    const compactTools = getCompactTools();
    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      const tool = compactTools.find(t => t.name === compound)!;
      expect(tool).toBeDefined();
      for (const { action } of routes) {
        expect(tool.description).toContain(action);
      }
    }
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
