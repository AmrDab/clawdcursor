/**
 * SafetyLayer — unified gate for every agent action (v0.8.1 rebuild).
 *
 * v0.8.0's `src/safety.ts` classified only by description-string match, which
 * the audit correctly flagged as trivially bypassable (a `mouse_click(x,y)` on
 * a Send button never contains the word "send"). V2 orchestrator didn't call
 * SafetyLayer at all, and the `/action` REST endpoint bypassed it entirely.
 *
 * v0.8.1 fixes the chokepoint problem:
 *  - Pure function `evaluate(action, context) → Decision` keyed on the ACTION
 *    TYPE, not on description prose. A mouse_click on a button whose OCR
 *    label matches a Confirm-tier pattern elevates to Confirm. A key combo
 *    in BLOCKED_KEYS returns Block.
 *  - Registry-driven coverage test (`safety-coverage.test.ts`) enforces
 *    that every MCP tool handler invokes `evaluate` before its first side
 *    effect.
 *  - Decision is observable via the audit log (`safety.decision` events).
 *
 * Model-agnostic: no LLM calls. Pure rule engine.
 */

import { keyBlockMatch, keyBlockReason } from '../tools/playbooks/keys-blocklist';
import { logger } from './observability/logger';
import { getCorrelationId } from './observability/correlation';
import { SENSITIVE_APPS_PATTERN as SENSITIVE_APPS } from './app-categories';

/**
 * URI schemes that only COMPOSE or NAVIGATE — they open a draft/app/page but
 * cannot execute code, delete data, or COMPLETE an irreversible action without
 * a further user step (you still have to hit send/call). Safe to open without
 * confirmation. Everything NOT listed keeps the confirm gate, deliberately:
 *  • file:                  — on Windows can launch an executable.
 *  • vscode/vscode-insiders — vscode:// is an extension/workspace execution
 *    surface (Remote SSH, workspace tasks, git clone, ext sub-commands).
 *  • obsidian               — obsidian://advanced-uri can run plugin/shell cmds.
 *  • zoommtg/msteams        — auto-JOIN a meeting (mic/camera) — completes an
 *    action; not mere navigation.
 *  • any unknown custom scheme — handler is unvetted.
 * (Security audit 2026-06-08 trimmed vscode/obsidian/zoommtg/msteams.)
 */
const BENIGN_URI_SCHEMES = new Set<string>([
  'mailto', 'tel', 'sms', 'smsto', 'facetime', 'facetime-audio',
  'webcal', 'http', 'https', 'slack', 'spotify',
  // ms-settings: NAVIGATES to a Settings page (like https) — opening the page
  // changes nothing; the user still has to act. Unblocks "open <X> settings".
  'ms-settings',
]);

function uriSchemeOf(uri: unknown): string {
  const m = String(uri ?? '').trim().match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : '';
}

export type Tier = 'read' | 'input' | 'destructive' | 'system';

export type Decision =
  | { decision: 'allow'; tier: Tier }
  | { decision: 'confirm'; tier: Tier; reason: string }
  | { decision: 'block'; tier: Tier; reason: string };

// ── PR6: canonical SafetyDecision + evaluate() signature ────────────────────

/**
 * Numeric safety tier used on `ToolDefinition.safetyTier` and returned by
 * the PR6 canonical `evaluate()` signature.
 *
 *   0 — read-only  (screenshot, a11y snapshot …)
 *   1 — neutral    (click, type, scroll — reversible)
 *   2 — mutation   (close_window, write_clipboard …)
 *   3 — destructive (cdp_evaluate, relaunch_with_cdp …)
 */
export type NumericTier = 0 | 1 | 2 | 3;

/**
 * Canonical safety decision returned by every call site.
 *
 * - `allow: true`  → proceed.
 * - `allow: false` → block or ask for confirmation; inspect `suggestedAction`.
 */
export interface SafetyDecision {
  allow: boolean;
  reason?: string;
  suggestedAction?: 'block' | 'warn' | 'proceed';
  tier: NumericTier;
}

// ── Conversions ──────────────────────────────────────────────────────────────

/** Map the legacy string Tier to a numeric tier. */
function tierToNumeric(t: Tier): NumericTier {
  switch (t) {
    case 'read':        return 0;
    case 'input':       return 1;
    case 'destructive': return 2;
    case 'system':      return 3;
  }
}

