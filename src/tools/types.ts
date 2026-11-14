/**
 * Transport-agnostic tool definitions.
 *
 * Tools are defined once here and adapted to:
 * - HTTP REST API (GET /tools, POST /execute/:name)
 * - MCP protocol (stdio or SSE)
 * - OpenAI function-calling format (GET /tools?format=openai)
 *
 * No MCP, no Zod, no framework dependency — just plain TypeScript.
 */

/** Parameter definition for a tool (maps to JSON Schema) */
import { mapImagePoint, mapImageLength, getLastFrame } from '../core/agent-loop/coord-scale';

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: any;
  /** For type:'array' — the JSON Schema each element must match. */
  items?: Record<string, any>;
  /** For type:'object' — the JSON Schema of each field. */
  properties?: Record<string, any>;
}

/** Result returned by a tool handler */
export interface ToolResult {
  /** Text output */
  text: string;
  /** Optional image (base64 encoded) */
  image?: { data: string; mimeType: string };
  /** Whether this result represents an error */
  isError?: boolean;
  /** batch only: each step that ran (or was stopped), for the session log — never shown to the model. */
  steps?: Array<{ tool: string; action?: string; status: string; text: string; pressedKeys?: boolean;
    /** What this step acted on, verified when it was sent (control.ts actRecord). */
    app?: string; appPid?: number; appHandle?: number }>;
  /** A read that had to send keystrokes to the app (copy_all_text's last resort): the session log records it as an action. */
  pressedKeys?: boolean;
}

/** Shared context passed to tool handlers — initialized subsystems */
export interface ToolContext {
  /** NativeDesktop — mouse, keyboard, screenshot control */
  desktop: any;
  /** AccessibilityBridge — UI automation, windows, clipboard */
  a11y: any;
  /** CDPDriver — browser DOM interaction via Chrome DevTools Protocol */
  cdp: any;
  /**
   * PlatformAdapter — OS-agnostic primitives added in Tranche 1A
   * (mouseDown/Up, keyDown/Up, setWindowState, setWindowBounds,
   * listDisplays, waitForElement, widened invokeElement).
   * Lazy-loaded via `ensureInitialized` so tool handlers don't need
   * async dance on every call.
   */
  platform?: import('../platform/types').PlatformAdapter;
  /**
   * Optional log buffer accessor — populated by the daemon's createServer.
   * MCP `logs_recent` reads through this; null/missing means logs are not
   * captured (e.g. stdio MCP).
   */
  getLogBuffer?: () => Array<{ timestamp: number; level: string; message: string }>;
  /** Session-scoped UIMap cache for safe el_NN element refs (Part 2). */
  uiMaps?: import('../core/sense/ui-map-holder').UIMapHolder;
  /** High-security mode (--no-vision / CLAWD_DISABLE_VISION / config disableVision): no image goes to the model. */
  disableVision?: boolean;
  /** Image-space → logical (mouse) coords. mouseCoord = imageCoord * factor */
  getMouseScaleFactor: () => number;
  /** Image-space → physical pixel coords (for screenshot region crop) */
  getScreenshotScaleFactor: () => number;
  /** Ensure subsystems are initialized (lazy init gate) */
  ensureInitialized: () => Promise<void>;
}

/** The 6 compact compound tool names */
export type CompactGroup = 'computer' | 'accessibility' | 'window' | 'system' | 'browser';

/**
 * What kind of evidence a tool produces and how token-expensive its
 * response typically is for the calling LLM. Distinct from `safetyTier`
 * (which answers "is this destructive?") — `costClass` answers "how
 * much will I pay in tokens when this returns?".
 *
 * Cheaper-first ordering: `act` < `inspect` < `perceive-text` < `perceive-image`.
 *
 *   act              — side-effect verb; caller already knows what + where.
 *                      Response typically ≤200 tokens (a status line).
 *                      Examples: mouse_click, key_press, type_text, mouse_drag.
 *
 *   inspect          — cheap structured read. Response ≤2K tokens.
 *                      Examples: get_active_window, get_windows, find_element,
 *                      cdp_list_tabs.
 *
 *   perceive-text    — a11y tree, OCR, or DOM dump. Response ≤10K tokens.
 *                      Examples: read_screen, ocr_read_screen, cdp_page_context,
 *                      smart_click (internally OCR+a11y), smart_type.
 *
 *   perceive-image   — screenshot with image bytes. Response ≤50K tokens
 *                      including base64 image data; vision LLMs pay extra.
 *                      Examples: desktop_screenshot, desktop_screenshot_region.
 *
 * Compound dispatcher tools (`computer`, `accessibility`, `window`, `system`,
 * `browser`, `task`) leave this `undefined` — their cost depends on which
 * delegate the `action` parameter routes to.
 */
export type ToolCostClass = 'act' | 'inspect' | 'perceive-text' | 'perceive-image';

