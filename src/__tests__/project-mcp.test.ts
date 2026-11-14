/**
 * Tests for src/tools/projected/project-mcp.ts (Step 2 of the re-projection refactor).
 *
 * Tests:
 *   1. jsonSchemaToParamDefs: correctly converts a UnifiedTool.inputSchema
 *      into a Record<string, ParameterDef> (type, description, required, enum).
 *
 *   2. projectToToolDefinition: projecting a representative System B tool (read_screen)
 *      yields a structurally valid ToolDefinition (name, description, parameters,
 *      category, safetyTier, handler).
 *
 *   3. Name mapping: the type → type_text mapping is applied (mcpName from TOOL_META).
 *
 *   4. Handler integration: calling the projected handler with a mock ToolContext
 *      returns a valid ToolResult (text present, isError boolean) without throwing.
 *
 *   5. unifiedToToolResult: success→isError false, failure→isError true.
 *
 *   6. toolContextToAgent: async construction from a mock ToolContext resolves
 *      to a well-shaped AgentToolContext.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps BEFORE any imports ──────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class {
    constructor(
      public left: number, public top: number,
      public width: number, public height: number,
    ) {}
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
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

import {
  jsonSchemaToParamDefs,
  toolContextToAgent,
  unifiedToToolResult,
  projectToToolDefinition,
} from '../tools/projected/project-mcp';
import { buildUnifiedTools } from '../tools/projected/tools';
import { TOOL_META } from '../tools/projected/tool-meta';
import type { UnifiedTool, UnifiedToolResult } from '../tools/projected/types';
import type { ToolContext } from '../tools/types';

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal mock PlatformAdapter that returns safe stubs for all
 * methods System B tools may call via AgentToolContext.platform.*.
 */
function makeMockPlatform() {
  return {
    platform: 'win32' as const,
    getActiveWindow: vi.fn().mockResolvedValue({
      title: 'TestApp',
      processName: 'test.exe',
      processId: 42,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    listWindows: vi.fn().mockResolvedValue([]),
    focusWindow: vi.fn().mockResolvedValue(true),
    getUiTree: vi.fn().mockResolvedValue([]),
    findElements: vi.fn().mockResolvedValue([]),
    invokeElement: vi.fn().mockResolvedValue({ success: true }),
    getFocusedElement: vi.fn().mockResolvedValue(null),
    waitForElement: vi.fn().mockResolvedValue(null),
    mouseClick: vi.fn().mockResolvedValue(undefined),
    mouseScroll: vi.fn().mockResolvedValue(undefined),
    mouseDrag: vi.fn().mockResolvedValue(undefined),
    mouseMove: vi.fn().mockResolvedValue(undefined),
    mouseMoveRelative: vi.fn().mockResolvedValue(undefined),
    mouseDown: vi.fn().mockResolvedValue(undefined),
    mouseUp: vi.fn().mockResolvedValue(undefined),
    keyPress: vi.fn().mockResolvedValue(undefined),
    keyDown: vi.fn().mockResolvedValue(undefined),
    keyUp: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    readClipboard: vi.fn().mockResolvedValue(''),
    writeClipboard: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue({ pid: 1, title: 'TestApp' }),
    setWindowState: vi.fn().mockResolvedValue(true),
    setWindowBounds: vi.fn().mockResolvedValue(true),
    listDisplays: vi.fn().mockResolvedValue([]),
    screenshot: vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-image'),
      width: 1280,
      height: 720,
      format: 'jpeg',
    }),
  };
}

/**
 * Build a minimal mock ToolContext. Mirrors the shape of the real ToolContext
 * in src/tools/types.ts without any native I/O.
 */
function makeMockToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const mockPlatform = makeMockPlatform();

  return {
    desktop: {
      getScreenSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
      captureForLLM: vi.fn().mockResolvedValue({
        buffer: Buffer.from('fake'),
        width: 1920, height: 1080, llmWidth: 1280, llmHeight: 720, scaleFactor: 1.5,
      }),
    },
    a11y: {
      getActiveWindow: vi.fn().mockResolvedValue(null),
      getWindows: vi.fn().mockResolvedValue([]),
      readClipboard: vi.fn().mockResolvedValue(''),
      writeClipboard: vi.fn().mockResolvedValue(undefined),
      invalidateCache: vi.fn(),
      getScreenContext: vi.fn().mockResolvedValue(''),
    },
    cdp: {
      isConnected: vi.fn().mockResolvedValue(false),
      ensureConnected: vi.fn().mockResolvedValue(false),
    },
    platform: mockPlatform as any,
    getLogBuffer: undefined,
    getMouseScaleFactor: vi.fn().mockReturnValue(1),
    getScreenshotScaleFactor: vi.fn().mockReturnValue(1),
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('jsonSchemaToParamDefs', () => {
  it('converts a simple string property', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
      },
      required: ['name'],
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.name).toMatchObject({
      type: 'string',
      description: 'The name',
      required: true,
    });
  });

  it('marks optional properties correctly', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        requiredProp: { type: 'string', description: 'req' },
        optionalProp: { type: 'number', description: 'opt' },
      },
      required: ['requiredProp'],
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.requiredProp.required).toBe(true);
    expect(defs.optionalProp.required).toBe(false);
  });

  it('maps JSON Schema "number" type to ParameterDef "number"', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Count' },
      },
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.count.type).toBe('number');
  });

  it('maps JSON Schema "boolean" type to ParameterDef "boolean"', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        flag: { type: 'boolean', description: 'A flag' },
      },
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.flag.type).toBe('boolean');
  });

  it('preserves string enum values', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Direction',
        },
      },
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.direction.enum).toEqual(['up', 'down']);
  });

  it('handles empty properties gracefully', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(Object.keys(defs)).toHaveLength(0);
  });

  it('preserves numeric maximum constraint', () => {
    const schema: UnifiedTool['inputSchema'] = {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Wait ms', maximum: 5000 },
      },
      additionalProperties: false,
    };
    const defs = jsonSchemaToParamDefs(schema);
    expect(defs.ms.maximum).toBe(5000);
  });
});

describe('unifiedToToolResult', () => {
  it('maps success=true to isError=false', () => {
    const r: UnifiedToolResult = { success: true, text: 'ok' };
    const result = unifiedToToolResult(r);
    expect(result.text).toBe('ok');
    expect(result.isError).toBe(false);
  });

  it('maps success=false to isError=true', () => {
    const r: UnifiedToolResult = { success: false, text: 'boom' };
    const result = unifiedToToolResult(r);
    expect(result.isError).toBe(true);
  });

  it('has no image field', () => {
    const r: UnifiedToolResult = { success: true, text: 'no pic' };
    const result = unifiedToToolResult(r);
    expect(result.image).toBeUndefined();
  });
});

describe('toolContextToAgent', () => {
  it('returns a well-shaped AgentToolContext', async () => {
    const ctx = makeMockToolContext();
    const agentCtx = await toolContextToAgent(ctx);

    expect(agentCtx.platform).toBeDefined();
    expect(agentCtx.screen).toMatchObject({
      physicalWidth: 1920,
      physicalHeight: 1080,
    });
  });

  // The projected clicks scale by the latest screenshot's own factor (a max_edge screenshot): dropping it misplaces every click.
  it("carries the latest screenshot's image-to-mouse scale", async () => {
    const ctx = makeMockToolContext({ getMouseScaleFactor: vi.fn().mockReturnValue(5) });
    expect((await toolContextToAgent(ctx)).imageToMouse).toBe(5);
  });

  it('calls ensureInitialized on the ToolContext', async () => {
    const ctx = makeMockToolContext();
    await toolContextToAgent(ctx);
    expect(ctx.ensureInitialized).toHaveBeenCalled();
  });

  it('throws when ctx.platform is absent', async () => {
    const ctx = makeMockToolContext({ platform: undefined });
    await expect(toolContextToAgent(ctx)).rejects.toThrow(
      'toolContextToAgent: ctx.platform is not initialized',
    );
  });
});

