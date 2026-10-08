/**
 * project-mcp.ts — Project System B (agent-loop) UnifiedTools onto the
 * System A (MCP/REST) ToolDefinition surface.
 *
 * PURELY ADDITIVE. This module is not yet imported by any production path.
 * Wire-in happens in a later step (Step 3).
 *
 * The three public exports:
 *
 *   jsonSchemaToParamDefs(inputSchema)
 *     Convert a UnifiedTool.inputSchema (raw JSON Schema object) into the
 *     Record<string, ParameterDef> shape ToolDefinition expects.
 *
 *   toolContextToAgent(ctx)
 *     Build a synthetic AgentToolContext from a ToolContext so a projected
 *     handler can call the System B execute() function.
 *
 *   unifiedToToolResult(r)
 *     Map a UnifiedToolResult back to the ToolResult shape the MCP surface
 *     expects, including base64-encoding any screenshot.
 *
 *   projectToToolDefinition(t)
 *     Assemble a complete ToolDefinition from a UnifiedTool + TOOL_META.
 *     The handler bridges ToolContext → AgentToolContext → UnifiedToolResult →
 *     ToolResult in a single async call.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import type { ToolDefinition, ToolContext, ToolResult, ParameterDef } from '../../tools/types';
import { TOOL_META } from './tool-meta';
import { reactiveCheck } from '../sense/reactive-check';
import { validateExpect } from '../verify/assertions';
import { OcrEngine } from '../../platform/ocr-engine';
import { rewriteOutsideData } from '../../tools/hint-rewrite';

// Lazy OCR singleton for ocr_contains assertions in MCP-route expect checks.
let _mcpOcr: OcrEngine | null = null;
function mcpOcr(): OcrEngine { return (_mcpOcr ??= new OcrEngine()); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rewrite System B tool names in free text (descriptions, "call X first"
 * hints) to their MCP names, so a projected tool never points the caller at
 * a name that only exists inside the agent loop (`browser_navigate` →
 * `navigate_browser`). Only renamed multi-word names are touched — `click`,
 * `type`, `key` are plain English and stay as-is.
 */
let _renames: Array<[RegExp, string]> | null = null;
export function toMcpNames(text: string): string {
  if (!_renames) {
    _renames = Object.entries(TOOL_META)
      .filter(([name, meta]) => meta.mcpName && meta.mcpName !== name && name.includes('_'))
      .sort(([a], [b]) => b.length - a.length)
      .map(([name, meta]) => [new RegExp(`\\b${name}\\b`, 'g'), meta.mcpName!]);
  }
  for (const [re, mcpName] of _renames) text = text.replace(re, mcpName);
  return text;
}

/**
 * Convert a UnifiedTool JSON-Schema inputSchema into the
 * Record<string, ParameterDef> shape that ToolDefinition.parameters expects.
 *
 * Supported JSON Schema property types: "string" | "number" | "boolean" | "array".
 * Properties missing a supported type default to "string" with a note.
 * The `required` array in the schema is used to set ParameterDef.required.
 * `enum` is preserved when all values are strings.
 *
 * Description resolution order (per parameter):
 *   1. System B inputSchema property's own description (if non-empty).
 *   2. `paramDescriptions[key]` harvested from the corresponding System A
 *      ToolDefinition (passed as the optional second argument).
 *   3. Empty string fallback.
 *
 * @param inputSchema - The raw JSON Schema object from UnifiedTool.inputSchema.
 * @param paramDescriptions - Optional per-parameter fallback descriptions
 *   harvested from the System A ToolDefinition (TOOL_META[name].paramDescriptions).
 * @returns A Record mapping parameter names to ParameterDef instances.
 */
