/**
 * Tool Registry — central registry of all clawdcursor tools.
 *
 * Import this to get all 40 tools in a transport-agnostic format.
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

// ─── Step 3: Window-management re-projection ─────────────────────────────────
//
// These System A MCP names are now backed by System B (buildUnifiedTools)
// implementations; the System A copies are deleted.
//
// Tools WITHOUT a System B equivalent are left on the System A path:
//   • get_active_window  — no System B counterpart in buildUnifiedTools()
//   • get_screen_size    — no System B counterpart in buildUnifiedTools()
//
// System B tool name → projected MCP name (via TOOL_META.mcpName):
//   list_windows       → get_windows
//   focus_window       → focus_window
//   maximize_window    → maximize_window
//   minimize_window    → minimize_window_to_taskbar  (mcpName in TOOL_META)
//   restore_window     → restore_window
//   close_window       → close_window
//   resize_window      → resize_window
//   list_displays      → list_displays

/** System B names of the window tools to re-project onto the MCP surface. */
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

/** Build projected window ToolDefinitions from System B (cached). */
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

// ─── Step 5: Mouse group re-projection ───────────────────────────────────────
//
// MCP tools mouse_click, mouse_drag, mouse_scroll, mouse_move_relative,
// mouse_down, mouse_up are re-projected from System B equivalents:
//   click, drag, scroll, mouse_move_relative, mouse_down, mouse_up.
//
// COORDINATE SPACE: click / drag / scroll take image-space coords (the latest screenshot's) when `space` is omitted,
// and mouse_move_relative scales dx/dy from image space: the tools do it themselves (projected/tools.ts).
//
// Tools WITHOUT a System B equivalent are left on System A:
//   • mouse_hover          — no System B hover tool
//   • mouse_double_click   — System B click counts differ in schema shape
//   • mouse_right_click    — System B click button param differs in schema shape
//   • mouse_middle_click   — no System B equivalent
//   • mouse_triple_click   — no System B equivalent
//   • mouse_scroll_horizontal — no System B equivalent
//   • mouse_drag_stepped   — no System B equivalent
//
// System B tool name → projected MCP name (via TOOL_META mcpName):
//   click             → mouse_click
//   drag              → mouse_drag
//   scroll            → mouse_scroll
//   mouse_move_relative → mouse_move_relative  (name unchanged)
//   mouse_down        → mouse_down            (name unchanged)
//   mouse_up          → mouse_up              (name unchanged)

/** System B names of the mouse tools to re-project onto the MCP surface. */
const MOUSE_SYSB_NAMES = new Set([
  'click',
  'drag',
  'scroll',
  'mouse_move_relative',
  'mouse_down',
  'mouse_up',
]);

