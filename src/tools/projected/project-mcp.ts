/**
 * project-mcp.ts — turn the projected UnifiedTools (tools.ts) into ToolDefinitions for the MCP surface.
 * src/tools/registry.ts projects them through projectToToolDefinition.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import type { ToolDefinition, ToolContext, ToolResult, ParameterDef } from '../types';
import { TOOL_META } from './tool-meta';
import { expectRefusal, checkExpect } from '../../core/sense/reactive-check';
import { getSmartTools } from '../smart';
import { quoteScreenText } from '../../core/untrusted-screen-content';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a UnifiedTool JSON-Schema inputSchema into the
 * Record<string, ParameterDef> shape that ToolDefinition.parameters expects.
 *
 * Supported JSON Schema property types: "string" | "number" | "boolean" | "array".
 * Properties missing a supported type default to "string".
 * The `required` array in the schema is used to set ParameterDef.required.
 * `enum` is preserved when all values are strings.
 *
 * Description resolution order (per parameter):
 *   1. The inputSchema property's own description (if non-empty).
 *   2. `paramDescriptions[key]` (TOOL_META, passed as the optional second argument).
 *   3. Empty string fallback.
 *
 * @param inputSchema - The raw JSON Schema object from UnifiedTool.inputSchema.
 * @param paramDescriptions - Optional per-parameter fallback descriptions
 *   (TOOL_META[name].paramDescriptions).
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
    const type: 'string' | 'number' | 'boolean' | 'array' =
      rawType === 'number' || rawType === 'boolean' || rawType === 'array' ? rawType : 'string';
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
 * before the tool's execute() accesses ctx.platform.*.
 *
 * @param ctx - The ToolContext injected by the MCP server.
 * @returns A fully populated AgentToolContext for the tool's execute().
 */
export async function toolContextToAgent(ctx: ToolContext): Promise<AgentToolContext> {
  await ctx.ensureInitialized();

  // ToolContext.platform is optional (tests build contexts without it).
  const platform = ctx.platform;
  if (!platform) {
    throw new Error(
      'toolContextToAgent: ctx.platform is not initialized. ' +
      'Ensure clawdcursor is running with a supported OS adapter.',
    );
  }

  let screen: AgentToolContext['screen'];
  // The scale the src/tools/*.ts tools click with: the latest screenshot's, whatever its max_edge.
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
 * Live 2026-11-17 (Siemens Designcenter): its ribbon buttons are not in the UIA tree, `invoke "Circle"` missed, and the agent
 * clicked x,y off a screenshot instead of following the hint. So the tool takes the cheaper route itself: an invoke BY NAME
 * that found no element of that name presses the visible label with smart_click (OCR, no image), guards and all. Not for an
 * ambiguous miss, a `within` (OCR cannot honour it), an element_id, or a verb other than click.
 */
async function pressVisibleLabel(params: Record<string, unknown>, miss: UnifiedToolResult, ctx: ToolContext): Promise<UnifiedToolResult> {
  const name = typeof params.name === 'string' ? params.name : '';
  const within = typeof params.within === 'string' && params.within.trim();
  if (miss.success || !name.trim() || within || params.element_id || params.snapshot_id) return miss;
  if (params.action !== undefined && params.action !== 'click') return miss;
  if (!/\binvoke\b[^\n]{0,80}missed — element not found/i.test(miss.text)) return miss;
  const smart = getSmartTools().find(t => t.name === 'smart_click');
  if (!smart) return miss;
  const r = await smart.handler({ target: name, ...(typeof params.processId === 'number' ? { processId: params.processId } : {}) }, ctx);
  if (!r.isError) {
    return { success: true, targetLabel: miss.targetLabel,
      text: `No element named ${quoteScreenText(name)} in the accessibility tree; pressed its visible label instead (OCR, no screenshot): ${r.text}` };
  }
  // smart_click's failure is a JSON payload; only a plain "no match" says the label is not on screen (not a locked screen or a timeout).
  let error: unknown;
  try { error = (JSON.parse(r.text) as { error?: unknown }).error; } catch { /* not JSON: keep the miss as it was */ }
  return error === 'no_clickable_target' ? { ...miss, text: `${miss.text} Its visible label was not found on screen either.` } : miss;
}

/**
 * Convert a UnifiedToolResult to the ToolResult shape the MCP surface expects.
 *
 * - success=false maps to isError=true.
 * - targetLabel is not forwarded.
 *
 * @param r - The UnifiedToolResult from a projected tool's execute() call.
 * @returns A ToolResult ready for the MCP transport.
 */
export function unifiedToToolResult(r: UnifiedToolResult): ToolResult {
  return {
    text: r.text,
    isError: !r.success,
  };
}

/**
 * Project a UnifiedTool into a ToolDefinition: name from TOOL_META[t.name].mcpName ?? t.name, category / tiers
 * from TOOL_META (the cost class is stamped later, from tools/cost-class.ts).
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
      'Add an entry to src/tools/projected/tool-meta.ts.',
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
    if (t.name === 'invoke_element') result = await pressVisibleLabel(params, result, ctx);
    const executed = result.success;
    const checked = await checkExpect(params.expect, result, agentCtx.platform);
    if (checked) result = { ...result, ...checked };
    // Invalidate the shared UIMap holder only when the screen-changing action
    // actually TOOK (pre-expect outcome — a DEVIATION still means the input
    // was dispatched). A rejected el_NN ref / failed dispatch changed nothing
    // and must not stale a still-valid map.
    // A typed-but-not-submitted result (read-back held Return) did change the field.
    const typedNotSubmitted = !executed && /^Typed \d+ chars /.test(result.text) && / — Return not pressed\./.test(result.text);
    if (t.changesScreen && (executed || typedNotSubmitted)) ctx.uiMaps?.invalidate();
    return unifiedToToolResult(result);
  };

  return {
    name,
    description: t.description,
    parameters,
    category: meta.category,
    safetyTier: meta.safetyTier,
    destructive: meta.destructive,
    honorsExpect: true,
    handler,
  };
}
