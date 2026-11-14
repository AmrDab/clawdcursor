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
import { buildUnifiedTools } from './projected/tools';
import { projectToToolDefinition } from './projected/project-mcp';

// ─── Window management ───────────────────────────────────────────────────────

/** Names (in buildUnifiedTools()) of the window tools projected onto the MCP surface. */
const WINDOW_SYSB_NAMES = new Set([
  'list_windows',
  'focus_window',
  'maximize_window',
  'minimize_window',
  'restore_window',
  'close_window',
  'resize_window',
  'list_displays',
]);

let _projectedWindowCache: ToolDefinition[] | null = null;
function projectedWindowTools(): ToolDefinition[] {
  if (_projectedWindowCache === null) {
    const sysBTools = buildUnifiedTools();
    _projectedWindowCache = sysBTools
      .filter(t => WINDOW_SYSB_NAMES.has(t.name))
      .map(t => projectToToolDefinition(t));
  }
  return _projectedWindowCache;
}

// ─── Mouse ───────────────────────────────────────────────────────────────────
//
// click / drag / scroll take image-space coords (the latest screenshot's) when `space` is omitted, and
// mouse_move_relative scales dx/dy from image space: the tools do it themselves (projected/tools.ts).

/** Names (in buildUnifiedTools()) of the mouse tools projected onto the MCP surface. */
const MOUSE_SYSB_NAMES = new Set([
  'click',
  'drag',
  'scroll',
  'mouse_move_relative',
  'mouse_down',
  'mouse_up',
]);

let _projectedMouseCache: ToolDefinition[] | null = null;
function projectedMouseTools(): ToolDefinition[] {
  if (_projectedMouseCache !== null) return _projectedMouseCache;

  const sysBTools = buildUnifiedTools();
  _projectedMouseCache = sysBTools
    .filter(t => MOUSE_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedMouseCache;
}

// ─── Accessibility / perception ──────────────────────────────────────────────

/** Names (in buildUnifiedTools()) of the a11y / perception tools projected onto the MCP surface. */
const A11Y_SYSB_NAMES = new Set([
  'read_screen',
  'invoke_element',
  'set_field_value',
  'focus_element',
  'a11y_get_value',
  'a11y_expand',
  'a11y_collapse',
  'a11y_toggle',
  'a11y_select',
  'get_element_state',
  'wait_for_element',
  'verify',
  'compile_ui',
  'find_action_button',
  'find_input_field',
  // NOTE: no OCR tool is projected. The MCP surface's OCR is `ocr_read_screen` (ocr.ts): JSON (elements[] + bounds +
  // coordinateSystem) for scope:"screen", `@x,y "text"` rows with the centre of each text for scope:"window".
]);

let _projectedA11yCache: ToolDefinition[] | null = null;
function projectedA11yTools(): ToolDefinition[] {
  if (_projectedA11yCache !== null) return _projectedA11yCache;

  const sysBTools = buildUnifiedTools();
  _projectedA11yCache = sysBTools
    .filter(t => A11Y_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedA11yCache;
}

// ─── CDP / browser ───────────────────────────────────────────────────────────

/** Names (in buildUnifiedTools()) of the CDP / browser tools projected onto the MCP surface. */
const BROWSER_SYSB_NAMES = new Set([
  'browser_connect',
  'browser_read',
  'browser_click',
  'browser_type',
]);

let _projectedBrowserCache: ToolDefinition[] | null = null;
function projectedBrowserTools(): ToolDefinition[] {
  if (_projectedBrowserCache !== null) return _projectedBrowserCache;

  const sysBTools = buildUnifiedTools();
  _projectedBrowserCache = sysBTools
    .filter(t => BROWSER_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedBrowserCache;
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

/** Names (in buildUnifiedTools()) of the keyboard tools projected onto the MCP surface. */
const KEYBOARD_SYSB_NAMES = new Set(['type', 'key', 'key_down', 'key_up', 'undo_last']);

let _projectedKeyboardCache: ToolDefinition[] | null = null;
function projectedKeyboardTools(): ToolDefinition[] {
  if (_projectedKeyboardCache !== null) return _projectedKeyboardCache;

  const sysBTools = buildUnifiedTools();
  _projectedKeyboardCache = sysBTools
    .filter(t => KEYBOARD_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedKeyboardCache;
}

export type { ToolDefinition, ToolContext, ToolResult };
export { toJsonSchema };
export { getCompactTools };

// The granular tool definitions are static (built from module-level
// get*Tools() functions, no runtime registration), so assemble the array
// once and reuse it: getTool() is on the hot dispatch path.
let _granularCache: ToolDefinition[] | null = null;
function granularTools(): ToolDefinition[] {
  if (_granularCache === null) {
    const systemATools = [
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
    ];

    // The fence (CLAWD_FENCE_PIDS, core/fence.ts): with it set, every handler is gated here, once. The MCP surface, the
    // compound tools and the steps of a batch all run these handlers. Unset, the list is returned as it is.
    _granularCache = fenceTools([
      ...systemATools,
      ...projectedWindowTools(),
      ...projectedKeyboardTools(),
      ...projectedMouseTools(),
      ...projectedA11yTools(),
      ...projectedBrowserTools(),
    ]);
  }
  return _granularCache;
}

/** Forget the built tool lists, so the next call builds them again (the schema snapshot builds them once per OS). */
export function resetToolCaches(): void {
  _projectedWindowCache = _projectedMouseCache = _projectedA11yCache = _projectedBrowserCache = _projectedKeyboardCache = null;
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