/** Build projected mouse ToolDefinitions from System B (cached). */
let _projectedMouseCache: ToolDefinition[] | null = null;
function projectedMouseTools(): ToolDefinition[] {
  if (_projectedMouseCache !== null) return _projectedMouseCache;

  const sysBTools = buildUnifiedTools();
  _projectedMouseCache = sysBTools
    .filter(t => MOUSE_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedMouseCache;
}

// ─── Step 6: Accessibility / Perception group re-projection ─────────────────
//
// The following MCP tools are now backed by System B (buildUnifiedTools)
// implementations, routed through the uniform projectToToolDefinition path:
//
//   System B name    → MCP name          (via TOOL_META mcpName / identity)
//   read_screen      → read_screen       (name unchanged)
//   invoke_element   → invoke_element    (name unchanged)
//   set_field_value  → set_field_value   (name unchanged)
//   focus_element    → focus_element     (name unchanged)
//   a11y_get_value   → a11y_get_value    (name unchanged)
//   a11y_expand      → a11y_expand       (name unchanged)
//   a11y_collapse    → a11y_collapse     (name unchanged)
//   a11y_toggle      → a11y_toggle       (name unchanged)
//   a11y_select      → a11y_select       (name unchanged)
//   get_element_state → get_element_state (name unchanged)
//   wait_for_element → wait_for_element  (name unchanged)
//   (ocr_read_screen stays on System A — structured OCR output for external agents)
//
// BEHAVIOR UPGRADE (desirable)
// ─────────────────────────────
// System B's a11y tools (a11y_expand, a11y_collapse, a11y_toggle, a11y_select,
// a11y_get_value, get_element_state) call resolveAgentPid() which auto-scopes
// to the active window pid when processId is omitted. This is strictly better
// than the System A behavior (which walked the full system tree).
//
// PARAM RECONCILIATION
// ─────────────────────
// invoke_element: System A had automationId + action params absent in System B.
//   → Both have been added to the System B tool (tools.ts) so the MCP schema
//     is backward-compatible. No behavior is silently dropped.
//   → automationId note: the System B tool passes an automationId-only call
//     as the name for the search (functional fallback). PlatformAdapter's
//     findElements / invokeElement take automationId themselves (macOS and
//     Windows match it exactly; Linux has no separate id).
//
// set_field_value: System A (a11y_depth.ts) had controlType param absent in
//   the System B version.
//   → controlType added to the System B tool (tools.ts) for backward-compat.
//
// ocr_read_screen: KEPT ON SYSTEM A. For scope:"screen" it returns structured JSON
//   (elements[] + bounds + fullText + coordinateSystem); for scope:"window" it
//   answers in rows, `@x,y "text"` (the centre of the text, screen coordinates),
//   after a line that says which window was read. System B's read_text reads
//   the whole screen only and gives a line's top-left corner, so it is not projected.
//
// TOOLS LEFT ON SYSTEM A (no System B buildUnifiedTools() equivalent):
//   • find_element        — not in buildUnifiedTools()
//   • get_focused_element — not in buildUnifiedTools()
//   • a11y_get_element    — not in buildUnifiedTools()
//   • a11y_list_children  — not in buildUnifiedTools()
//   • smart_type          — not in buildUnifiedTools()
//   • smart_read          — not in buildUnifiedTools()
//   • smart_click         — System B has a smart_click; System A's is the one served.

/** System B names of the a11y / perception tools to re-project onto the MCP surface. */
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
  // NOTE: `read_text` (System B) is intentionally NOT projected. The MCP surface keeps
  // System A's `ocr_read_screen`: JSON (elements[] + bounds + coordinateSystem) for
  // scope:"screen", `@x,y "text"` rows with the centre of each text for scope:"window".
]);