/** Map a numeric tier back to the legacy Tier string for internal rule engine. */
function numericToTierString(n: NumericTier): Tier {
  switch (n) {
    case 0: return 'read';
    case 1: return 'input';
    case 2: return 'destructive';
    case 3: return 'system';
  }
}

/** Convert the internal `Decision` to the canonical `SafetyDecision`. */
function toSafetyDecision(d: Decision): SafetyDecision {
  const tier = tierToNumeric(d.tier);
  if (d.decision === 'allow') {
    return { allow: true, tier, suggestedAction: 'proceed' };
  }
  if (d.decision === 'block') {
    return { allow: false, reason: d.reason, tier, suggestedAction: 'block' };
  }
  // confirm
  return { allow: false, reason: d.reason, tier, suggestedAction: 'warn' };
}

// ── End PR6 additions ────────────────────────────────────────────────────────

/** What the evaluator sees. Tool name is CANONICAL — not a description. */
export interface EvaluationContext {
  /** Canonical tool / action name (e.g. "mouse_click", "a11y_set_value"). */
  tool: string;
  /** Arbitrary args shape — typed by caller; evaluator pattern-matches safely. */
  args: Record<string, unknown>;
  /** Optional OCR label of the element the action targets, when known. */
  targetLabel?: string;
  /** Optional active app name — raises the tier for sensitive domains
   *  (email, banking, messaging, password managers). */
  activeApp?: string;
  /**
   * The natural-language task the user submitted to the agent. When the
   * target label appears verbatim in this text, the user has provided
   * explicit consent for this destructive action and we skip the confirm
   * tier. Without this field, all destructive matches require confirm
   * (current behaviour). Pattern-based; works for any model + any app.
   */
  userTaskText?: string;
  /**
   * PR6: explicit numeric safety tier from the tool definition. When
   * present, this overrides the TOOL_TIER name-lookup table so the gate
   * consults the tool's own declared tier rather than guessing from the
   * tool name string.
   */
  toolSafetyTier?: NumericTier;
}

/**
 * Patterns in a target element's OCR/a11y label that elevate the tier to
 * Confirm. Matched case-insensitively. Derived from v0.6.3 sensitive-app
 * policy + v0.8.0 audit findings.
 */
const CONFIRM_LABEL_PATTERNS: RegExp[] = [
  /\bsend\b/i,             // email, message, wire transfer
  /\bdelete\b/i,           // destructive
  /\bremove\b/i,
  /\btrash\b/i,
  /\berase\b/i,
  /\buninstall\b/i,
  /\bdrop\s+(database|table)/i,
  /\bshut\s*down\b/i,
  /\brestart\b/i,
  /\blog\s*out\b/i,
  /\bsign\s*out\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bcheckout\b/i,
  /\bpay\b/i,
  /\btransfer\b/i,
  /\bpublish\b/i,
  /\bconfirm\b/i,          // confirm dialogs themselves — require user
];

// Canonical tools that type ARBITRARY TEXT. Their text payload is content,
// not a control label, so CONFIRM_LABEL_PATTERNS must NOT run against it —
// otherwise typing a sentence that merely contains "confirm" / "send" / etc.
// spuriously trips the confirm gate (#124: "verification to confirm reliable
// desktop automation" elevated to destructive tier). This is a denylist, not
// an allowlist: any tool NOT listed here stays gated by default, so a future
// click/activation tool can never silently lose label-pattern coverage — the
// worst a missing entry can do is add benign friction, never remove safety.
const TYPING_TOOLS = new Set<string>(['type_text', 'cdp_type']);

// Sensitive-app list lives at src/core/app-categories.ts as the single
// source of truth — imported at the top of this file. Edit there, not here.

