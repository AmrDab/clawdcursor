/**
 * What a tool result means, in a form any calling agent can act on: an outcome (did the action take?), and for a
 * failure a stable code, a short hint and a safe next call.
 *
 *   confirmed  — the action ran and a check saw its effect (`expect` passed, `verify` passed)
 *   unverified — the action ran; nothing checked its effect
 *   refused    — it did not run: consent, the user's Stop or pause, a locked screen, a system dialog owning the keyboard
 *   failed     — it ran into an error, or ran without the expected effect (DEVIATION)
 *
 * Classified from the result text the tools already produce, so every tool gets it without changing any of them. Only
 * the head of a result is read for the error vocabulary: a long body (page text) can contain the same words as content.
 */

import { fenceActive } from './fence';
import { defuseScreenDelimiters } from './untrusted-screen-content';

export type ResultOutcome = 'confirmed' | 'unverified' | 'refused' | 'failed';

export type ResultCode =
  | 'CONSENT_REQUIRED' | 'KEYBOARD_OWNED' | 'SECURE_INPUT' | 'SCREEN_LOCKED' | 'CAPTURE_DENIED' | 'VISION_DISABLED' | 'OWN_UI' | 'PAUSED' | 'DANGEROUS_KEY'
  | 'STOPPED' | 'FOREGROUND_CHANGED' | 'FENCED'
  | 'INVALID_ARGS' | 'READBACK_MISMATCH' | 'REPEATED' | 'STALE_SCREENSHOT' | 'DEVIATION' | 'STALE_REF' | 'TIMEOUT' | 'NOT_FOUND' | 'UNSUPPORTED_ACTION' | 'ELEMENT_HIDDEN' | 'AMBIGUOUS' | 'ACTION_FAILED' | 'NOT_CONNECTED' | 'UNKNOWN';

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
  /** The rule applies only while this holds (the fence's code means nothing with no fence). */
  when?: () => boolean;
  outcome: 'refused' | 'failed';
  test: RegExp;
  /** Look at the whole text, not just its head (DEVIATION is appended after the tool's own text). */
  whole?: boolean;
  hint: string;
  /** A hint that depends on the surface (tool names differ) wins over `hint`. */
  hintFor?: Partial<Record<Surface, string>>;
  /** A call, or a function of the original result text (a concrete name taken from it, never a <placeholder>). */
  next?: Partial<Record<Surface, string | ((text: string) => string | undefined)>>;
}

const PAUSE = (msg: string): Record<Surface, string> => ({
  mcp: `system {"action":"pause_for_user","message":"${msg}"}`,
  agent: `ask_user {"message":"${msg}"}`,
});
const REREAD: Record<Surface, string> = { mcp: 'accessibility {"action":"compile_ui"}', agent: 'compile_ui {}' };

/**
 * `template` with NAME replaced, as a JSON string, by the name to click: the closest name a find miss listed ("did you
 * mean"), else the one the caller gave in `a11y invoke "…" missed`; undefined without either. A listed name is screen text,
 * so it only ever goes into the call as a quoted JSON string.
 */
function smartClickFor(text: string, template: string): string | undefined {
  // The result line is trusted text, and a listed name is screen text: quoted like any other (quoteScreenText), never raw.
  const clean = (n: string | undefined) => (n === undefined ? undefined : quoteScreenText(n).slice(1, -1));
  const name = /Closest names:\n<untrusted-screen-content>\n\[[^\]\n]+\] "(.{1,60}?)"(?:\n|<|$)/.exec(text)?.[1]
    ?? /\binvoke "([^"\n]{1,60})" missed/i.exec(text)?.[1];
  const safe = clean(name);
  return safe ? template.replace('NAME', JSON.stringify(safe)) : undefined;
}

