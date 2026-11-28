/**
 * Tool Registry — central registry of all clawdcursor tools.
 *
 * Import this to get every tool in a transport-agnostic format.
 * Adapters (HTTP, MCP) consume this registry.
 */

import { getDesktopTools } from './desktop';
import { getA11yTools } from './a11y';
import { getCdpTools } from './cdp';
import { getOrchestrationTools } from './orchestration';
import { getBatchTools } from './batch';
import { getShortcutTools } from './shortcuts';
import { getOcrTools } from './ocr';
import { getSmartTools } from './smart';
import { getExtraTools } from './extras';
import { getA11yDepthTools } from './a11y_depth';
import { getElectronBridgeTools } from './electron_bridge';
import { getCompactTools } from './compact';
import { getAgentTools } from './agent';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { toJsonSchema } from './types';
import { stampCostClasses } from './cost-class';
import { fenceTools } from '../core/fence';
import { getCoreTools } from './core-tools';

export type { ToolDefinition, ToolContext, ToolResult };
export { toJsonSchema };
export { getCompactTools };

// The granular tool definitions are static (built from module-level
// get*Tools() functions, no runtime registration), so assemble the array
// once and reuse it: getTool() is on the hot dispatch path.
let _granularCache: ToolDefinition[] | null = null;
function granularTools(): ToolDefinition[] {
  if (_granularCache === null) {
    const tools = [
      ...getDesktopTools(),
      ...getA11yTools(),
      ...getCdpTools(),
      ...getOrchestrationTools(),
      ...getBatchTools(),
      ...getShortcutTools(),
      ...getOcrTools(),
      ...getSmartTools(),
      ...getExtraTools(),
      ...getA11yDepthTools(),
      ...getElectronBridgeTools(),
      ...getAgentTools(),
      ...getCoreTools(),
    ];

    // The fence (CLAWD_FENCE_PIDS, core/fence.ts): with it set, every handler is gated here, once. The MCP surface, the
    // compound tools and the steps of a batch all run these handlers. Unset, the list is returned as it is.
    _granularCache = fenceTools(tools);
  }
  return _granularCache;
}

/** Forget the built tool lists, so the next call builds them again (the schema snapshot builds them once per OS). */
export function resetToolCaches(): void {
  _granularCache = null;
}

/** Every granular tool (the full primitive surface), with its cost class stamped from cost-class.ts. A copy: callers can't mutate the cache. */
export function getTools(): ToolDefinition[] {
  const all = granularTools();
  stampCostClasses(all);
  return all.slice();
}

/** The same as getTools(). */
export function getAllTools(): ToolDefinition[] {
  return getTools();
}

/**
 * The COMPACT surface: compound tools covering the granular primitives, with far fewer catalog tokens
 * (`clawdcursor mcp --compact`, `clawdcursor start --compact`).
 */
export function getCompactSurface(): ToolDefinition[] {
  return getCompactTools();
}

export function getTool(name: string): ToolDefinition | undefined {
  return granularTools().find(t => t.name === name);
}