export function jsonSchemaToParamDefs(
  inputSchema: UnifiedTool['inputSchema'],
  paramDescriptions?: Record<string, string>,
): Record<string, ParameterDef> {
  const result: Record<string, ParameterDef> = {};
  const props = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);

  for (const [key, raw] of Object.entries(props)) {
    const prop = raw as Record<string, unknown>;
    const rawType = typeof prop.type === 'string' ? prop.type : 'string';
    // Narrow to ParameterDef's allowed types; fall back to 'string'.
    const type: 'string' | 'number' | 'boolean' | 'array' =
      rawType === 'number' || rawType === 'boolean' || rawType === 'array' ? rawType : 'string';
    // Prefer System B's own description; fall back to harvested System A description.
    const ownDescription = typeof prop.description === 'string' ? prop.description : '';
    const description = ownDescription || paramDescriptions?.[key] || '';
    const def: ParameterDef = {
      type,
      description,
      required: required.has(key),
    };
    // Preserve the element schema for array params (ParameterDef.items),
    // e.g. verify's `assertions: {type:'array', items:{type:'object'}}`.
    if (type === 'array' && prop.items && typeof prop.items === 'object') {
      def.items = prop.items as Record<string, unknown>;
    }
    // Preserve enum when all values are strings (ParameterDef only supports string enum).
    if (Array.isArray(prop.enum)) {
      const strEnum = (prop.enum as unknown[]).filter(v => typeof v === 'string') as string[];
      if (strEnum.length > 0) def.enum = strEnum;
    }
    // Preserve numeric constraints.
    if (typeof prop.minimum === 'number') def.minimum = prop.minimum;
    if (typeof prop.maximum === 'number') def.maximum = prop.maximum;

    result[key] = def;
  }

  return result;
}

/**
 * Build a synthetic AgentToolContext from a ToolContext.
 *
 * Called once per projected handler invocation. Awaits
 * ctx.ensureInitialized() first to guarantee subsystems are ready
 * before the System B tool execute() accesses ctx.platform.*.
 *
 * Fields that are absent from ToolContext (task, mode, screenshotsCaptured)
 * are given safe neutral defaults so the System B tools don't crash.
 *
 * @param ctx - The ToolContext injected by the MCP server / REST handler.
 * @returns A fully populated AgentToolContext ready for System B tool execute().
 */
export async function toolContextToAgent(ctx: ToolContext): Promise<AgentToolContext> {
  // Guarantee all subsystems are initialized (lazy init gate).
  await ctx.ensureInitialized();

  // Derive the platform adapter. The `platform` field was added in Tranche 1A
  // and is present on every modern ToolContext. Guard defensively for tests.
  const platform = ctx.platform;
  if (!platform) {
    throw new Error(
      'toolContextToAgent: ctx.platform is not initialized. ' +
      'Ensure clawdcursor is running with a supported OS adapter.',
    );
  }

  // Derive screen dimensions. System B tools use ctx.screen for coordinate math.
  // ToolContext exposes getScreenSize() on ctx.desktop (NativeDesktop).
  let screen: AgentToolContext['screen'];
  try {
    const size = ctx.desktop.getScreenSize() as { width: number; height: number };
    const msf = ctx.getMouseScaleFactor();   // image → logical (mouse) scale
    const ssf = ctx.getScreenshotScaleFactor(); // image → physical pixel scale
    // msf ≈ physicalWidth / imageWidth (typically 1 on standard, 2 on HiDPI).
    // We reconstruct logical and physical from physical size + ratio.
    const physicalWidth = size.width;
    const physicalHeight = size.height;
    // Logical = physical / DPI ratio. DPI ratio = physical / logical = ssf / msf.
    // For the typical case both scale factors are 1, leaving logical == physical.
    const dpiRatio = ssf > 0 ? ssf / msf : 1;
    const logicalWidth = dpiRatio > 0 ? Math.round(physicalWidth / dpiRatio) : physicalWidth;
    const logicalHeight = dpiRatio > 0 ? Math.round(physicalHeight / dpiRatio) : physicalHeight;
    screen = { logicalWidth, logicalHeight, physicalWidth, physicalHeight, dpiRatio };
  } catch {
    // Fallback to a sane default if getScreenSize throws (e.g. in tests).
    screen = { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 };
  }

  return {
    platform,
    task: '',           // No task context available in the MCP surface layer.
    screen,
    screenshotsCaptured: { n: 0 },
    mcpSurface: true,
    cdp: ctx.cdp ?? null,
    targetWindow: undefined,
    activeApp: undefined,
    uiMaps: ctx.uiMaps,
  };
}

/**
 * Convert a UnifiedToolResult to the ToolResult shape the MCP surface expects.
 *
 * - success=false maps to isError=true.
 * - screenshot (ScreenshotResult with a Buffer) is base64-encoded and returned
 *   as { data, mimeType } in the image field — mirroring how the agent loop
 *   and the existing MCP server serialize images.
 * - All other UnifiedToolResult fields (stop, terminalExit, targetLabel) are
 *   consumed internally and not forwarded — they are agent-loop concerns.
 *
 * @param r - The UnifiedToolResult from a System B tool execute() call.
 * @returns A ToolResult ready for the MCP / REST transport.
 */