/** Tool name → default tier. */
const TOOL_TIER: Record<string, Tier> = {
  // Read — always allow
  'read_screen': 'read',
  'ocr_read_screen': 'read',
  'smart_read': 'read',
  'desktop_screenshot': 'read',
  'desktop_screenshot_region': 'read',
  'get_screen_size': 'read',
  'get_windows': 'read',
  'get_active_window': 'read',
  'get_focused_element': 'read',
  'find_element': 'read',
  'read_clipboard': 'read',
  'cdp_page_context': 'read',
  'cdp_read_text': 'read',
  'cdp_list_tabs': 'read',
  'browser_read': 'read',       // agent-loop CDP read — DOM text/elements, no side effects
  'shortcuts_list': 'read',
  'build_uri': 'read',          // pure string construction — no side effects
  // Input — allow with label check
  'mouse_click': 'input',
  'mouse_double_click': 'input',
  'mouse_right_click': 'input',
  'mouse_hover': 'input',
  'mouse_scroll': 'input',
  'mouse_drag': 'input',
  'type_text': 'input',
  'smart_type': 'input',
  'smart_click': 'input',
  'invoke_element': 'input',
  'key_press': 'input',
  'write_clipboard': 'destructive',  // matches its declared safetyTier:2 (overwrites the user's clipboard); the tool's own tier already wins, this keeps the fallback consistent
  'cdp_click': 'input',
  'cdp_type': 'input',
  'cdp_select_option': 'input',
  'cdp_scroll': 'input',
  'cdp_wait_for_selector': 'input',
  'cdp_switch_tab': 'input',
  'cdp_connect': 'input',
  // Agent-loop CDP browser tools (dedicated agent-owned instance, DOM-driven).
  'browser_connect': 'input',
  'browser_navigate': 'input',
  'browser_click': 'input',
  'browser_type': 'input',
  'navigate_browser': 'input',
  'focus_window': 'input',
  'minimize_window': 'input',
  'shortcuts_execute': 'input',
  // System — always confirm (or block)
  'cdp_evaluate': 'system',
  'open_app': 'input',
  'wait': 'read',
  'delegate_to_agent': 'input',
  // Pipeline-internal actions
  'a11y_click': 'input',
  'a11y_set_value': 'input',
  'click': 'input',
  'type': 'input',
  'press': 'input',
  'scroll': 'input',
  'drag': 'input',
  'move': 'input',     // hover — cursor move only, no click/keys
  'screenshot': 'read',
  'read_text': 'read',     // OCR perception — no side effects (smart_click already mapped above)
  // `batch` is an inert wrapper — it gates EACH of its steps through this same
  // evaluator at runtime, so the wrapper call itself is allow-tier.
  'batch': 'read',
  'done': 'read',
  'give_up': 'read',
  'cannot_read': 'read',
  // Tranche 1B — new MCP tools (extras.ts)
  'mouse_move_relative': 'input',
  'mouse_middle_click': 'input',
  'mouse_triple_click': 'input',
  'mouse_down': 'input',
  'mouse_up': 'input',
  'mouse_scroll_horizontal': 'input',
  'mouse_drag_stepped': 'input',
  'key_down': 'input',
  'key_up': 'input',
  'maximize_window': 'input',
  'minimize_window_to_taskbar': 'input',
  'restore_window': 'input',
  'close_window': 'destructive',    // polite request, but the user may not want this on autopilot
  'resize_window': 'input',
  'list_displays': 'read',
  'focus_element': 'input',
  'wait_for_element': 'read',
  'open_file': 'input',
  'open_url': 'input',
  'get_system_time': 'read',
  'switch_tab_os': 'input',
  'undo_last': 'input',
  // Tranche 2 — a11y depth tools
  'a11y_expand': 'input',
  'a11y_collapse': 'input',
  'a11y_toggle': 'input',
  'a11y_select': 'input',
  'a11y_get_element': 'read',
  'a11y_get_value': 'read',
  'verify': 'read',   // harness-executed assertions — read primitives only
  'compile_ui': 'read',  // compiles a11y+OCR+vision into a fused UI map — no side effects
  'find_action_button': 'read',  // semantic finder — no side effects
  'find_input_field': 'read',    // semantic finder — no side effects
  'get_element_state': 'read',
  'a11y_list_children': 'read',
  // v0.8.2 — Electron/WebView2 bridge tools
  'detect_webview_apps': 'read',
  'relaunch_with_cdp': 'destructive',  // closes the app — app may prompt to save
  // URI escape hatch + guide-write — match their granular safetyTier (2).
  'open_uri': 'destructive',    // dispatches to an arbitrary registered handler (file: can execute)
  'learn_app': 'destructive',   // writes a guide to ~/.clawdcursor
  // Tranche 3 — compact compound MCP surface. When an agent calls one of
  // these, the real action is decided by the `action` arg (already
  // unpacked above via unpackCompoundTool for the unified-agent compound
  // tools: mouse/keyboard/window). These public-MCP names share the
  // same canonicalization philosophy — tier defaults to 'input' and the
  // delegated granular tool's tier kicks in during actual dispatch.
  'computer': 'input',
  'accessibility': 'read',
  'window': 'input',
  'system': 'input',
  'browser': 'input',
  'task': 'input',
};

