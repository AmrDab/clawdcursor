/**
 * The compact surface's route table: every compound action and the granular tool it runs (compact.ts builds the compound
 * tools from it). Pure data with no imports, so the guards (call-guards.ts, screen-guard.ts) and the MCP server can read
 * a call's route without importing the compound tools.
 */

// ─── Action → granular-tool delegation table ────────────────────────

/**
 * One row per compact sub-action.
 *
 *   compound:   which compound tool the LLM calls (computer/accessibility/…)
 *   action:     the enum value for that compound's `action` arg
 *   delegate:   the granular tool name to dispatch to
 *   argRemap:   optional — rename fields before handing off (e.g. the
 *               compound's `combo` → granular `key_press`'s `key`).
 */
export interface ActionRoute {
  action: string;
  delegate: string;
  argRemap?: Record<string, string>;
}

const COMPUTER_ACTIONS: ActionRoute[] = [
  // Mouse
  { action: 'click',         delegate: 'mouse_click' },
  { action: 'double_click',  delegate: 'mouse_double_click' },
  { action: 'right_click',   delegate: 'mouse_right_click' },
  { action: 'middle_click',  delegate: 'mouse_middle_click' },
  { action: 'triple_click',  delegate: 'mouse_triple_click' },
  { action: 'hover',         delegate: 'mouse_hover' },
  { action: 'move',          delegate: 'mouse_hover' },       // alias
  { action: 'mouse_move',    delegate: 'mouse_hover' },       // alias (computer-use name)
  { action: 'move_relative', delegate: 'mouse_move_relative' },
  { action: 'scroll',        delegate: 'mouse_scroll' },
  { action: 'scroll_horizontal', delegate: 'mouse_scroll_horizontal' },
  { action: 'drag',          delegate: 'mouse_drag' },
  { action: 'drag_path',     delegate: 'mouse_drag_stepped' },
  { action: 'mouse_down',    delegate: 'mouse_down' },
  { action: 'mouse_up',      delegate: 'mouse_up' },
  // Keyboard — `combo` is the natural compound name for a key chord;
  // it remaps to the granular `key_press`'s `key` parameter (see argRemap
  // doc-comment above).
  { action: 'type',      delegate: 'type_text' },
  // `text` too: computer-use's key action names the chord `text` (#381).
  { action: 'key',       delegate: 'key_press', argRemap: { combo: 'key', text: 'key' } },
  { action: 'key_press', delegate: 'key_press', argRemap: { combo: 'key' } },
  { action: 'key_down',  delegate: 'key_down',  argRemap: { combo: 'key' } },
  { action: 'key_up',    delegate: 'key_up',    argRemap: { combo: 'key' } },
  // Flow
  { action: 'wait',      delegate: 'wait' },
  // Perception, last: the enum order is the order a model reads them in, and a screenshot is the last resort.
  { action: 'screenshot', delegate: 'desktop_screenshot' },
  { action: 'screenshot_region', delegate: 'desktop_screenshot_region' },
  { action: 'zoom',              delegate: 'desktop_screenshot_region' }, // alias (computer-use name)
];

const ACCESSIBILITY_ACTIONS: ActionRoute[] = [
  { action: 'read_tree',      delegate: 'read_screen' },
  { action: 'find',           delegate: 'find_element' },
  { action: 'get_element',    delegate: 'a11y_get_element' },
  { action: 'focused',        delegate: 'get_focused_element' },
  { action: 'invoke',         delegate: 'invoke_element' },
  { action: 'focus',          delegate: 'focus_element' },
  { action: 'set_value',      delegate: 'set_field_value' },
  { action: 'get_value',      delegate: 'a11y_get_value' },
  { action: 'expand',         delegate: 'a11y_expand' },
  { action: 'collapse',       delegate: 'a11y_collapse' },
  { action: 'toggle',         delegate: 'a11y_toggle' },
  { action: 'select',         delegate: 'a11y_select' },
  { action: 'state',          delegate: 'get_element_state' },
  { action: 'list_children',  delegate: 'a11y_list_children', argRemap: { name: 'parentName' } },
  { action: 'wait_for',       delegate: 'wait_for_element' },
  // el_NN UI State Compiler: compile_ui fuses a11y+OCR into one ranked map with stable
  // ids; the finders locate a target semantically and return an el_NN to act on (the
  // {element_id, snapshot_id} ref the `invoke`/`set_value` actions accept).
  { action: 'compile_ui',     delegate: 'compile_ui' },
  { action: 'find_button',    delegate: 'find_action_button' },
  { action: 'find_field',     delegate: 'find_input_field' },
  // Smart auto-fallback (OCR → a11y → CDP, by element text — no coordinates).
  { action: 'smart_click',    delegate: 'smart_click' },
  { action: 'smart_type',     delegate: 'smart_type' },
  { action: 'smart_read',     delegate: 'smart_read' },
];

