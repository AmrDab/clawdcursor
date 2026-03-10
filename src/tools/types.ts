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
export interface ParameterDef {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: any;
}

/** Result returned by a tool handler */
export interface ToolResult {
  /** Text output */
  text: string;
  /** Optional image (base64 encoded) */
  image?: { data: string; mimeType: string };
  /** Whether this result represents an error */
  isError?: boolean;
}

/** Shared context passed to tool handlers — initialized subsystems */
export interface ToolContext {
  /** NativeDesktop — mouse, keyboard, screenshot control */
  desktop: any;
  /** AccessibilityBridge — UI automation, windows, clipboard */
  a11y: any;
  /** CDPDriver — browser DOM interaction via Chrome DevTools Protocol */
  cdp: any;
  /** Image-space → logical (mouse) coords. mouseCoord = imageCoord * factor */
  getMouseScaleFactor: () => number;
  /** Image-space → physical pixel coords (for screenshot region crop) */
  getScreenshotScaleFactor: () => number;
  /** Ensure subsystems are initialized (lazy init gate) */
  ensureInitialized: () => Promise<void>;
}

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

/** Convert a11y/physical pixel coordinate to logical (mouse) coordinate */
export function a11yToMouse(physicalCoord: number, ctx: ToolContext): number {
  const dpiRatio = ctx.getScreenshotScaleFactor() / ctx.getMouseScaleFactor();
  return Math.round(physicalCoord / dpiRatio);
}
