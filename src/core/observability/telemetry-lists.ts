/**
 * The closed lists bug telemetry takes its values from. One copy, used by the client (telemetry.ts) and by the Worker that
 * checks every event again (telemetry-worker/src/index.ts, which wrangler bundles with this file): so no Node imports here.
 */

/** MCP client name → host. Anything else is "other"; no initialize yet is "unknown". */
export const HOSTS: Array<[RegExp, string]> = [
  [/^claude-code/, 'claude-code'], [/^claude-ai/, 'claude-desktop'], [/claude desktop/, 'claude-desktop'], [/cursor/, 'cursor'], [/windsurf/, 'windsurf'],
  [/visual studio code|vscode/, 'vscode'], [/^zed/, 'zed'], [/codex/, 'codex'], [/cline/, 'cline'], [/gemini/, 'gemini-cli'],
  [/openclaw/, 'openclaw'],
];

export const OUTCOMES = ['ok', 'empty', 'partial', 'timeout', 'error', 'refused', 'consent_required'];
/** The outcomes sent as call_failed. */
export const FAILED = ['error', 'timeout', 'empty'];

export const ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AbortError', 'TimeoutError', 'SystemError', 'string', 'number', 'boolean', 'object', 'undefined', 'symbol', 'bigint', 'function'];

/** Programs clawdcursor itself starts (steps.ts names a step after its program). Any other program could be the user's app. */
export const HELPERS = ['powershell', 'pwsh', 'python3', 'python', 'osascript', 'swift', 'swiftc', 'xdotool', 'ydotool', 'wtype', 'wmctrl',
  'xrandr', 'wlr-randr', 'swaymsg', 'xwininfo', 'xprop', 'grim', 'wl-paste', 'wl-copy', 'xclip', 'xsel', 'pbcopy', 'pbpaste', 'lsappinfo',
  'ioreg', 'open', 'xdg-open', 'gtk-launch', 'ps', 'sh', 'which', 'pkill', 'cmd', 'tesseract', 'screencapture'];
/** A ps-bridge.ps1 command step, e.g. "ps-bridge find-element". */
export const PS_BRIDGE_STEP = /^ps-bridge [a-z][a-z-]{1,39}$/;

/** Session-log exit reason → reason class. */
export const EXIT_REASONS: Array<[RegExp, string]> = [
  [/^SIGINT/, 'sigint'], [/^SIGTERM/, 'sigterm'], [/stdin (ended|closed)/, 'host_closed'], [/^stdin error/, 'stdin_error'],
  [/host process .* is gone/, 'host_gone'], [/^killed or crashed/, 'killed_or_crashed'], [/clawdcursor stop/, 'user_stop'],
];

export const ARCHS = ['x64', 'arm64', 'ia32', 'arm'];
export const APP_KINDS = ['browser', 'electron', 'native', 'unknown'];

/** The shape of a clawdcursor tool or action name ("set-value" has a hyphen). The client sends only registered names, else "other". */
export const NAME = /^(other|[a-z][a-z0-9_-]{0,39})$/;