export function unifiedToToolResult(r: UnifiedToolResult): ToolResult {
  const result: ToolResult = {
    text: r.text,
    isError: !r.success,
  };

  if (r.screenshot) {
    // ScreenshotResult.buffer is a Buffer containing raw image bytes (PNG per
    // the platform/types.ts interface; the agent loop captures via screenshot()
    // which returns PNG). The MCP image field expects base64-encoded string data.
    result.image = {
      data: r.screenshot.buffer.toString('base64'),
      mimeType: 'image/png',
    };
  }

  return result;
}

/**
 * Project a System B UnifiedTool into a System A ToolDefinition.
 *
 * Assembles:
 *   - name: TOOL_META[t.name].mcpName ?? t.name
 *   - description: t.description (System B already has good descriptions)
 *   - parameters: via jsonSchemaToParamDefs(t.inputSchema)
 *   - category, compactGroup, safetyTier, costClass, cheaperAlternatives: from TOOL_META
 *   - handler: bridges ToolContext → AgentToolContext → t.execute() → ToolResult
 *
 * Terminal actions (done, give_up, cannot_read) and vision compound tools
 * (mouse, keyboard, window) should NOT be passed to this function — they have
 * no counterpart on the MCP surface or have their own projection path.
 *
 * Throws if t.name has no TOOL_META entry (enforced by the coverage test).
 *
 * @param t - A UnifiedTool from buildUnifiedTools().
 * @returns A fully populated ToolDefinition ready for getTools() or direct MCP use.
 */
export function projectToToolDefinition(t: UnifiedTool): ToolDefinition {
  const meta = TOOL_META[t.name];
  if (!meta) {
    throw new Error(
      `projectToToolDefinition: no TOOL_META entry for System B tool "${t.name}". ` +
      'Add an entry to src/core/agent-loop/tool-meta.ts.',
    );
  }

  const name = meta.mcpName ?? t.name;
  const parameters = jsonSchemaToParamDefs(t.inputSchema, meta.paramDescriptions);

  const handler = async (
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    // Validate `expect` BEFORE acting: a malformed one must not cost a click
    // (the agent would retry and double-act — live regression 2026-10).
    const expectError = validateExpect(params.expect);
    if (expectError) return { text: `expect rejected (nothing executed): ${expectError}`, isError: true };
    const agentCtx = await toolContextToAgent(ctx);
    let result = await t.execute(params, agentCtx);
    const executed = result.success;
    // Honor a caller-supplied `expect` assertion array. The projected schemas
    // advertise it (same as the agent loop), so an external agent passing
    // post-conditions over MCP must get them VERIFIED — they were silently
    // dropped before (audit 2026-06-10, finding E). Hard check only: the
    // loop-side soft "no observable change" net needs per-turn fingerprints
    // the MCP route doesn't track.
    if (params.expect !== undefined && params.expect !== null) {
      const reactive = await reactiveCheck({
        expect: params.expect,
        toolText: result.text,
        toolSuccess: result.success,
        changesScreen: false,
        observedChange: true,
        adapter: agentCtx.platform,
        ocrText: async () => (await mcpOcr().recognizeScreen()).fullText ?? '',
      }).catch(() => null);
      if (reactive) result = { ...result, success: reactive.success, text: reactive.text };
    }
    // Invalidate the shared UIMap holder only when the screen-changing action
    // actually TOOK (pre-expect outcome — a DEVIATION still means the input
    // was dispatched). A rejected el_NN ref / failed dispatch changed nothing
    // and must not stale a still-valid map (parity with the agent loop's
    // outcome-gated invalidation; audit finding E/A1).
    if (t.changesScreen && executed) ctx.uiMaps?.invalidate();
    const out = unifiedToToolResult(result);
    out.text = rewriteOutsideData(out.text, toMcpNames);
    return out;
  };

  return {
    name,
    description: toMcpNames(t.description),
    parameters,
    category: meta.category,
    compactGroup: meta.compactGroup,
    safetyTier: meta.safetyTier,
    costClass: meta.costClass,
    cheaperAlternatives: meta.cheaperAlternatives,
    handler,
  };
}
