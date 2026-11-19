/**
 * The closed lists bug telemetry takes its values from. One copy, used by the client (telemetry.ts) and by the Worker that
 * checks every event again (telemetry-worker/src/index.ts, which wrangler bundles with this file): so no Node imports here.
 */

/** MCP client name → host. Anything else is "other"; no initialize yet is "unknown". */
export const HOSTS: Array<[RegExp, string]> = [
  [/^claude-code/, 'claude-code'], [/^claude-ai/, 'claude-desktop'], [/claude desktop/, 'claude-desktop'], [/^cursor/, 'cursor'], [/windsurf/, 'windsurf'],
  [/visual studio code|vscode/, 'vscode'], [/^zed/, 'zed'], [/codex/, 'codex'], [/cline/, 'cline'], [/gemini/, 'gemini-cli'],
  [/openclaw/, 'openclaw'],
];

export const OUTCOMES = ['ok', 'empty', 'partial', 'timeout', 'error', 'refused', 'consent_required'];
/** The outcomes sent as call_failed. Not `empty`: a find that found nothing, an empty clipboard, is not a bug. */
export const FAILED = ['error', 'timeout'];

export const ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AbortError', 'TimeoutError', 'SystemError', 'string', 'number', 'boolean', 'object', 'undefined', 'symbol', 'bigint', 'function'];

/** Programs clawdcursor itself starts (steps.ts names a step after its program). Any other program could be the user's app. */
export const HELPERS = ['powershell', 'pwsh', 'python3', 'python', 'osascript', 'swift', 'swiftc', 'xdotool', 'ydotool', 'wtype', 'wmctrl',
  'xrandr', 'wlr-randr', 'swaymsg', 'xwininfo', 'xprop', 'grim', 'wl-paste', 'wl-copy', 'xclip', 'xsel', 'pbcopy', 'pbpaste', 'lsappinfo',
  'ioreg', 'open', 'xdg-open', 'gtk-launch', 'ps', 'sh', 'which', 'pkill', 'cmd', 'tesseract', 'screencapture'];
/** The step a deliberate wait is timed as (steps.ts timeWait): a pause for the user, `wait`, a wait_for. Not clawdcursor's own work. */
export const WAIT_STEP = 'wait';
/** A ps-bridge.ps1 command step, e.g. "ps-bridge find-element". */
export const PS_BRIDGE_STEP = /^ps-bridge [a-z][a-z-]{1,39}$/;

/** Session-log exit reason → reason class. */
export const EXIT_REASONS: Array<[RegExp, string]> = [
  [/^SIGINT/, 'sigint'], [/^SIGTERM/, 'sigterm'], [/stdin (ended|closed)/, 'host_closed'], [/^stdin error/, 'stdin_error'],
  [/host process .* is gone/, 'host_gone'], [/^killed or crashed/, 'killed_or_crashed'], [/clawdcursor stop/, 'user_stop'],
];

export const ARCHS = ['x64', 'arm64', 'ia32', 'arm'];
export const APP_KINDS = ['browser', 'electron', 'native', 'unknown'];

/**
 * Every tool and action name clawdcursor registers (getAllTools + getCompactSurface: the tool names and each tool's actions),
 * for the Worker to accept only these. The client sends "other" for anything else. A test fails when the registry and this
 * list differ: add the new name here, and redeploy the Worker, or events carrying it are dropped.
 */
export const NAMES = [
  'a11y_collapse', 'a11y_expand', 'a11y_get_element', 'a11y_get_value', 'a11y_list_children', 'a11y_select', 'a11y_toggle', 'accessibility',
  'active', 'batch', 'browser', 'build_uri', 'cdp_click', 'cdp_connect', 'cdp_evaluate', 'cdp_list_tabs', 'cdp_page_context', 'cdp_read_text',
  'cdp_scroll', 'cdp_select_option', 'cdp_switch_tab', 'cdp_type', 'cdp_wait_for_selector', 'click', 'clipboard_read', 'clipboard_write', 'close',
  'close_window', 'collapse', 'compile_ui', 'computer', 'connect', 'copy_all_text', 'cursor_position', 'desktop_screenshot',
  'desktop_screenshot_region', 'detect_webview', 'detect_webview_apps', 'double_click', 'drag', 'drag_path', 'evaluate', 'expand', 'find',
  'find_action_button', 'find_button', 'find_element', 'find_field', 'find_input_field', 'focus', 'focus_element', 'focus_window', 'focused',
  'get-value', 'get_active_window', 'get_element', 'get_element_state', 'get_focused_element', 'get_screen_size', 'get_system_time', 'get_value',
  'get_windows', 'hover', 'invoke', 'invoke_element', 'key', 'key_down', 'key_press', 'key_up', 'list', 'list_children', 'list_displays',
  'list_tabs', 'logs_recent', 'maximize', 'maximize_window', 'middle_click', 'minimize', 'minimize_window', 'minimize_window_to_taskbar',
  'mouse_click', 'mouse_double_click', 'mouse_down', 'mouse_drag', 'mouse_drag_stepped', 'mouse_hover', 'mouse_middle_click', 'mouse_move',
  'mouse_move_relative', 'mouse_right_click', 'mouse_scroll', 'mouse_scroll_horizontal', 'mouse_triple_click', 'mouse_up', 'move', 'move_relative',
  'navigate', 'navigate_browser', 'ocr', 'ocr_read_screen', 'open_app', 'open_file', 'open_uri', 'open_url', 'page_context', 'pause_for_user',
  'read_clipboard', 'read_screen', 'read_text', 'read_tree', 'relaunch_with_cdp', 'report', 'resize', 'resize_window', 'restore', 'restore_window',
  'resume_task', 'right_click', 'screen_size', 'screenshot', 'screenshot_full', 'screenshot_region', 'scroll', 'scroll_horizontal', 'select',
  'select_option', 'session_report', 'set-value', 'set_field_value', 'set_value', 'shortcuts_execute', 'shortcuts_list', 'shortcuts_run',
  'smart_click', 'smart_read', 'smart_type', 'state', 'submit_report', 'switch_tab', 'switch_tab_os', 'system', 'system_time', 'telemetry_optout',
  'toggle', 'triple_click', 'type', 'type_text', 'undo', 'undo_last', 'verify', 'wait', 'wait_for', 'wait_for_element', 'window', 'write_clipboard',
  'zoom',
] as const;
