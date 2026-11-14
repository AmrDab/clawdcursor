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

/**
 * The tools built in projected/tools.ts that the MCP surface carries, in groups. The group order is their order in
 * tools/list (the schema snapshot pins it); inside a group they keep buildUnifiedTools() order.
 *
 * Mouse: click / drag / scroll take image-space coords (the latest screenshot's) when `space` is omitted, and
 * mouse_move_relative scales dx/dy from image space: the tools do it themselves (projected/tools.ts).
 * No OCR tool is projected. The MCP surface's OCR is `ocr_read_screen` (ocr.ts): JSON (elements[] + bounds +
 * coordinateSystem) for scope:"screen", `@x,y "text"` rows with the centre of each text for scope:"window".
 */
const PROJECTED_GROUPS: readonly (readonly string[])[] = [
  // window
  ['list_windows', 'focus_window', 'maximize_window', 'minimize_window', 'restore_window', 'close_window', 'resize_window', 'list_displays'],
  // keyboard
  ['type', 'key', 'key_down', 'key_up', 'undo_last'],
  // mouse
  ['click', 'drag', 'scroll', 'mouse_move_relative', 'mouse_down', 'mouse_up'],
  // accessibility / perception
  ['read_screen', 'invoke_element', 'set_field_value', 'focus_element', 'a11y_get_value', 'a11y_expand', 'a11y_collapse',
    'a11y_toggle', 'a11y_select', 'get_element_state', 'wait_for_element', 'verify', 'compile_ui', 'find_action_button',
    'find_input_field'],
  // CDP / browser
  ['browser_connect', 'browser_read', 'browser_click', 'browser_type'],
];

function projectedTools(): ToolDefinition[] {
  const unified = buildUnifiedTools();
  return PROJECTED_GROUPS.flatMap(group => unified.filter(t => group.includes(t.name)).map(t => projectToToolDefinition(t)));
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
    const handWritten = [
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
      ...handWritten,
      ...projectedTools(),
    ]);
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
