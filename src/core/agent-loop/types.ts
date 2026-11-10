/**
 * Unified-agent types.
 *
 * The thin agent loop drives the full toolbox (hybrid mode: a11y + screenshot)
 * without mode-switching or pipeline morph. A capable configured model
 * self-drives using the cheapest tool that works.
 *
 * All types here stay provider-agnostic.
 */

import type { PlatformAdapter, ScreenshotResult } from '../../platform/types';
import type { CDPDriver } from '../../platform/cdp-driver';

export type AgentExit =
  | 'done'
  | 'give_up'
  | 'cannot_read'
  | 'aborted'
  | 'max_turns'
  | 'parse_error'
  | 'llm_error'
  | 'stagnation';

/** Environment the agent tools see at runtime. Stays tiny by design. */
export interface AgentToolContext {
  platform: PlatformAdapter;
  task: string;
  /** Screen size — cached on first use; used for coordinate math in click/drag. */
  screen: { logicalWidth: number; logicalHeight: number; physicalWidth: number; physicalHeight: number; dpiRatio: number };
  /** Mutable counter the tools bump when they take screenshots. */
  screenshotsCaptured: { n: number };
  /** True when an EXTERNAL agent drives these tools over MCP (System A tools
   *  like copy_all_text / smart_click exist there; the internal loop has its own). */
  mcpSurface?: boolean;
  /** Current active app name — used by SafetyLayer for sensitive-app elevation. */
  activeApp?: string;
  /** The window this subtask should run in (the pipeline's resolved anchor).
   *  Pointer tools use it to RAISE the target before a click when the
   *  foreground drifted to a different process. */
  targetWindow?: { title: string; processName: string };
  /** Optional CDP driver — when present, the browser_* tools drive a
   *  dedicated, agent-owned browser instance via the DOM (selectors, not
   *  pixels). Null when the daemon didn't wire CDP. Tools degrade to OCR. */
  cdp?: CDPDriver | null;
  /** Session-scoped UIMap cache for safe el_NN element refs (Part 2). */
  uiMaps?: import('../sense/ui-map-holder').UIMapHolder;
  /** --no-vision: tools built from here (the batch's steps) leave out `screenshot`. */
  disableVision?: boolean;
  /** Test-only platform override consumed by imageScale() (defaults to
   *  process.platform in production). Lets coordinate-scaling tests pin the
   *  OS branch deterministically instead of depending on the CI runner's OS. */
  _platform?: string;
  /** Default coordinate space for raw click/drag/scroll when the call omits
   *  `space`. The loop sets this to 'image' on VISION turns (the model is
   *  reading coords off the screenshot), else 'screen'. Undefined → 'screen'. */
  coordSpaceDefault?: 'screen' | 'image';
  /** Epoch-ms timestamp of task start — feeds the `file_changed_since_start`
   *  assertion at done-time. */
  taskStartedAt?: number;
  /** True once any screen-CHANGING tool actually moved the screen this task.
   *  The `done` gate requires machine-checkable evidence when this is set. */
  mutatedScreen?: boolean;
  /** Cheap screen/window/clipboard snapshot captured at task start — lets the
   *  `done` gate reject evidence that was ALREADY true before the task acted. */
  taskBaseline?: import('../verify/assertions').TaskBaseline;
}

/**
 * A unified tool — executable against PlatformAdapter, safety-evaluable,
 * LLM-visible. One source of truth for the full toolbox.
 */
export interface UnifiedTool {
  /** Tool name as exposed to the LLM (matches the SafetyLayer TOOL_TIER map). */
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
  /** True when this tool is a terminal action (`done` / `give_up` / `cannot_read`). */
  terminal?: true;
  /** Execute the tool. Returns text + optional screenshot; never throws. */
  execute: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<UnifiedToolResult>;
}

export interface UnifiedToolResult {
  success: boolean;
  text: string;
  /** Freshly-captured screenshot, if the tool took one. */
  screenshot?: ScreenshotResult;
  /** Stop the agent loop after this tool runs. */
  stop?: boolean;
  /** Terminal action exit reason — for the caller. */
  terminalExit?: Extract<AgentExit, 'done' | 'give_up' | 'cannot_read'>;
  /** Label of the target element, if known — lets SafetyLayer elevate on sensitive labels. */
  targetLabel?: string;
}
