/**
 * Types of the projected tools (tools.ts), which src/tools/registry.ts projects onto the MCP surface.
 */

import type { PlatformAdapter } from '../../platform/types';
import type { CDPDriver } from '../../platform/cdp-driver';

/** Environment the projected tools see at runtime (project-mcp.ts toolContextToAgent builds it, per call). */
export interface AgentToolContext {
  platform: PlatformAdapter;
  /** Screen size, for coordinate math and the coordinate breadcrumb in results. */
  screen: { logicalWidth: number; logicalHeight: number; physicalWidth: number; physicalHeight: number; dpiRatio: number };
  /** Optional CDP driver — when present, the browser_* tools drive the
   *  browser via the DOM (selectors, not pixels). Null when the daemon didn't wire CDP. */
  cdp?: CDPDriver | null;
  /** Session-scoped UIMap cache for safe el_NN element refs. */
  uiMaps?: import('../../core/sense/ui-map-holder').UIMapHolder;
  /** Test-only platform override consumed by imageScale() (defaults to
   *  process.platform in production). Lets coordinate-scaling tests pin the
   *  OS branch deterministically instead of depending on the CI runner's OS. */
  _platform?: string;
  /** Image → mouse factor of the latest screenshot, when known (the MCP surface): imageScale() uses it as is. */
  imageToMouse?: number;
}

/** A projected tool: executes against PlatformAdapter; project-mcp.ts turns it into a ToolDefinition. */
export interface UnifiedTool {
  /** Tool name; TOOL_META.mcpName (tool-meta.ts) replaces it on the MCP surface where they differ. */
  name: string;
  /** Published as the MCP tool's description. */
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** True when this tool plausibly changes what's on screen. */
  changesScreen: boolean;
  execute: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<UnifiedToolResult>;
}

export interface UnifiedToolResult {
  success: boolean;
  text: string;
  /** Label of the target element, if known. */
  targetLabel?: string;
}