describe('projectToToolDefinition', () => {
  // Use read_screen as a representative tool (blind + hybrid + vision, same name in both systems).
  let readScreenTool: UnifiedTool;
  let typeTool: UnifiedTool;

  beforeEach(() => {
    const blindTools = buildUnifiedTools();
    const found = blindTools.find(t => t.name === 'read_screen');
    if (!found) throw new Error('read_screen not found in buildUnifiedTools("blind")');
    readScreenTool = found;

    const foundType = blindTools.find(t => t.name === 'type');
    if (!foundType) throw new Error('type not found in buildUnifiedTools("blind")');
    typeTool = foundType;
  });

  it('produces a structurally valid ToolDefinition for read_screen', () => {
    const def = projectToToolDefinition(readScreenTool);

    expect(def.name).toBe('read_screen');
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.category).toBeDefined();
    expect(def.safetyTier).toBeDefined();
  });

  it('handler calls succeed and return a valid ToolResult', async () => {
    const def = projectToToolDefinition(readScreenTool);
    const ctx = makeMockToolContext();

    // Must not throw — the system B execute() wraps errors internally.
    await expect(def.handler({}, ctx)).resolves.toBeTruthy();
  });

  it('the projection publishes the TOOL_META MCP name (type → type_text; the full rename table is checked below)', () => {
    expect(projectToToolDefinition(typeTool).name).toBe('type_text');
  });

  it('handler does not throw for the type tool', async () => {
    const def = projectToToolDefinition(typeTool);
    const ctx = makeMockToolContext();

    await expect(def.handler({ text: 'hello world' }, ctx)).resolves.toBeTruthy();
  });

  it('throws when passed a tool name not in TOOL_META', () => {
    const fakeTool: UnifiedTool = {
      name: '__nonexistent_tool__',
      description: 'test',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute() { return { success: true, text: 'x' }; },
    };
    expect(() => projectToToolDefinition(fakeTool)).toThrow(
      'no TOOL_META entry for System B tool "__nonexistent_tool__"',
    );
  });

  it('metadata fields match TOOL_META for read_screen', () => {
    const def = projectToToolDefinition(readScreenTool);
    expect(def.category).toBe('perception');
    expect(def.safetyTier).toBe(0);
  });
});

describe('name mapping completeness', () => {
  it('all expected name-change pairs are correct', () => {
    const expectedRenames: Array<{ sysbName: string; mcpName: string }> = [
      { sysbName: 'list_windows',    mcpName: 'get_windows'      },
      { sysbName: 'click',           mcpName: 'mouse_click'      },
      { sysbName: 'drag',            mcpName: 'mouse_drag'       },
      { sysbName: 'scroll',          mcpName: 'mouse_scroll'     },
      { sysbName: 'type',            mcpName: 'type_text'        },
      { sysbName: 'key',             mcpName: 'key_press'        },
      { sysbName: 'browser_connect', mcpName: 'cdp_connect'      },
      { sysbName: 'browser_read',    mcpName: 'cdp_page_context' },
      { sysbName: 'browser_click',   mcpName: 'cdp_click'        },
      { sysbName: 'browser_type',    mcpName: 'cdp_type'         },
    ];

    for (const { sysbName, mcpName } of expectedRenames) {
      expect(TOOL_META[sysbName]?.mcpName).toBe(mcpName);
    }
  });
});

// ── MCP-route parity (audit 2026-06-10, finding E) ───────────────────────────

import { UIMapHolder } from '../core/sense/ui-map-holder';

describe('projected handler — MCP route parity', () => {
  const keyTool = () => buildUnifiedTools().find(t => t.name === 'key')!;
  const invokeTool = () => buildUnifiedTools().find(t => t.name === 'invoke_element')!;

  it('honors a caller-supplied expect assertion array (DEVIATION on failure, not silent drop)', async () => {
    const def = projectToToolDefinition(keyTool());
    const ctx = makeMockToolContext();
    // app_running("nope") fails against the empty listWindows stub.
    const r = await def.handler({ combo: 'a', expect: [{ type: 'app_running', name: 'nope' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('DEVIATION');
  }, 15_000);

  it('verifies a passing expect and reports the check', async () => {
    const def = projectToToolDefinition(keyTool());
    const ctx = makeMockToolContext();
    (ctx.platform as any).listWindows = vi.fn().mockResolvedValue([
      { processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false },
    ]);
    const r = await def.handler({ combo: 'a', expect: [{ type: 'app_running', name: 'notepad' }] }, ctx);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/verified/i);
  });

  it('does NOT invalidate the holder when a screen-changing call failed without acting (rejected ref)', async () => {
    const def = projectToToolDefinition(invokeTool());
    const holder = new UIMapHolder();
    const spy = vi.spyOn(holder, 'invalidate');
    const ctx = makeMockToolContext({ uiMaps: holder } as Partial<ToolContext>);
    const r = await def.handler({ element_id: 'el_9', snapshot_id: 'obs_99' }, ctx);
    expect(r.isError).toBe(true);            // unknown snapshot → ref rejected
    expect(spy).not.toHaveBeenCalled();      // nothing happened → map stays valid
  });

  it('DOES invalidate the holder after a successful screen-changing call', async () => {
    const def = projectToToolDefinition(keyTool());
    const holder = new UIMapHolder();
    const spy = vi.spyOn(holder, 'invalidate');
    const ctx = makeMockToolContext({ uiMaps: holder } as Partial<ToolContext>);
    const r = await def.handler({ combo: 'a' }, ctx);
    expect(r.isError).toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});
