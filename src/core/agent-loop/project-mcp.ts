/**
 * project-mcp.ts — Project System B (agent-loop) UnifiedTools onto the
 * System A (MCP/REST) ToolDefinition surface.
 *
 * src/tools/registry.ts projects the agent-loop tools through it. The public exports:
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
 *     expects.
 *
 *   projectToToolDefinition(t)
 *     Assemble a complete ToolDefinition from a UnifiedTool + TOOL_META.
 *     The handler bridges ToolContext → AgentToolContext → UnifiedToolResult →
 *     ToolResult in a single async call.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import type { ToolDefinition, ToolContext, ToolResult, ParameterDef } from '../../tools/types';
import { TOOL_META, TEXT_ONLY_RENAMES } from './tool-meta';
import { expectRefusal, checkExpect } from '../sense/reactive-check';
import { rewriteOutsideData } from '../../tools/hint-rewrite';

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
    const pairs: Array<[string, string]> = [
      ...Object.entries(TOOL_META).flatMap(([name, meta]): Array<[string, string]> => (meta.mcpName ? [[name, meta.mcpName]] : [])),
      ...Object.entries(TEXT_ONLY_RENAMES),
    ];
    _renames = pairs
      .filter(([name, mcpName]) => mcpName !== name && name.includes('_'))
      .sort(([a], [b]) => b.length - a.length)
      .map(([name, mcpName]) => [new RegExp(`\\b${name}\\b`, 'g'), mcpName]);
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
  // The scale the System A tools click with: the latest screenshot's, whatever its max_edge.
  let imageToMouse: number | undefined;
  try {
    const size = ctx.desktop.getScreenSize() as { width: number; height: number };
    const msf = ctx.getMouseScaleFactor();   // image → logical (mouse) scale
    const ssf = ctx.getScreenshotScaleFactor(); // image → physical pixel scale
    imageToMouse = msf;
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
    screen,
    imageToMouse,
    cdp: ctx.cdp ?? null,
    uiMaps: ctx.uiMaps,
  };
}

/**
 * Convert a UnifiedToolResult to the ToolResult shape the MCP surface expects.
 *
 * - success=false maps to isError=true.
 * - targetLabel is not forwarded.
 *
 * @param r - The UnifiedToolResult from a System B tool execute() call.
 * @returns A ToolResult ready for the MCP / REST transport.
 */
export function unifiedToToolResult(r: UnifiedToolResult): ToolResult {
  return {
    text: r.text,
    isError: !r.success,
  };
}

/**
 * Project a System B UnifiedTool into a System A ToolDefinition.
 *
 * Assembles:
 *   - name: TOOL_META[t.name].mcpName ?? t.name
 *   - description: t.description (System B already has good descriptions)
 *   - parameters: via jsonSchemaToParamDefs(t.inputSchema)
 *   - category, compactGroup, safetyTier, destructive, costClass, cheaperAlternatives: from TOOL_META
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
    const refusal = expectRefusal(params.expect);
    if (refusal) return { text: refusal, isError: true };
    const agentCtx = await toolContextToAgent(ctx);
    let result = await t.execute(params, agentCtx);
    const executed = result.success;
    const checked = await checkExpect(params.expect, result, agentCtx.platform);
    if (checked) result = { ...result, ...checked };
    // Invalidate the shared UIMap holder only when the screen-changing action
    // actually TOOK (pre-expect outcome — a DEVIATION still means the input
    // was dispatched). A rejected el_NN ref / failed dispatch changed nothing
    // and must not stale a still-valid map (parity with the agent loop's
    // outcome-gated invalidation; audit finding E/A1).
    // A typed-but-not-submitted result (read-back held Return) did change the field.
    const typedNotSubmitted = !executed && /^Typed \d+ chars /.test(result.text) && / — Return not pressed\./.test(result.text);
    if (t.changesScreen && (executed || typedNotSubmitted)) ctx.uiMaps?.invalidate();
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
    destructive: meta.destructive,
    costClass: meta.costClass,
    cheaperAlternatives: meta.cheaperAlternatives,
    honorsExpect: true,
    handler,
  };
}