/** First match wins: refusals before failures, specific before generic. */
const RULES: Rule[] = [
  // The test fence (core/fence.ts): the target is outside the processes this run is limited to.
  { code: 'FENCED', outcome: 'refused', test: /FENCED: /, when: fenceActive,
    hint: 'this run may only touch its own fixture windows; work in the window you were given' },
  { code: 'CONSENT_REQUIRED', outcome: 'refused', test: /needs one-time consent/i,
    hint: 'the user runs `clawdcursor consent --accept` once; no restart needed' },
  { code: 'KEYBOARD_OWNED', outcome: 'refused', test: /system dialog owns the keyboard/i,
    hint: 'a system dialog has the keyboard; answer or close it first', next: PAUSE('Close the system dialog that has the keyboard') },
  { code: 'SECURE_INPUT', outcome: 'refused', test: /secure input is on/i,
    hint: 'macOS sends keys and focus only to the app holding secure input (a password field); the user must leave that field',
    next: PAUSE('Leave the password field in <App>') },
  { code: 'SCREEN_LOCKED', outcome: 'refused', test: /screen is locked/i,
    hint: 'the screen is locked', next: PAUSE('Unlock the screen') },
  { code: 'CAPTURE_DENIED', outcome: 'refused', test: /screen recording permission denied/i,
    hint: 'the screen cannot be captured until the user grants Screen Recording; tools that do not capture still work',
    next: PAUSE('Grant Screen Recording to the app running clawdcursor (System Settings → Privacy & Security), then click Resume') },
  { code: 'VISION_DISABLED', outcome: 'refused', test: /vision is disabled on this server/i,
    hint: 'high-security mode: no screenshot goes to the model; read the screen without one', next: REREAD },
  { code: 'OWN_UI', outcome: 'refused', test: /is clawdcursor's own on-screen control/i,
    hint: 'that is the user\'s pill; target the app instead', next: REREAD },
  { code: 'PAUSED', outcome: 'refused', test: /a pause is waiting for the user on screen/i,
    hint: 'the user has not answered the pause yet; wait, do not act' },
  { code: 'STOPPED', outcome: 'refused', test: /stopped by the user — they took control back/i,
    hint: 'the user stopped clawdcursor; nothing runs until their Resume gives control back',
    next: PAUSE('<what you want to do next>') },
  { code: 'FOREGROUND_CHANGED', outcome: 'refused', test: /an AI assistant — nothing was sent|the app this agent runs in \(.*\) — nothing was sent/i,
    hint: 'the window in front is an AI assistant, not your target; focus your target window first',
    next: { mcp: 'window {"action":"list"}', agent: 'list_windows {}' } },
  { code: 'FOREGROUND_CHANGED', outcome: 'refused', test: /foreground changed: /i,
    hint: 'the window in front is not the one you were working in; nothing was sent',
    next: { mcp: 'window {"action":"focus","processName":"<your app>"}', agent: 'focus_window {"processName":"<your app>"}' } },
  { code: 'DANGEROUS_KEY', outcome: 'refused', test: /dangerous key combo/i,
    hint: 'it locks the screen or ends the session, so it is never sent; every other shortcut is allowed', next: PAUSE('Please <do this step> yourself') },
  { code: 'DEVIATION', outcome: 'failed', test: /\nDEVIATION: /, whole: true,
    hint: 'it ran but the expected effect was not seen; read the screen before retrying, it may have taken', next: REREAD },
  { code: 'STALE_SCREENSHOT', outcome: 'refused',
    test: /an older screenshot|none has been taken|was not on screenshot s\d+ is in front/i,
    hint: 'the screen changed since the screenshot these coordinates came from; nothing was clicked',
    hintFor: {
      mcp: 'the screen changed since the screenshot these coordinates came from; nothing was clicked; if the target has a label, use accessibility smart_click instead of a new screenshot',
      agent: 'the screen changed since the screenshot these coordinates came from; nothing was clicked; if the target has a label, use smart_click instead of a new screenshot',
    },
    next: { mcp: 'computer {"action":"screenshot"}', agent: 'screenshot {}' } },
  { code: 'STALE_REF', outcome: 'failed', test: /ref rejected|unknown snapshot|snapshot .*(?:expired|stale)|call compile_ui first/i,
    hint: 'the screen changed since that snapshot; take a fresh one', next: REREAD },
  { code: 'READBACK_MISMATCH', outcome: 'failed', test: /but the field shows .* — Return not pressed/i,
    hint: 'the field does not show exactly what was typed, so it was not submitted; check it — press Return if it is right, fix it if not', next: REREAD },
  // A set / replace whose field holds something else: old text that was not cleared ("10030" for "30"), or a reformat.
  { code: 'READBACK_MISMATCH', outcome: 'failed', test: /the field shows .*, not the (?:value|text) asked for/i,
    hint: 'the field holds the text quoted in the result, not what was asked for: this call did not replace its old text, and the same call will not either; select the old text in the field (double-click or triple-click it), then type', next: REREAD },
  // A set that did nothing: the field can be read, and it is still empty.
  { code: 'READBACK_MISMATCH', outcome: 'failed', test: /the field still shows nothing, not the value asked for/i,
    hint: 'the field can be read and is still empty: the set did not reach it, and the same call will not either; click the field, then type', next: REREAD },
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
  // The element WAS found; this verb does not apply to it ("TogglePattern not supported", "element cannot expand or collapse").
  // Before NOT_FOUND: an invoke miss is worded "missed — <reason>", and the reason decides which of the two it is.
  // Found, but the element is switched off: no verb and no click at its bounds will do anything.
  { code: 'UNSUPPORTED_ACTION', outcome: 'failed',
    test: /element is (?:not enabled|disabled)/i,
    hint: 'found it, but it is disabled; the app has to enable it first (a required field, a selection), read its state',
    next: { mcp: 'accessibility {"action":"state","name":"<name>"}', agent: 'get_element_state {"name":"<name>"}' } },
  // Found, and the invoke itself threw: it may have acted before it threw, so do not repeat it or click the same spot.
  { code: 'UNSUPPORTED_ACTION', outcome: 'failed',
    test: /Invoke failed:/i,
    hint: 'found it, but the invoke threw; it may have taken effect, read the screen before trying again',
    next: REREAD },
  // First the activation cascade that tried EVERY verb (invoke, toggle, select, expand) and none took: suggesting those verbs
  // again would loop, so the next step is a click at the element's bounds.
  { code: 'UNSUPPORTED_ACTION', outcome: 'failed',
    test: /no (?:invoke|click)\/\w+(?:\/\w+)* pattern|does not support (?:AXPress|click\(\))|exposes no Action interface/i,
    hint: 'found it, but no activation (invoke / toggle / select / expand) takes on it; it is on screen, so click it at its bounds',
    next: { mcp: 'computer {"action":"click","x":<x>,"y":<y>,"space":"screen"} (bounds: accessibility find)', agent: 'click {"x":<x>,"y":<y>,"space":"screen"} (bounds: find_element)' } },
  // One verb that does not fit this element ("TogglePattern not supported", "cannot expand or collapse").
  { code: 'UNSUPPORTED_ACTION', outcome: 'failed',
    test: /Pattern not supported|element (?:cannot|can't|does not|doesn't) (?:expand|collapse|be (?:toggled|selected|set))|element does not support (?:expand|collapse|toggle|select|AXScrollToVisible)|exposes (?:no|neither) (?:EditableText|Value)|no Selection interface/i,
    hint: 'found it, but it cannot be done that way (toggled / selected / set / expanded); try invoke / expand / toggle / select, or read its state',
    next: { mcp: 'accessibility {"action":"state","name":"<name>"}', agent: 'get_element_state {"name":"<name>"}' } },
  // Found, but not on screen / the action itself failed: not "the name may differ".
  { code: 'ELEMENT_HIDDEN', outcome: 'failed', test: /the element exists but is not visible on screen/i,
    hint: 'found, but not visible on screen — scroll it into view or open its container', next: REREAD },
  // Found more than once: which one is the caller's to say. The list is in the result.
  { code: 'AMBIGUOUS', outcome: 'failed', test: /elements on screen match that name, nothing was done/i,
    hint: 'several elements have that name; pass controlType to name one, or click the position of the one you mean',
    next: { mcp: 'computer {"action":"click","x":<x>,"y":<y>,"space":"screen"} (a position inside the one you mean)', agent: 'click {"x":<x>,"y":<y>,"space":"screen"} (a position inside the one you mean)' } },
  { code: 'ACTION_FAILED', outcome: 'failed', test: /missed — the action failed/i,
    hint: 'found, but the action failed', next: REREAD },
  // A window that is not there: list the windows, then focus one.
  { code: 'NOT_FOUND', outcome: 'failed',
    test: /no (?:open )?window (?:matching|named)|no (?:open )?window (?:or running app )?(?:matches|belongs to)|no window has a title containing|no window for that process|window not found|no window found for process|no matching window|failed to focus: no matching/i,
    hint: 'no such window; list the windows to see what is open',
    next: { mcp: 'window {"action":"list"}', agent: 'list_windows {}' } },
  // An invoke that found no element of that name: the label may be drawn (canvas, image, custom UI) rather than exposed, and
  // smart_click finds text by OCR. The name is the one the caller gave; without it there is nothing concrete to put in the call.
  { code: 'NOT_FOUND', outcome: 'failed',
    test: /\binvoke\b[^\n]{0,80}missed — element not found/i,
    hint: 'no element has that name; the label may be drawn, not exposed',
    next: {
      mcp: t => smartClickFor(t, 'accessibility {"action":"smart_click","target":NAME}') ?? REREAD.mcp,
      agent: t => smartClickFor(t, 'smart_click {"target":NAME}') ?? REREAD.agent,
    } },
  // A find that matched nothing but listed close names: the first of them is the likely target.
  { code: 'NOT_FOUND', outcome: 'failed',
    test: /no element named "" among the \d+ named elements in this window\. closest names/i,
    hint: 'no element has that name; a close name is listed, the label may also be drawn, not exposed',
    next: {
      mcp: t => smartClickFor(t, 'accessibility {"action":"smart_click","target":NAME}') ?? REREAD.mcp,
      agent: t => smartClickFor(t, 'smart_click {"target":NAME}') ?? REREAD.agent,
    } },
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
  accessibility: new Set(['invoke', 'focus', 'set_value', 'expand', 'collapse', 'toggle', 'select',
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

/**
 * Calls whose effect only a check can vouch for: `[unverified]` means something for these. Not for a scroll, hover, key
 * hold, focus, maximize or clipboard write: nothing there is left to confirm, and a line that always says "unverified" is
 * noise a model learns to skip.
 */
const UNVERIFIABLE: Record<string, ReadonlySet<string>> = {
  computer: new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'type', 'key', 'key_press', 'drag', 'drag_path']),
  accessibility: new Set(['invoke', 'set_value', 'toggle', 'select', 'smart_click', 'smart_type']),
  window: new Set(['close', 'open_app', 'open_file', 'open_url']),
  system: new Set(['open_uri', 'open_app', 'open_file', 'open_url', 'shortcuts_run', 'undo']),
  browser: new Set(['click', 'type', 'select_option']),
};
export function isUnverifiableAction(compound: string, action: string | undefined): boolean {
  return !!action && !!UNVERIFIABLE[compound]?.has(action);
}

const HEAD = 400;

/**
 * Text the screen controls (a window title, an element name) must not steer the classification: a window titled "the screen
 * is locked" would turn any miss into SCREEN_LOCKED. Producers quote such text with quoteScreenText (or put it in an
 * <untrusted-screen-content> block); the classifier reads the result with quoted spans, `key='value'` spans and untrusted
 * blocks blanked out, so only clawdcursor's own words are matched.
 */
export function quoteScreenText(s: string): string {
  // The block delimiters are defused too: a name carrying a closing delimiter would otherwise pair with a real block.
  const defused = defuseScreenDelimiters(String(s ?? ''));
  return `"${defused.replace(/["\r\n]+/g, "'")}"`;
}
function ownWords(text: string): string {
  return text
    .replace(/<untrusted-screen-content>[\s\S]*?<\/untrusted-screen-content>/g, ' ')
    .replace(/"[^"\n]*"/g, '""')
    .replace(/\b(\w+)='[^'\n]*'/g, "$1=''");
}

/**
 * Classify a result. `acting`: the call has an effect only a check can vouch for (a click, typing, a launch), so a success
 * nothing checked is `unverified`. `changes`: the call changes something without being worth an `unverified` line (a focus,
 * a maximize): it still gets `confirmed` when a check on it passed. A read gets no outcome.
 */
export function classifyResult(text: string, isError: boolean, acting: boolean, surface: Surface = 'mcp', changes = acting): ResultClass | null {
  if (isError) {
    const own = ownWords(text);
    const head = own.slice(0, HEAD);
    const r = RULES.find(rule => (!rule.when || rule.when()) && rule.test.test(rule.whole ? own : head));
    if (r) {
      const n = r.next?.[surface];
      return { outcome: r.outcome, code: r.code, hint: r.hintFor?.[surface] ?? r.hint, next: typeof n === 'function' ? n(text) : n };
    }
    return { outcome: 'failed', code: 'UNKNOWN', hint: 'read the screen, then try another way', next: REREAD[surface] };
  }
  // A success is never classified by its words: a page's text can say "not found" or "timed out" as content.
  if (!acting && !changes) return null;
  // The checks' own wording, at their own positions: a body that happens to contain "VERIFIED" on some line is not one.
  // Only where the checks write them, so nothing inside a result (typed text, a page, a window title) can pose as one:
  // `expect`'s verdict is appended at the very end; `verify` starts its reply; a typing read-back sits in the leading
  // "Typed N chars (…)" before any quoted text; a toggle / select / set writes `Toggled|Selected|Set (read back ✓)` before the
  // quoted element name, which is screen text.
  if (/ — verified \d+ check\(s\)$/.test(text) || /^VERIFIED:/.test(text) || /^Typed \d+ chars \((?:keys|paste), read back ✓\)/.test(text)
    || /^(?:Toggled|Selected|Set) \(read back ✓\) "/.test(text)
    || /^Invoked \(read back ✓\) "/.test(text)) {
    return { outcome: 'confirmed' };
  }
  // Nothing checked it. Only calls with an effect to check say so.
  if (!acting) return null;
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