/** A single tool definition — transport agnostic */
export interface ToolDefinition {
  /** Unique tool name (e.g. "mouse_click", "read_screen") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Parameter schema — empty object for no-param tools */
  parameters: Record<string, ParameterDef>;
  /** Tool category for organization */
  category: 'perception' | 'mouse' | 'keyboard' | 'window' | 'clipboard' | 'browser' | 'orchestration';
  /**
   * The compact compound this granular tool belongs to.
   * Derived by reverse-engineering the ACTION_MAP in compact.ts.
   * Undefined for granular tools that are not exposed via any compound
   * (e.g. smart_read, smart_click, smart_type, minimize_window).
   */
  compactGroup?: CompactGroup;
  /**
   * Does the tool only read (0), or does it send input / change something (1)? Not a permission: clawdcursor refuses
   * nothing by tier. It drives the pill's "touching your screen" state and the MCP readOnlyHint.
   */
  safetyTier?: 0 | 1;
  /**
   * `true` on a tool that is destructive by itself: it closes a window, overwrites the clipboard, opens a file or URI
   * (which can run a program), runs page script, restarts an app or sends a report. Announced as MCP destructiveHint.
   * Ordinary input (click, type, key, scroll) is not marked: what it does depends on where the agent points it.
   */
  destructive?: boolean;
  /**
   * MCP tool annotations — hints for clients and directories about what the tool does to the world. When omitted the
   * MCP server derives readOnlyHint / destructiveHint from `safetyTier` and `destructive` (toolAnnotations).
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /**
   * Token-cost class — what kind of evidence this tool returns and how
   * expensive its response is for the calling LLM. See `ToolCostClass`.
   * `tools/list` exposes this so a tool-picking LLM can prefer cheaper
   * alternatives first (e.g. `find_element` before `read_screen` before
   * `desktop_screenshot`).
   *
   * Optional during the rollout. The coverage test in
   * `src/__tests__/cost-class-coverage.test.ts` warns on missing values
   * and will flip to required in a future minor.
   */
  costClass?: ToolCostClass;
  /**
   * Other tools the caller should try BEFORE this one when they apply
   * to the same job at a lower cost class. Names must reference real
   * tools — validated at module load.
   *
   * Example: `read_screen.cheaperAlternatives = ['find_element']`.
   */
  cheaperAlternatives?: string[];
  /** The handler checks an `expect` argument (projected agent-loop tools do). Others would silently ignore one. */
  honorsExpect?: boolean;
  /** The handler function */
  handler: (params: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;
}

// ── Schema Conversion Helpers ──

/** Convert tool parameters to JSON Schema (for REST API /tools endpoint) */
export function toJsonSchema(params: Record<string, ParameterDef>): object {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(params)) {
    const prop: any = { type: def.type, description: def.description };
    if (def.enum) prop.enum = def.enum;
    if (def.minimum !== undefined) prop.minimum = def.minimum;
    if (def.maximum !== undefined) prop.maximum = def.maximum;
    if (def.default !== undefined) prop.default = def.default;
    if (def.items !== undefined) prop.items = def.items;
    if (def.properties !== undefined) prop.properties = def.properties;
    properties[key] = prop;
    if (def.required !== false) required.push(key);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/** Convert tools to OpenAI function-calling format */
export function toOpenAiFunctions(tools: ToolDefinition[]): object[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters),
    },
  }));
}

/** Image-space (the latest screenshot) → mouse-space; `space:"screen"` passes
 *  through. Goes through the last frame, so a screenshot of ANY monitor (any
 *  position, any DPI) maps back onto that monitor. */
export function toMouse(ctx: ToolContext, x: number, y: number, space?: unknown): { x: number; y: number } {
  if (space === 'screen') return { x: Math.round(x), y: Math.round(y) };
  return mapImagePoint(x, y, ctx.getMouseScaleFactor());
}

/**
 * Physical pixels per `space:"screen"` unit. "screen" is the space toMouse passes through — what accessibility positions
 * and clicks use: POINTS on macOS (2 px each on Retina), physical pixels on Windows and Linux (1, every monitor, any DPI).
 * Captures take physical pixels, so a screen-space region is multiplied by this before it is captured.
 */
export function screenToPhysical(ctx: ToolContext): number {
  const mouse = ctx.getMouseScaleFactor();
  const physical = ctx.getScreenshotScaleFactor();
  return mouse > 0 && physical > 0 ? physical / mouse : 1;
}

/** Image-space LENGTH (relative move, window size) → mouse-space length — scale only, no origin. */
export function toMouseLength(ctx: ToolContext, v: number): number {
  return mapImageLength(v, ctx.getMouseScaleFactor());
}

/** Inverse of toMouse for image space (e.g. reporting the cursor). */
export function toImage(ctx: ToolContext, x: number, y: number): { x: number; y: number } {
  const f = getLastFrame();
  const s = f ? f.scale : (ctx.getMouseScaleFactor() || 1);
  return { x: Math.round((x - (f?.originX ?? 0)) / s), y: Math.round((y - (f?.originY ?? 0)) / s) };
}
