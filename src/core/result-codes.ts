/**
 * What a tool result means, in a form any calling agent can act on: an outcome (did the action take?), and for a
 * failure a stable code, a short hint and a safe next call.
 *
 *   confirmed  — the action ran and a check saw its effect (`expect` passed, `verify` passed)
 *   unverified — the action ran; nothing checked its effect
 *   refused    — it did not run: the safety gate, consent, a locked screen, a system dialog owning the keyboard
 *   failed     — it ran into an error, or ran without the expected effect (DEVIATION)
 *
 * Classified from the result text the tools already produce, so every tool gets it without changing any of them. Only
 * the head of a result is read for the error vocabulary: a long body (page text) can contain the same words as content.
 */

export type ResultOutcome = 'confirmed' | 'unverified' | 'refused' | 'failed';

export type ResultCode =
  | 'CONSENT_REQUIRED' | 'SAFETY_BLOCKED' | 'NEEDS_CONFIRMATION' | 'KEYBOARD_OWNED' | 'SCREEN_LOCKED' | 'OWN_UI' | 'PAUSED' | 'DANGEROUS_KEY'
  | 'INVALID_ARGS' | 'READBACK_MISMATCH' | 'REPEATED' | 'STALE_SCREENSHOT' | 'DEVIATION' | 'STALE_REF' | 'TIMEOUT' | 'NOT_FOUND' | 'NOT_CONNECTED' | 'UNKNOWN';

/** Tool names as the caller sees them: the compact MCP surface, or the built-in agent's own tools. */
export type Surface = 'mcp' | 'agent';

export interface ResultClass {
  outcome: ResultOutcome;
  code?: ResultCode;
  hint?: string;
  /** A safe next call, in the caller's own tool names. */
  next?: string;
}

interface Rule {
  code: ResultCode;
  outcome: 'refused' | 'failed';
  test: RegExp;
  /** Look at the whole text, not just its head (DEVIATION is appended after the tool's own text). */
  whole?: boolean;
  hint: string;
  next?: Partial<Record<Surface, string>>;
}

const PAUSE = (msg: string): Record<Surface, string> => ({
  mcp: `system {"action":"pause_for_user","message":"${msg}"}`,
  agent: `ask_user {"message":"${msg}"}`,
});
const REREAD: Record<Surface, string> = { mcp: 'accessibility {"action":"compile_ui"}', agent: 'compile_ui {}' };

/** First match wins: refusals before failures, specific before generic. */
const RULES: Rule[] = [
  { code: 'CONSENT_REQUIRED', outcome: 'refused', test: /needs one-time consent/i,
    hint: 'the user runs `clawdcursor consent --accept` once; no restart needed' },
  { code: 'SAFETY_BLOCKED', outcome: 'refused', test: /safety block -|^\[block\]/i,
    hint: 'blocked by the safety gate; do not retry, tell the user' },
  { code: 'NEEDS_CONFIRMATION', outcome: 'refused', test: /safety confirm -|^\[confirm\]|requires user confirmation/i,
    hint: 'needs the user\'s OK first; retrying will not help', next: PAUSE('Please confirm: <what and why>') },
  { code: 'KEYBOARD_OWNED', outcome: 'refused', test: /system dialog owns the keyboard/i,
    hint: 'a system dialog has the keyboard; answer or close it first', next: PAUSE('Close the system dialog that has the keyboard') },
  { code: 'SCREEN_LOCKED', outcome: 'refused', test: /screen is locked/i,
    hint: 'the screen is locked', next: PAUSE('Unlock the screen') },
  { code: 'OWN_UI', outcome: 'refused', test: /is clawdcursor's own on-screen control/i,
    hint: 'that is the user\'s pill; target the app instead', next: REREAD },
  { code: 'PAUSED', outcome: 'refused', test: /a pause is waiting for the user on screen/i,
    hint: 'the user has not answered the pause yet; wait, do not act' },
  { code: 'DANGEROUS_KEY', outcome: 'refused', test: /dangerous key combo/i,
    hint: 'this key combination is never sent; do the step another way' },
  { code: 'DEVIATION', outcome: 'failed', test: /\nDEVIATION: /, whole: true,
    hint: 'it ran but the expected effect was not seen; read the screen before retrying, it may have taken', next: REREAD },
  { code: 'STALE_SCREENSHOT', outcome: 'refused',
    test: /an older screenshot|none has been taken|was not on screenshot s\d+ is in front/i,
    hint: 'the screen changed since the screenshot these coordinates came from; nothing was clicked',
    next: { mcp: 'computer {"action":"screenshot"}', agent: 'screenshot {}' } },
  { code: 'STALE_REF', outcome: 'failed', test: /ref rejected|unknown snapshot|snapshot .*(?:expired|stale)|call compile_ui first/i,
    hint: 'the screen changed since that snapshot; take a fresh one', next: REREAD },
  { code: 'READBACK_MISMATCH', outcome: 'failed', test: /but the field shows .* — Return not pressed/i,
    hint: 'the field does not show exactly what was typed, so it was not submitted; check it — press Return if it is right, fix it if not', next: REREAD },
  { code: 'REPEATED', outcome: 'failed', test: /repeat guard/i,
    hint: 'the same call kept repeating without progress; change the approach' },
  { code: 'INVALID_ARGS', outcome: 'failed',
    test: /unknown action|missing required field|is required|must be (?:a )?finite|expect rejected|done_when rejected|NOT EXECUTED|invalid (?:arguments|args|json)/i,
    hint: 'fix the arguments; nothing ran' },
  { code: 'TIMEOUT', outcome: 'failed', test: /timed out|PSRunner timeout|ETIMEDOUT/i,
    hint: 'the app may be busy; read the screen again, then retry once', next: REREAD },
  // MCP's navigate attaches by itself; the built-in agent's needs browser_connect first.
  { code: 'NOT_CONNECTED', outcome: 'failed', test: /not connected|no browser (?:is )?connected|ECONNREFUSED/i,
    hint: 'no browser session', next: { mcp: 'browser {"action":"navigate","url":"<url>"}', agent: 'browser_connect {}' } },
  // Element / window vocabulary only: "helper not found", "model not found" are install problems, not a missing element.
  { code: 'NOT_FOUND', outcome: 'failed',
    test: /(?:element|window|field|button|option|item|tab|target) (?:was )?not found|not found: name=|missed —|no elements? (?:found|named)|no_clickable_target|no (?:editable )?field named|no option named|no (?:open )?window (?:matching|named)|no (?:open )?window (?:or running app )?(?:matches|belongs to)|no window has a title containing/i,
    hint: 'nothing matched; the name may differ or the element is off screen', next: REREAD },
];