const WINDOW_ACTIONS: ActionRoute[] = [
  { action: 'list',          delegate: 'get_windows' },
  { action: 'active',        delegate: 'get_active_window' },
  { action: 'focus',         delegate: 'focus_window' },
  { action: 'maximize',      delegate: 'maximize_window' },
  { action: 'minimize',      delegate: 'minimize_window_to_taskbar' },
  { action: 'restore',       delegate: 'restore_window' },
  { action: 'close',         delegate: 'close_window' },
  { action: 'resize',        delegate: 'resize_window' },
  { action: 'list_displays', delegate: 'list_displays' },
  { action: 'screen_size',   delegate: 'get_screen_size' },
  { action: 'open_app',      delegate: 'open_app' },
  { action: 'open_file',     delegate: 'open_file' },
  { action: 'open_url',      delegate: 'open_url' },
  { action: 'switch_tab',    delegate: 'switch_tab_os' },
  { action: 'navigate',      delegate: 'navigate_browser' },
];

const SYSTEM_ACTIONS: ActionRoute[] = [
  { action: 'clipboard_read',  delegate: 'read_clipboard' },
  { action: 'clipboard_write', delegate: 'write_clipboard' },
  { action: 'copy_all_text',   delegate: 'copy_all_text' },
  { action: 'report',          delegate: 'session_report' },
  { action: 'telemetry_optout', delegate: 'telemetry_optout' },
  { action: 'system_time',     delegate: 'get_system_time' },
  { action: 'ocr',             delegate: 'ocr_read_screen' },
  { action: 'undo',            delegate: 'undo_last' },
  { action: 'shortcuts_list',  delegate: 'shortcuts_list' },
  { action: 'shortcuts_run',   delegate: 'shortcuts_execute' },
  // Hand the desktop to the user at a roadblock (sign-in, 2FA, CAPTCHA) and
  // continue when they click Resume on screen.
  { action: 'pause_for_user',  delegate: 'pause_for_user' },
  // Electron/WebView2 bridge
  { action: 'detect_webview',  delegate: 'detect_webview_apps' },
  { action: 'relaunch_with_cdp', delegate: 'relaunch_with_cdp' },
  // URI escape hatches — accomplish an intent WITHOUT driving UI by dispatching
  // a registered URI scheme (mailto:, tel:, slack:, vscode:, spotify:, file:, …).
  // Cross-OS: macOS `open`, Linux `xdg-open`, Windows registered-handler resolve.
  { action: 'build_uri',       delegate: 'build_uri' },
  { action: 'open_uri',        delegate: 'open_uri' },
  // Launch/open family — ALSO on `window`, aliased here because "open an
  // app/file/url" reads as a system action (and `open_uri` already lives on
  // system). The MCP layer enum-validates `action` before our dispatcher, so
  // the cross-compound hint can't fire over /mcp — making the intuitive call
  // valid on BOTH compounds is what actually unblocks an integrating agent.
  { action: 'open_app',        delegate: 'open_app' },
  { action: 'open_file',       delegate: 'open_file' },
  { action: 'open_url',        delegate: 'open_url' },
];

const BROWSER_ACTIONS: ActionRoute[] = [
  // `navigate` is ALSO on `window`; aliased here because every browser hint
  // ("open a URL first") points at this compound, and the compact surface had
  // no way to open a page in the CDP browser it then drives (1.5.11 live repro).
  { action: 'navigate',       delegate: 'navigate_browser' },
  { action: 'connect',        delegate: 'cdp_connect' },
  { action: 'page_context',   delegate: 'cdp_page_context' },
  { action: 'read_text',      delegate: 'cdp_read_text' },
  { action: 'click',          delegate: 'cdp_click' },
  { action: 'type',           delegate: 'cdp_type' },
  { action: 'select_option',  delegate: 'cdp_select_option' },
  { action: 'evaluate',       delegate: 'cdp_evaluate' },
  { action: 'wait_for',       delegate: 'cdp_wait_for_selector' },
  { action: 'list_tabs',      delegate: 'cdp_list_tabs' },
  { action: 'switch_tab',     delegate: 'cdp_switch_tab' },
  { action: 'scroll',         delegate: 'cdp_scroll' },
];

/**
 * Index of every compound's action table — lets a misrouted action point the
 * caller at the compound that actually owns it (e.g. `system open_app` →
 * "that action is on `window`"), instead of a dead-end "unknown action".
 */
export const COMPOUND_ROUTE_INDEX: Record<string, ActionRoute[]> = {
  computer: COMPUTER_ACTIONS,
  accessibility: ACCESSIBILITY_ACTIONS,
  window: WINDOW_ACTIONS,
  system: SYSTEM_ACTIONS,
  browser: BROWSER_ACTIONS,
};

/**
 * A call in compact names: a compound call as it is, a granular tool as its route (the first, for a tool two compounds
 * route to), a granular tool with no route as itself with no action. Facts about a call (acting, pause-safe, an
 * image-space pointer call…) are written once, in these names, and a granular call has the facts of its route.
 */
export function compactCall(tool: string, action?: string): { tool: string; action?: string } {
  if (tool in COMPOUND_ROUTE_INDEX) return { tool, action };
  for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
    const route = routes.find(r => r.delegate === tool);
    if (route) return { tool: compound, action: route.action };
  }
  return { tool };
}