/**
 * Map a compound-tool call (Tranche 2.5 vision agent) to its canonical
 * granular name for tier lookup. `mouse({action:"click"})` resolves to
 * `mouse_click`, `keyboard({action:"press"})` to `key_press`, etc.
 *
 * Without this, compound tools default to 'input' tier because
 * `TOOL_TIER` is keyed on the canonical names. The mapping keeps the
 * existing tier map as the single source of truth — no compound-specific
 * tier entries needed.
 */
function unpackCompoundTool(tool: string, args: Record<string, unknown>): string {
  // Tranche 3 public-MCP compound tools: computer/accessibility/window/
  // system/browser/task. These are dispatched inside compact.ts and the
  // granular delegate handles the real action — but for the audit log
  // we want to surface the granular name here so forensic trails make
  // sense. Mapping mirrors compact.ts's ACTION_MAP tables.
  const publicCompoundMap: Record<string, Record<string, string>> = {
    computer: {
      screenshot: 'desktop_screenshot', screenshot_region: 'desktop_screenshot_region',
      click: 'mouse_click', double_click: 'mouse_double_click', right_click: 'mouse_right_click',
      middle_click: 'mouse_middle_click', triple_click: 'mouse_triple_click',
      hover: 'mouse_hover', move: 'mouse_hover', move_relative: 'mouse_move_relative',
      scroll: 'mouse_scroll', scroll_horizontal: 'mouse_scroll_horizontal',
      drag: 'mouse_drag', drag_path: 'mouse_drag_stepped',
      mouse_down: 'mouse_down', mouse_up: 'mouse_up',
      type: 'type_text', key: 'key_press', key_press: 'key_press',
      key_down: 'key_down', key_up: 'key_up', wait: 'wait',
    },
    accessibility: {
      read_tree: 'read_screen', find: 'find_element', get_element: 'a11y_get_element',
      focused: 'get_focused_element', invoke: 'invoke_element', focus: 'focus_element',
      set_value: 'set_field_value', get_value: 'a11y_get_value',
      expand: 'a11y_expand', collapse: 'a11y_collapse',
      toggle: 'a11y_toggle', select: 'a11y_select', state: 'get_element_state',
      list_children: 'a11y_list_children', wait_for: 'wait_for_element',
      smart_click: 'smart_click', smart_type: 'smart_type', smart_read: 'smart_read',
    },
    window: {
      list: 'get_windows', active: 'get_active_window', focus: 'focus_window',
      maximize: 'maximize_window', minimize: 'minimize_window_to_taskbar',
      restore: 'restore_window', close: 'close_window', resize: 'resize_window',
      list_displays: 'list_displays', screen_size: 'get_screen_size',
      open_app: 'open_app', open_file: 'open_file', open_url: 'open_url',
      switch_tab: 'switch_tab_os', navigate: 'navigate_browser',
    },
    system: {
      clipboard_read: 'read_clipboard', clipboard_write: 'write_clipboard',
      system_time: 'get_system_time', ocr: 'ocr_read_screen', undo: 'undo_last',
      shortcuts_list: 'shortcuts_list', shortcuts_run: 'shortcuts_execute',
      delegate: 'delegate_to_agent',
      // v0.8.2
      detect_webview: 'detect_webview_apps',
      relaunch_with_cdp: 'relaunch_with_cdp',
      // URI escape hatches + guide-write (added to the compound surface)
      build_uri: 'build_uri', open_uri: 'open_uri', learn_app: 'learn_app',
    },
    browser: {
      connect: 'cdp_connect', page_context: 'cdp_page_context', read_text: 'cdp_read_text',
      click: 'cdp_click', type: 'cdp_type', select_option: 'cdp_select_option',
      evaluate: 'cdp_evaluate', wait_for: 'cdp_wait_for_selector',
      list_tabs: 'cdp_list_tabs', switch_tab: 'cdp_switch_tab', scroll: 'cdp_scroll',
      navigate: 'navigate_browser',
    },
  };
  const actionArg = typeof args.action === 'string' ? args.action : '';
  if (tool in publicCompoundMap && actionArg) {
    const mapped = publicCompoundMap[tool][actionArg];
    if (mapped) return mapped;
  }
  if (tool === 'task') return 'delegate_to_agent';

  if (tool !== 'mouse' && tool !== 'keyboard' && tool !== 'window') return tool;
  const action = typeof args.action === 'string' ? args.action : '';

  if (tool === 'mouse') {
    switch (action) {
      case 'click':         return 'mouse_click';
      case 'double_click':  return 'mouse_double_click';
      case 'right_click':   return 'mouse_right_click';
      case 'middle_click':  return 'mouse_middle_click';
      case 'triple_click':  return 'mouse_triple_click';
      case 'move':
      case 'hover':         return 'mouse_hover';
      case 'move_relative': return 'mouse_move_relative';
      case 'down':          return 'mouse_down';
      case 'up':            return 'mouse_up';
      case 'scroll':        return 'mouse_scroll';
      case 'drag':          return 'mouse_drag';
      case 'drag_stepped':  return 'mouse_drag_stepped';
      default:              return 'mouse_click'; // safe default
    }
  }
  if (tool === 'keyboard') {
    switch (action) {
      case 'press': return 'key_press';
      case 'down':  return 'key_down';
      case 'up':    return 'key_up';
      case 'type':  return 'type_text';
      default:      return 'key_press';
    }
  }
  // window
  switch (action) {
    case 'focus':         return 'focus_window';
    case 'maximize':      return 'maximize_window';
    case 'minimize':      return 'minimize_window';
    case 'restore':       return 'restore_window';
    case 'close':         return 'close_window';
    case 'resize':        return 'resize_window';
    case 'list':          return 'get_windows';
    case 'list_displays': return 'list_displays';
    default:              return 'focus_window';
  }
}

