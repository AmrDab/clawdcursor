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

export interface AgentInput {
  task: string;
  /** Hard cap on turns. Default 70. */
  maxTurns?: number;
  /** Cooperative cancel — polled every turn. */
  isAborted?: () => boolean;
  /**
   * Hard cancel — aborts the in-flight LLM fetch immediately. Without it,
   * an abort only takes effect at the next isAborted() checkpoint, i.e.
   * after the current (up to 45s) LLM call returns. Wired by Agent.abort()
   * so `clawdcursor stop` gets an acknowledgment instead of a hard kill.
   */
  abortSignal?: AbortSignal;
  /**
   * The window this subtask should run in (resolved by the caller — the
   * browser for a web subtask, a named open app, etc.). Injected as a
   * "WORKING WINDOW" anchor telling the agent to refocus it instead of
   * thrashing. The generic stay-in-window guidance applies even when
   * this is undefined.
   */
  targetWindow?: { title: string; processName: string };
}

export interface AgentStep {
  turn: number;
  /** Agent's short reasoning for this turn, if any. */
  thought?: string;
  /** Tool name the agent called (may be 'no-op' if no tool call parsed). */
  toolName: string;
  /** Parsed tool args. */
  toolArgs: Record<string, unknown>;
  /** Outcome text + success flag. */
  result: { success: boolean; text: string };
  /** Turn duration in ms. */
  durationMs: number;
  /** Whether the screen fingerprint changed after this turn. */
  fingerprintChanged: boolean;
}

export type AgentExit =
  | 'done'
  | 'give_up'
  | 'cannot_read'
  | 'aborted'
  | 'max_turns'
  | 'parse_error'
  | 'llm_error'
  | 'stagnation';

export interface AgentResult {
  /** True when the agent declared `done` AND exit was clean. */
  success: boolean;
  exit: AgentExit;
  /** Final human-readable outcome. */
  text: string;
  /** Every turn in order — trace is the primary observability surface. */
  steps: AgentStep[];
  /** Number of LLM calls. */
  llmCalls: number;
  /** Number of screenshots captured. */
  screenshotsCaptured: number;
  /** Total turn duration (wall time for the whole loop). */
  durationMs: number;
}

export interface AgentLlmConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  isAnthropic: boolean;
  maxTokens?: number;
}

/**
 * The LLM half of the agent's dependencies. Prefer text; fall back to vision
 * if text is absent (vision models handle tool_use without images too).
 * Pipeline injects this so the agent stays provider-agnostic.
 */
export interface AgentLlmDeps {
  text?: AgentLlmConfig;
  vision?: AgentLlmConfig;
}

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
  /** Terminal action exit reason — propagated to AgentResult. */
  terminalExit?: Extract<AgentExit, 'done' | 'give_up' | 'cannot_read'>;
  /** Label of the target element, if known — lets SafetyLayer elevate on sensitive labels. */
  targetLabel?: string;
}