/** Build projected a11y/perception ToolDefinitions from System B (cached). */
let _projectedA11yCache: ToolDefinition[] | null = null;
function projectedA11yTools(): ToolDefinition[] {
  if (_projectedA11yCache !== null) return _projectedA11yCache;

  const sysBTools = buildUnifiedTools();
  _projectedA11yCache = sysBTools
    .filter(t => A11Y_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedA11yCache;
}

// ─── Step 7: CDP / Browser group re-projection ───────────────────────────────
//
// 5 of the 12 current browser-category MCP tools map to System B browser_*
// equivalents via TOOL_META. Per-tool comparison:
//
//   cdp_connect (System A):
//     • Calls ctx.cdp.connect() — attaches to existing CDP session, no auto-launch.
//     • Output: { text: "Connected to: … at …" } (no usage hint).
//   browser_connect (System B) → cdp_connect:
//     • Calls ctx.cdp.ensureConnected({launch, exePaths}) — auto-launches Edge/Chrome
//       via getEdgePaths()/getChromePaths() if not already connected.
//     • Output: includes "Use browser_navigate…" guidance.
//     VERDICT: MIGRATE — System B is strictly BETTER (auto-launch + guidance).
//
//   cdp_page_context (System A):
//     • No params; always calls ctx.cdp.getPageContext() → structured interactive-
//       element list (links/buttons/inputs with selectors).
//   browser_read (System B) → cdp_page_context:
//     • Optional `selector` param; no selector → getPageContext() (SAME output);
//       with selector → ctx.cdp.readText(selector, 3000) (additive).
//     VERDICT: MIGRATE — System B is EQUAL-OR-BETTER (adds selector param; no-param
//     path returns identical structured list).
//
//   cdp_click (System A):
//     • selector OR text; same click logic.
//   browser_click (System B) → cdp_click:
//     • Same params (text preferred, selector alternative). Same click logic.
//     • Error message adds "Call browser_read to see the actual elements" guidance.
//     VERDICT: MIGRATE — System B is EQUAL (same params, marginally better errors).
//
//   cdp_type (System A):
//     • selector OR label, text required.
//   browser_type (System B) → cdp_type:
//     • Same params (text required, selector OR label). Same type logic.
//     VERDICT: MIGRATE — System B is EQUAL.
//
//   navigate_browser (System A):
//     • safetyTier 2, category 'orchestration'. LAUNCHES the browser with
//       --remote-debugging-port and then optionally navigates. This is the
//       dedicated browser-launcher tool; external agents call it to start CDP.
//   browser_navigate (System B) → navigate_browser:
//     • safetyTier 1, category 'browser'. Navigates within an ALREADY-CONNECTED
//       browser; requires a prior browser_connect call.
//     VERDICT: DO NOT MIGRATE. The System B version would silently strip the
//       browser-launch capability from navigate_browser — an external agent calling
//       navigate_browser to start the browser would get "not connected" instead of
//       a running browser. The launch semantics must not change.
//
// TOOLS LEFT ON SYSTEM A (no System B equivalent):
//   • navigate_browser  — dedicated browser launcher (see above)
//   • cdp_read_text     — has maxLength param; browser_read lacks it; also maps
//                         to a different MCP name (cdp_page_context)
//   • cdp_select_option — no System B equivalent in buildUnifiedTools()
//   • cdp_evaluate      — no System B equivalent
//   • cdp_wait_for_selector — no System B equivalent
//   • cdp_list_tabs     — no System B equivalent
//   • cdp_switch_tab    — no System B equivalent
//   • cdp_scroll        — no System B equivalent
//
// DOCUMENTED BEHAVIOR CHANGES (see CHANGELOG.md [Unreleased] — v2):
//   • cdp_connect now auto-launches Edge/Chrome when not connected (was attach-only).
//   • cdp_page_context gains an optional `selector` param; callers that pass a CSS
//     selector now get plain text for that element instead of the full interactive-
//     element list. Callers that pass no params are unaffected.

/** System B names of the CDP/browser tools to re-project onto the MCP surface. */
const BROWSER_SYSB_NAMES = new Set([
  'browser_connect',
  'browser_read',
  'browser_click',
  'browser_type',
  // NOTE: 'browser_navigate' is intentionally NOT included.
  // TOOL_META maps it to 'navigate_browser' but the System A navigate_browser is
  // the browser LAUNCHER (safetyTier 2, category 'orchestration'). Projecting
  // browser_navigate would silently strip the launch capability. Keep on System A.
]);

/** Build projected CDP/browser ToolDefinitions from System B (cached). */
let _projectedBrowserCache: ToolDefinition[] | null = null;
function projectedBrowserTools(): ToolDefinition[] {
  if (_projectedBrowserCache !== null) return _projectedBrowserCache;

  const sysBTools = buildUnifiedTools();
  _projectedBrowserCache = sysBTools
    .filter(t => BROWSER_SYSB_NAMES.has(t.name))
    .map(t => projectToToolDefinition(t));

  return _projectedBrowserCache;
}

// ─── Step 4: Keyboard group re-projection ────────────────────────────────────
//
// MCP tools type_text, key_press, key_down, key_up, undo_last are re-projected
// from System B equivalents: type, key, key_down, key_up, undo_last.
//
// ALL five tools use the generic projectToToolDefinition() bridge so every
// handler runs through toolContextToAgent(ctx) → ctx.platform.* — the real
// runtime path. System B's `key` tool already carries all necessary fixes:
//   (a) missing-arg guard
//   (b) space-separated key sequences
//   (c) BLOCKED_KEYS guard
//   (d) `key` alias for `combo` (backward-compat)
// System B's `type` tool already uses the clipboard fast-path.
//
// System B tool name → projected MCP name (via TOOL_META mcpName):
//   type       → type_text
//   key        → key_press
//   key_down   → key_down   (name unchanged)
//   key_up     → key_up     (name unchanged)
//   undo_last  → undo_last  (name unchanged)

/** System B names of the keyboard tools to re-project onto the MCP surface. */
const KEYBOARD_SYSB_NAMES = new Set(['type', 'key', 'key_down', 'key_up', 'undo_last']);

/** Build projected keyboard ToolDefinitions from System B (cached). */
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
// once and reuse it. Before this, every getTool()/getTools() call rebuilt
// the whole 14-source array — and getTool() is on the hot dispatch path.
let _granularCache: ToolDefinition[] | null = null;
function granularTools(): ToolDefinition[] {
  if (_granularCache === null) {
    // All System A tools, then the projected System B groups: window (Step 3), keyboard (Step 4), mouse (Step 5),
    // a11y / perception (Step 6) and CDP / browser (Step 7).
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
 * (`clawdcursor mcp --compact`, `GET /tools?mode=compact`).
 */
export function getCompactSurface(): ToolDefinition[] {
  return getCompactTools();
}

/** Get a tool by name */
export function getTool(name: string): ToolDefinition | undefined {
  // Search the cached array directly — no copy, no rebuild (hot path).
  return granularTools().find(t => t.name === name);
}