/**
 * Evaluate an action. Pure function — no side effects other than the
 * `safety.decision` audit log.
 *
 * When `ctx.toolSafetyTier` is provided (set from `ToolDefinition.safetyTier`),
 * it overrides the TOOL_TIER name-lookup for the base tier so the gate
 * uses the tool's own declared tier rather than guessing from the name.
 * Blocked-key and cdp_evaluate checks still run unconditionally.
 */
export function evaluate(ctx: EvaluationContext): Decision {
  // Unpack compound tool calls (vision agent's mouse/keyboard/window)
  // into the canonical granular name so tier lookup hits the same map
  // that drives granular tools.
  const canonicalTool = unpackCompoundTool(ctx.tool, ctx.args);
  // PR6: prefer the tool's declared safetyTier; fall back to name lookup.
  // IMPORTANT: when the surface tool is a compound (canonicalTool !== ctx.tool),
  // the specific action may map to a HIGHER tier than the surface default
  // (e.g. browser({action:'evaluate'}) → cdp_evaluate → 'system'). In that
  // case we always use the canonical TOOL_TIER so the compound unpack works
  // correctly. The toolSafetyTier override only applies to granular tools where
  // no further unpacking occurs.
  const isCompoundUnpacked = canonicalTool !== ctx.tool;
  const tier: Tier = (!isCompoundUnpacked && ctx.toolSafetyTier !== undefined)
    ? numericToTierString(ctx.toolSafetyTier)
    : (TOOL_TIER[canonicalTool] ?? 'input');
  const correlationId = getCorrelationId();

  const emit = (decision: Decision) => {
    // When a compound tool was unpacked, log BOTH names so the audit
    // trail shows the canonical action (for tier forensics) and the
    // surface tool the LLM actually called (for debugging).
    const logMeta: Record<string, unknown> = { tool: ctx.tool, ...decision, correlationId };
    if (canonicalTool !== ctx.tool) logMeta.canonicalTool = canonicalTool;
    logger.info('safety.decision', logMeta);
    return decision;
  };

  // 1. Keyboard combos: if blocked, reject immediately.
  //
  //    Detection is by ARG SHAPE, not tool name. The gate used to list four
  //    names (key_press/press/key_press/key_down); the autonomous agent loop
  //    registers its keyboard tool as `key` and gates on `tool: call.name`, so
  //    every blocked combo fell through to the default allow on that path —
  //    and `key` is not in TOOL_TIER either (GHSA-35pc-g74h-p476, defect 1).
  //    Any call carrying a combo/key STRING is a keyboard call whatever the
  //    surface named it, which also survives the next rename. Verified: every
  //    `key`/`combo` arg in the tree belongs to a keyboard tool, so this
  //    cannot capture a non-keyboard surface.
  const combo = typeof ctx.args.combo === 'string' ? ctx.args.combo
    : typeof ctx.args.key === 'string' ? ctx.args.key : undefined;
  if (combo !== undefined) {
    // Sequence-aware: keyBlockMatch checks each whitespace-separated element
    // as well as the collapsed whole, and names the offending element.
    const match = keyBlockMatch(combo);
    // HARD block (lock/force-quit/shutdown) has no path; consequential combos
    // (close window/tab, show desktop, launchers) are confirm-able instead of
    // dead-ended (v1.6.0 — the old list hard-blocked win+d/ctrl+w).
    if (match?.tier === 'block') {
      return emit({ decision: 'block', tier: 'destructive', reason: keyBlockReason(match.combo, 'block') });
    }
    if (match?.tier === 'confirm') {
      return emit({ decision: 'confirm', tier: 'destructive', reason: keyBlockReason(match.combo, 'confirm') });
    }
  }

  // 2. cdp_evaluate is ungated in v0.8.0 (audit C5). Require Confirm here;
  // full allowArbitraryJs config gate lands in v0.8.2.
  if (ctx.tool === 'cdp_evaluate') {
    return emit({
      decision: 'confirm',
      tier: 'system',
      reason: 'cdp_evaluate runs arbitrary JS in the active page — requires user approval',
    });
  }

  // 2b. open_uri tier is SCHEME-dependent. Benign compose/navigate schemes
  //     (mailto/tel/sms/webcal/http/https/...) cannot execute or delete — allow.
  //     file: (executes on Windows) and unknown custom schemes keep the confirm
  //     gate. This unblocks the OS URI escape hatches for headless runs without
  //     weakening the gate against executing/unknown handlers.
  if (canonicalTool === 'open_uri') {
    const scheme = uriSchemeOf(ctx.args.uri);
    if (BENIGN_URI_SCHEMES.has(scheme)) {
      return emit({ decision: 'allow', tier: 'input' });
    }
    return emit({
      decision: 'confirm',
      tier: 'destructive',
      reason: scheme
        ? `open_uri to "${scheme}:" — handler may execute or be destructive (e.g. file: can run a program); needs confirmation`
        : 'open_uri with no/invalid scheme — needs confirmation',
    });
  }

  // 3. Read tier: always allow.
  if (tier === 'read') {
    return emit({ decision: 'allow', tier });
  }

  // 4. System tier: always confirm (catch-all).
  if (tier === 'system') {
    return emit({ decision: 'confirm', tier, reason: `${ctx.tool} is a system-tier action` });
  }

  // 4b. Destructive tier: confirm. Matches the tool-registry tag for
  //     explicitly-destructive verbs (close_window, etc.) so the gate
  //     fires even when there's no label match.
  if (tier === 'destructive') {
    return emit({ decision: 'confirm', tier, reason: `${ctx.tool} is a destructive-tier action` });
  }

  // 5. Input tier with a Confirm-pattern target label.
  //    Skip for typing tools: their `targetLabel` is the text being typed
  //    (content), not the label of a control being activated. Clicking a
  //    button labelled "Send"/"Delete" is destructive; typing those words
  //    into a field is not. See TYPING_TOOLS above (#124).
  if (ctx.targetLabel && !TYPING_TOOLS.has(canonicalTool)) {
    for (const pattern of CONFIRM_LABEL_PATTERNS) {
      if (pattern.test(ctx.targetLabel)) {
        // Intent-matched bypass: if the user's task text contains the
        // target label (case-insensitive, word-bounded) AND the same
        // confirm-pattern fires on that task text, the user has given
        // explicit consent for this exact destructive action. Examples:
        //   task="hit send" + target="Send"   → bypass
        //   task="delete the row" + target="Delete" → bypass
        //   task="open my inbox" + target="Send" → confirm (no intent match)
        // This keeps the safety layer protective against hallucinated
        // destructive clicks while letting legitimate user-requested
        // actions through. Pattern-matched, not model-specific.
        if (ctx.userTaskText && pattern.test(ctx.userTaskText)) {
          logger.info('safety.intent_match.bypass', {
            tool: ctx.tool,
            targetLabel: ctx.targetLabel,
            pattern: pattern.source,
            correlationId,
          });
          return emit({ decision: 'allow', tier: 'input' });
        }
        return emit({
          decision: 'confirm',
          tier: 'destructive',
          reason: `target "${ctx.targetLabel}" matches destructive pattern ${pattern.source}`,
        });
      }
    }
  }

  // 6. Sensitive-app elevation: clicks/typing inside email/banking/messaging
  //    apps. The previous implementation here only LOGGED — the code comment
  //    promised elevation but the function fell through to allow. That left
  //    a real gap: an agent could click anywhere in Outlook / 1Password /
  //    Mail with no target label and the safety layer treated it as a
  //    plain Input action.
  //
  //    New policy:
  //      - Sensitive app + click-family tool + NO/EMPTY target label
  //        → `confirm` (we can't tell if this lands on "Send" / "Delete")
  //      - Sensitive app + click-family tool + non-destructive target label
  //        → allow (e.g. invoke_element name="Reply" is fine; destructive
  //          target names are already caught by step 5 above)
  //      - Sensitive app + non-click tool (read, screenshot, focus, etc.)
  //        → allow (reads stay free)
  if (ctx.activeApp && SENSITIVE_APPS.test(ctx.activeApp)) {
    const clickFamily = ['smart_click', 'cdp_click', 'mouse_click', 'a11y_click', 'click', 'invoke_element'];
    if (clickFamily.includes(ctx.tool)) {
      const labelEmpty = !ctx.targetLabel || String(ctx.targetLabel).trim().length === 0;
      if (labelEmpty) {
        logger.debug('safety.sensitive_app.elevated', { app: ctx.activeApp, tool: ctx.tool, correlationId });
        return emit({
          decision: 'confirm',
          tier: 'destructive',
          reason: `Sensitive app (${ctx.activeApp}) + ${ctx.tool} with no target label — cannot verify the action isn't destructive (Send/Delete/Transfer). Ask the user.`,
        });
      }
      // Has a label and it didn't match a destructive pattern in step 5 — let it through.
      logger.debug('safety.sensitive_app.allowed_with_label', { app: ctx.activeApp, tool: ctx.tool, label: ctx.targetLabel, correlationId });
    }
  }

  // 7. Default allow at input tier.
  return emit({ decision: 'allow', tier });
}

