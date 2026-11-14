/**
 * Types of the agent-loop tools (tools.ts), which src/tools/registry.ts projects onto the MCP surface.
 */

import type { PlatformAdapter } from '../../platform/types';
import type { CDPDriver } from '../../platform/cdp-driver';

/** Environment the agent tools see at runtime (project-mcp.ts toolContextToAgent builds it). */
export interface AgentToolContext {
  platform: PlatformAdapter;
  /** Screen size — cached on first use; used for coordinate math in click/drag. */
  screen: { logicalWidth: number; logicalHeight: number; physicalWidth: number; physicalHeight: number; dpiRatio: number };
  /** Optional CDP driver — when present, the browser_* tools drive the
   *  browser via the DOM (selectors, not pixels). Null when the daemon didn't wire CDP. */
  cdp?: CDPDriver | null;
  /** Session-scoped UIMap cache for safe el_NN element refs (Part 2). */
  uiMaps?: import('../sense/ui-map-holder').UIMapHolder;
  /** Test-only platform override consumed by imageScale() (defaults to
   *  process.platform in production). Lets coordinate-scaling tests pin the
   *  OS branch deterministically instead of depending on the CI runner's OS. */
  _platform?: string;
  /** Image → mouse factor of the latest screenshot, when known (the MCP surface): imageScale() uses it as is. */
  imageToMouse?: number;
}

/**
 * A unified tool — executable against PlatformAdapter,
 * LLM-visible. One source of truth for the full toolbox.
 */
export interface UnifiedTool {
  /** Tool name as exposed to the LLM. */
  name: string;
  /** Description the LLM sees. Kept under ~140 chars for token budget. */
  description: string;
  /** JSON-Schema for the tool's args. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** True when this tool plausibly changes what's on screen. */
  changesScreen: boolean;
  /** Execute the tool. */
  execute: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<UnifiedToolResult>;
}

export interface UnifiedToolResult {
  success: boolean;
  text: string;
  /** Label of the target element, if known. */
  targetLabel?: string;
}
