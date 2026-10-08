/**
 * Phase A — authoritative cost-class assignments for every granular tool.
 *
 * Why a central table instead of inline `costClass:` on each of the 97
 * ToolDefinitions: one reviewable surface, one place to keep the taxonomy
 * consistent, and a single boot-validated source of truth. The values are
 * stamped onto the granular tools at registry-assembly time
 * (`stampCostClasses`), so every consumer — the coverage test, the MCP
 * `tools/list` projection, future runtime hints — reads `tool.costClass`
 * exactly as if it had been declared inline.
 *
 * Taxonomy (cheapest first): act < inspect < perceive-text < perceive-image.
 * See `ToolCostClass` in types.ts for the per-class token budgets.
 *
 * Compound dispatcher tools (`computer`, `accessibility`, `window`,
 * `system`, `browser`, `task`) are intentionally ABSENT — their cost
 * depends on the delegated action, so they stay `undefined`.
 */

import type { ToolCostClass, ToolDefinition } from './types';

/**
 * name → costClass. Grouped by class for readability. Every granular tool
 * returned by `getTools()` must appear exactly once; `validateCostClassMap`
 * (called from the coverage test) enforces both completeness and that no
 * stale name lingers after a tool is renamed/removed.
 */
export const COST_CLASS_BY_TOOL: Readonly<Record<string, ToolCostClass>> = {
  // ── act ── side-effect verbs; caller already knows what + where. ≤200 tok.
  // mouse
  mouse_click: 'act', mouse_double_click: 'act', mouse_right_click: 'act',
  mouse_hover: 'act', mouse_scroll: 'act', mouse_drag: 'act',
  mouse_move_relative: 'act', mouse_middle_click: 'act', mouse_triple_click: 'act',
  mouse_down: 'act', mouse_up: 'act', mouse_scroll_horizontal: 'act',
  mouse_drag_stepped: 'act',
  // keyboard
  type_text: 'act', key_press: 'act', shortcuts_execute: 'act',
  key_down: 'act', key_up: 'act', undo_last: 'act',
  // window / element mutation
  focus_element: 'act', focus_window: 'act', invoke_element: 'act',
  minimize_window: 'act', maximize_window: 'act', minimize_window_to_taskbar: 'act',
  restore_window: 'act', close_window: 'act', resize_window: 'act',
  switch_tab_os: 'act', set_field_value: 'act',
  a11y_expand: 'act', a11y_collapse: 'act', a11y_toggle: 'act', a11y_select: 'act',
  // clipboard write
  write_clipboard: 'act',
  // browser actions
  cdp_connect: 'act', cdp_click: 'act', cdp_type: 'act', cdp_select_option: 'act',
  cdp_switch_tab: 'act', cdp_scroll: 'act',
  // orchestration verbs
  delegate_to_agent: 'act', open_app: 'act', navigate_browser: 'act', wait: 'act',
  open_file: 'act', open_url: 'act', open_uri: 'act', relaunch_with_cdp: 'act',
  submit_task: 'act', abort_task: 'act', submit_report: 'act',
  // batch is inert itself (each step is gated/costed individually); classify the wrapper cheapest.
  batch: 'act',
  favorites_add: 'act', favorites_remove: 'act',
  scheduled_task_create: 'act', scheduled_task_delete: 'act', scheduled_task_toggle: 'act',

  // ── inspect ── cheap structured read. ≤2K tok.
  get_screen_size: 'inspect', get_system_time: 'inspect', wait_for_element: 'inspect',
  cursor_position: 'inspect',
  a11y_get_element: 'inspect', a11y_get_value: 'inspect', get_element_state: 'inspect',
  // verify runs only read primitives (window list, UIA value, clipboard, fs);
  // ocr_contains is the lone pricier path and is opt-in per assertion.
  verify: 'inspect',
  a11y_list_children: 'inspect', detect_webview_apps: 'inspect',
  shortcuts_list: 'inspect',
  get_windows: 'inspect', get_active_window: 'inspect', get_focused_element: 'inspect',
  find_element: 'inspect', list_displays: 'inspect',
  read_clipboard: 'inspect',
  cdp_evaluate: 'inspect', cdp_wait_for_selector: 'inspect', cdp_list_tabs: 'inspect',
  build_uri: 'inspect', logs_recent: 'inspect', agent_status: 'inspect',
  task_logs_list: 'inspect', task_logs_current: 'inspect', favorites_list: 'inspect',
  scheduled_task_list: 'inspect',

  // ── perceive-text ── a11y/OCR/DOM dumps + tools that read them internally. ≤10K tok.
  read_screen: 'perceive-text', ocr_read_screen: 'perceive-text', smart_read: 'perceive-text',
  copy_all_text: 'perceive-text',
  session_report: 'inspect',
  smart_type: 'perceive-text', smart_click: 'perceive-text',
  cdp_page_context: 'perceive-text', cdp_read_text: 'perceive-text',
  get_system_prompt: 'perceive-text',
  compile_ui: 'perceive-text',
  find_action_button: 'perceive-text', find_input_field: 'perceive-text',

  // ── perceive-image ── screenshots with image bytes. ≤50K tok incl. base64.
  desktop_screenshot: 'perceive-image', desktop_screenshot_region: 'perceive-image',
  screenshot_full: 'perceive-image',
};

/**
 * Stamp `costClass` onto each granular tool from the table. Mutates and
 * returns the same array (assembly happens once per `getTools()` call).
 * Tools missing from the table are left untouched (coverage test warns).
 */
export function stampCostClasses(tools: ToolDefinition[]): ToolDefinition[] {
  for (const tool of tools) {
    const cc = COST_CLASS_BY_TOOL[tool.name];
    if (cc !== undefined) tool.costClass = cc;
  }
  return tools;
}

/**
 * Validate the table against the live granular tool set. Returns the set of
 * problems (empty array = clean). Used by the coverage test so a renamed or
 * removed tool surfaces immediately instead of rotting.
 */
export function validateCostClassMap(toolNames: string[]): string[] {
  const live = new Set(toolNames);
  const problems: string[] = [];
  for (const name of Object.keys(COST_CLASS_BY_TOOL)) {
    if (!live.has(name)) problems.push(`COST_CLASS_BY_TOOL has stale entry "${name}" (no such tool)`);
  }
  for (const name of toolNames) {
    if (COST_CLASS_BY_TOOL[name] === undefined) problems.push(`tool "${name}" missing a costClass`);
  }
  return problems;
}