/**
 * Convenience predicate. Returns true if the decision allows the action to
 * proceed without user confirmation.
 */
export function isAllowed(d: Decision): boolean {
  return d.decision === 'allow';
}

// ── PR6: canonical evaluate() signature ─────────────────────────────────────

/**
 * Canonical single safety gate used by every call site (PR6).
 *
 * Accepts the PR6 interface shape:
 *   { toolName, args, ctx? }
 *
 * Returns a `SafetyDecision` with `allow: boolean` so callers don't need to
 * inspect the legacy `decision` string.  The gate is the ONLY place that
 * decides allow/block — no inline `if (toolName === 'desktop_screenshot')`
 * branching anywhere else.
 *
 * Call sites:
 *   1. `src/core/agent-loop/agent.ts`  — agent loop, every tool call
 *   2. `src/tools/safety-gate.ts`      — MCP wrapper + REST execute middleware
 *
 * The `safetyTier` field is read from the tool's `ToolDefinition.safetyTier`
 * by the caller before passing here; when absent the gate falls back to the
 * internal TOOL_TIER name-lookup table.
 */
export function evaluateInput(input: {
  toolName: string;
  args: Record<string, unknown>;
  safetyTier?: NumericTier;
  ctx?: {
    targetLabel?: string;
    activeApp?: string;
    userIntent?: string;
  };
}): SafetyDecision {
  const legacyCtx: EvaluationContext = {
    tool: input.toolName,
    args: input.args,
    targetLabel: input.ctx?.targetLabel,
    activeApp: input.ctx?.activeApp,
    userTaskText: input.ctx?.userIntent,
    toolSafetyTier: input.safetyTier,
  };
  return toSafetyDecision(evaluate(legacyCtx));
}