/**
 * Calls that change something — the ones an outcome means anything for. An explicit list: reads, waits and calls that
 * return a value (build_uri, evaluate) must not get a line appended to what they return.
 */
const ACTING: Record<string, ReadonlySet<string>> = {
  computer: new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'drag', 'drag_path', 'scroll',
    'scroll_horizontal', 'mouse_down', 'mouse_up', 'type', 'key', 'key_press', 'key_down', 'key_up']),
  accessibility: new Set(['invoke', 'click', 'focus', 'set_value', 'set-value', 'expand', 'collapse', 'toggle', 'select',
    'smart_click', 'smart_type']),
  window: new Set(['focus', 'maximize', 'minimize', 'restore', 'close', 'resize', 'open_app', 'open_file', 'open_url',
    'switch_tab', 'navigate']),
  system: new Set(['clipboard_write', 'undo', 'shortcuts_run', 'open_uri', 'open_app', 'open_file', 'open_url', 'relaunch_with_cdp']),
  browser: new Set(['navigate', 'click', 'type', 'select_option', 'switch_tab', 'scroll']),
};

/** Is (compound tool, action) a call that changes something? */
export function isActingAction(compound: string, action: string | undefined): boolean {
  return !!action && !!ACTING[compound]?.has(action);
}

const HEAD = 400;

/**
 * Classify a result. `acting`: the call changes something (a click, typing, a window move) — reads are not given an
 * outcome on success, there is nothing to confirm.
 */
export function classifyResult(text: string, isError: boolean, acting: boolean, surface: Surface = 'mcp'): ResultClass | null {
  if (isError) {
    const head = text.slice(0, HEAD);
    const r = RULES.find(rule => rule.test.test(rule.whole ? text : head));
    if (r) return { outcome: r.outcome, code: r.code, hint: r.hint, next: r.next?.[surface] };
    return { outcome: 'failed', code: 'UNKNOWN', hint: 'read the screen, then try another way', next: REREAD[surface] };
  }
  // A success is never classified by its words: a page's text can say "not found" or "timed out" as content.
  if (!acting) return null;
  // The checks' own wording, at their own positions: a body that happens to contain "VERIFIED" on some line is not one.
  // Only where the checks write them, so nothing inside a result (typed text, a page, a window title) can pose as one:
  // `expect`'s verdict is appended at the very end; `verify` starts its reply; a typing read-back sits in the leading
  // "Typed N chars (…)" before any quoted text.
  if (/ — verified \d+ check\(s\)$/.test(text) || /^VERIFIED:/.test(text) || /^Typed \d+ chars \((?:keys|paste), read back ✓\)/.test(text)) {
    return { outcome: 'confirmed' };
  }
  // No hint: not every tool takes `expect`, and the server instructions already say how to confirm.
  return { outcome: 'unverified' };
}

/** One line, appended to the result: `[failed · NOT_FOUND · hint: … · next: …]`. */
export function renderResultLine(c: ResultClass): string {
  const parts: string[] = [c.outcome];
  if (c.code) parts.push(c.code);
  if (c.hint) parts.push(`hint: ${c.hint}`);
  if (c.next) parts.push(`next: ${c.next}`);
  return `[${parts.join(' · ')}]`;
}

/** Results that are JSON keep their own status fields; appending text would break a caller that parses them. */
export function isJsonText(text: string): boolean {
  const t = text.trim();
  if (!t || !'{["0123456789-tfn'.includes(t[0])) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}
