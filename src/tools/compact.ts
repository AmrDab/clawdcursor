/**
 * Compact MCP surface — 6 compound tools covering every granular
 * primitive, Anthropic-Computer-Use-style.
 *
 * Why this exists:
 *   An agent driving clawdcursor via MCP otherwise sees 97 granular
 *   tool schemas (~18,000 tokens of tool catalog). Most models
 *   over-think the choice, pick near-duplicates, and burn context.
 *   This file collapses the granular tools into 6 action-discriminated
 *   compound tools — the same "1 tool with N sub-actions" shape that
 *   Anthropic uses for computer_20250124.
 *
 *   Net effect: the LLM sees ~1,500 tokens of tool catalog, picks a
 *   COMPOUND first (which primitive SPACE do I want?), then an
 *   ACTION (which specific operation?), then fills in the args.
 *   Decision trees shrink, accuracy rises.
 *
 * The 6 compounds cover EXACTLY the granular tool set — no new
 * capability, no removed capability. Every compact action maps to
 * exactly one granular tool via the delegation table. The granular
 * surface stays available (same repo, same schemas); agents simply
 * pick which shape to consume.
 *
 * Selection:
 *   `clawdcursor mcp`             → 97 granular tools (back-compat)
 *   `clawdcursor mcp --compact`   → 6 compound tools (this file)
 *   GET /tools?mode=compact      → REST gets the same compact schemas
 *
 * Extending:
 *   Add a new granular tool → map it in the `ACTION_MAP` below under
 *   its owning compound. No other wiring needed; dispatcher picks it
 *   up automatically.
 */

import { getTool } from './registry';
import { getBatchTools } from './batch';
import { rewriteOutsideData } from './hint-rewrite';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

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
interface ActionRoute {
  action: string;
  delegate: string;
  argRemap?: Record<string, string>;
}

const COMPUTER_ACTIONS: ActionRoute[] = [
  // Perception
  { action: 'screenshot', delegate: 'desktop_screenshot' },
  { action: 'screenshot_region', delegate: 'desktop_screenshot_region' },
  { action: 'zoom',              delegate: 'desktop_screenshot_region' }, // alias (computer-use name)
  // Mouse
  { action: 'click',         delegate: 'mouse_click' },
  { action: 'double_click',  delegate: 'mouse_double_click' },
  { action: 'right_click',   delegate: 'mouse_right_click' },
  { action: 'middle_click',  delegate: 'mouse_middle_click' },
  { action: 'triple_click',  delegate: 'mouse_triple_click' },
  { action: 'hover',         delegate: 'mouse_hover' },
  { action: 'move',          delegate: 'mouse_hover' },       // alias
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
  { action: 'key',       delegate: 'key_press', argRemap: { combo: 'key' } },
  { action: 'key_press', delegate: 'key_press', argRemap: { combo: 'key' } },
  { action: 'key_down',  delegate: 'key_down',  argRemap: { combo: 'key' } },
  { action: 'key_up',    delegate: 'key_up',    argRemap: { combo: 'key' } },
  // Flow
  { action: 'wait',      delegate: 'wait' },
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
  // el_NN UI State Compiler (v1.5.0) — the flagship perception substrate. These
  // were granular-only, leaving compact-surface agents unable to reach the
  // {element_id, snapshot_id} ref path the `invoke`/`set_value` actions accept
  // (gauntlet F1). compile_ui fuses a11y+OCR into one ranked map with stable
  // ids; the finders locate a target semantically and return an el_NN to act on.
  { action: 'compile_ui',     delegate: 'compile_ui' },
  { action: 'find_button',    delegate: 'find_action_button' },
  { action: 'find_field',     delegate: 'find_input_field' },
  // Smart auto-fallback (OCR → a11y → CDP, by element text — no coordinates).
  // Restores the smart_* ergonomics to the recommended compound surface.
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
  { action: 'system_time',     delegate: 'get_system_time' },
  { action: 'ocr',             delegate: 'ocr_read_screen' },
  { action: 'undo',            delegate: 'undo_last' },
  { action: 'shortcuts_list',  delegate: 'shortcuts_list' },
  { action: 'shortcuts_run',   delegate: 'shortcuts_execute' },
  { action: 'delegate',        delegate: 'delegate_to_agent' },
  // v0.8.2 — Electron/WebView2 bridge
  { action: 'detect_webview',  delegate: 'detect_webview_apps' },
  { action: 'relaunch_with_cdp', delegate: 'relaunch_with_cdp' },
  // v0.9.2 — pipeline introspection (give external brains the same context
  // the autonomous loop's LLM gets injected automatically).
  { action: 'system_prompt',   delegate: 'get_system_prompt' },
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

// `task` compound — bounded-sync delegation plus its poll/cancel companions.
// status/abort exist here because a >45s task returns a RUNNING receipt and
// the compact surface must be able to follow up (the granular submit_task/
// agent_status/abort_task family used to be granular-only — live failure
// 2026-06-12: a compact-surface agent had NO non-timing-out delegation path).
const TASK_ACTIONS: ActionRoute[] = [
  { action: 'run',    delegate: 'delegate_to_agent', argRemap: { instruction: 'task' } },
  { action: 'status', delegate: 'agent_status' },
  { action: 'abort',  delegate: 'abort_task' },
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
 * Build the flat set of arg properties a compound exposes, merging
 * every delegate's parameter spec. `action` is always first and
 * required; everything else is optional (each sub-action enforces
 * its own required fields via the granular tool's validator).
 */
function buildCompoundSchema(
  routes: ActionRoute[],
): Record<string, import('./types').ParameterDef> {
  const schema: Record<string, import('./types').ParameterDef> = {
    action: {
      type: 'string',
      description: 'Which sub-action to perform. See this tool\'s description for the enum of valid values.',
      required: true,
      enum: routes.map(r => r.action),
    },
  };

  for (const route of routes) {
    const granular = getTool(route.delegate);
    if (!granular) continue; // Defensive: unknown delegate (shouldn't happen).
    for (const [pname, pdef] of Object.entries(granular.parameters)) {
      // Apply arg remapping — the compound exposes the REMAPPED name,
      // dispatcher un-maps back to the granular name at runtime.
      const remappedFrom = route.argRemap
        ? Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0]
        : undefined;
      const targetName = remappedFrom ?? pname;
      // Anti silent-drop: when a field is RENAMED on the compound (e.g.
      // `combo` exposes the granular `key_press`'s `key`), the granular's
      // native name (`key`) is otherwise absent from the published schema —
      // so the MCP server's Zod validator silently strips it and the handler
      // crashes on `undefined`. Publish the native name as an accepted alias.
      // The dispatcher already forwards unmapped native names verbatim to the
      // granular, so no runtime change is needed — this only stops the strip.
      if (remappedFrom && remappedFrom !== pname && !(pname in schema)) {
        schema[pname] = {
          ...pdef,
          required: false,
          description: `Alias for "${remappedFrom}". ${pdef.description}`,
        };
      }
      if (targetName in schema) {
        // Field already declared by an earlier delegate. The first-wins
        // policy is fine for type/description (they should match), but
        // for an `enum` constraint we have to UNION the values across
        // delegates — otherwise `mouse_scroll`'s `direction: ['up','down']`
        // wins and `mouse_scroll_horizontal`'s `['left','right']` becomes
        // invisible to the schema, so an LLM calling
        // `computer({action:'scroll_horizontal', direction:'left'})`
        // violates the published schema.
        const existing = schema[targetName];
        if (Array.isArray(existing.enum) && Array.isArray(pdef.enum)) {
          const merged = Array.from(new Set([...existing.enum, ...pdef.enum]));
          if (merged.length !== existing.enum.length) {
            existing.enum = merged;
          }
        }
        continue;
      }
      schema[targetName] = {
        ...pdef,
        required: false, // Every arg is optional on the compound — sub-actions enforce their own.
        description: pdef.description,
      };
    }
  }

  return schema;
}

/** Human-readable one-line list of actions for the tool description. */
function actionCatalog(routes: ActionRoute[]): string {
  return routes.map(r => r.action).join(', ');
}

// ─── Compound dispatcher ───────────────────────────────────────────

/**
 * Shared runtime: look up the granular tool for a compact (compound,
 * action) pair, optionally remap args, then hand off. Surfacing the
 * same ToolResult contract the granular tool returns.
 */
/**
 * Index of every compound's action table — lets a misrouted action point the
 * caller at the compound that actually owns it (e.g. `system open_app` →
 * "that action is on `window`"), instead of a dead-end "unknown action".
 */
// Exported so the schema-invariant test can iterate the LIVE tables instead of
// a hand-maintained copy that silently drifts (review 2026-06-11).
export const COMPOUND_ROUTE_INDEX: Record<string, ActionRoute[]> = {
  computer: COMPUTER_ACTIONS,
  accessibility: ACCESSIBILITY_ACTIONS,
  window: WINDOW_ACTIONS,
  system: SYSTEM_ACTIONS,
  browser: BROWSER_ACTIONS,
  task: TASK_ACTIONS,
};

/** Which other compound(s) expose `action`, excluding the one already tried. */
function compoundsForAction(action: string, exclude: string): string[] {
  const hits: string[] = [];
  for (const [name, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
    if (name === exclude) continue;
    if (routes.some(r => r.action === action)) hits.push(name);
  }
  return hits;
}

/** Granular delegate name → every (compound, action) that reaches it. */
let _compactNameIndex: Map<string, Array<{ compound: string; action: string }>> | null = null;
function compactNameIndex(): Map<string, Array<{ compound: string; action: string }>> {
  if (_compactNameIndex) return _compactNameIndex;
  _compactNameIndex = new Map();
  for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
    for (const r of routes) {
      const list = _compactNameIndex.get(r.delegate) ?? [];
      list.push({ compound, action: r.action });
      _compactNameIndex.set(r.delegate, list);
    }
  }
  return _compactNameIndex;
}

/**
 * Rewrite granular tool names in free text to the compact spelling
 * (`cdp_connect` → `browser {action:"connect"}`). Only multi-word names are
 * touched so plain English (`wait`) is never rewritten.
 */
export function toCompactNames(text: string, preferCompound: string): string {
  const index = compactNameIndex();
  const names = [...index.keys()].filter(n => n.includes('_')).sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  return text.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'g'), (name) => {
    const routes = index.get(name)!;
    const r = routes.find(x => x.compound === preferCompound) ?? routes[0];
    return `${r.compound} {action:"${r.action}"}`;
  });
}

async function dispatchCompound(
  compoundName: string,
  routes: ActionRoute[],
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const actionName = String(args.action ?? '');
  if (!actionName) {
    return {
      text: `${compoundName}: "action" is required. Valid: ${actionCatalog(routes)}`,
      isError: true,
    };
  }
  const route = routes.find(r => r.action === actionName);
  if (!route) {
    const elsewhere = compoundsForAction(actionName, compoundName);
    const hint = elsewhere.length
      ? ` — that action lives on the "${elsewhere.join('"/"')}" compound; call it there.`
      : '';
    return {
      text: `${compoundName}: unknown action "${actionName}"${hint} Valid actions here: ${actionCatalog(routes)}`,
      isError: true,
    };
  }
  const granular = getTool(route.delegate);
  if (!granular) {
    return { text: `${compoundName}: delegate "${route.delegate}" not registered`, isError: true };
  }

  // Strip the `action` key + apply any remapping before forwarding.
  const forwarded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'action') continue;
    const mapped = route.argRemap?.[k] ?? k;
    forwarded[mapped] = v;
  }

  // Enforce the granular's REQUIRED params at the compound boundary. Every
  // compound field is published as optional (sub-actions own their own
  // requirements), so without this a missing required arg reaches the handler
  // as `undefined` and crashes on the first `.toLowerCase()` / `.goto()` / etc.
  // (smart_click.target, smart_type.text, key_*.key, navigate.url, …). Fail
  // with an actionable message naming the field in the compound's vocabulary.
  const missing = Object.entries(granular.parameters)
    .filter(([, def]) => def.required === true)
    .filter(([pname]) => forwarded[pname] === undefined || forwarded[pname] === null)
    .map(([pname]) => {
      const exposed = route.argRemap
        ? Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0]
        : undefined;
      return exposed ?? pname;
    });
  if (missing.length) {
    return {
      text: `${compoundName} ${actionName}: missing required field(s): ${missing.join(', ')}.`,
      isError: true,
    };
  }

  // The compound schema is a UNION of every route delegate's parameters
  // (buildCompoundSchema), all published `required: false`. So a parameter
  // only ONE action implements appears on the WHOLE tool, and an action that
  // never declared it silently ignores it: no error, no warning, and the
  // constraint the caller asked for is void. That is how `max_cost` reached
  // `smart_read` (which fires OCR unconditionally) and how `space` reached
  // pointer tools that always image-scaled, landing the click elsewhere.
  //
  // Same defect class as GHSA-35pc-g74h-p476 — a control published uniformly
  // across a surface but enforced non-uniformly. The publishing is what makes
  // it dangerous: the caller has positive evidence the control exists.
  //
  // This is the mirror of the required-field check above: that one catches a
  // declared param arriving MISSING, this one catches an undeclared param
  // arriving IGNORED. Warn rather than error — callers passing a surplus arg
  // work today, and failing them would break a running agent mid-task.
  //
  // `expect` is exempt: projected System B delegates honor it without
  // declaring it (project-mcp.ts), so flagging it would be a false positive.
  // Making System A actions honor `expect` is separate work.
  const declared = new Set(Object.keys(granular.parameters));
  const ignored = Object.keys(forwarded).filter(
    k => k !== 'expect' && !declared.has(k) && forwarded[k] !== undefined && forwarded[k] !== null,
  );

  const result = await granular.handler(forwarded, ctx);

  // Granular hints ("Call cdp_connect first") name tools that do not exist
  // here — a compact caller cannot act on them. Rename to this surface's
  // vocabulary; the compound being called wins when an action is aliased.
  if (typeof result.text === 'string') result.text = rewriteOutsideData(result.text, prose => toCompactNames(prose, compoundName));

  if (ignored.length) {
    const hints = ignored.map(pname => {
      const accepts = routes
        .filter(r => {
          const d = getTool(r.delegate);
          return !!d && ((r.argRemap?.[pname] ?? pname) in d.parameters);
        })
        .map(r => r.action);
      return accepts.length ? `${pname} (accepted by: ${accepts.join(', ')})` : pname;
    });
    result.text = `${result.text ?? ''}
[!] ${compoundName} ${actionName} ignored ${ignored.length === 1 ? 'an argument' : 'arguments'} it does not accept: ${hints.join('; ')}`;
  }

  return result;
}

// ─── Tool definitions ──────────────────────────────────────────────

export function getCompactTools(): ToolDefinition[] {
  return [
    {
      name: 'computer',
      description:
        'Direct mouse/keyboard/screenshot control (Anthropic Computer-Use style). ' +
        `Pick an action: ${actionCatalog(COMPUTER_ACTIONS)}. ` +
        'Coordinates are image-space pixels from the most recent screenshot. ' +
        'Prefer `accessibility` for named targets; use `computer` only when you need pixel-level control.',
      parameters: buildCompoundSchema(COMPUTER_ACTIONS),
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('computer', COMPUTER_ACTIONS, args, ctx),
    },

    {
      name: 'accessibility',
      description:
        'Interact with the OS accessibility tree — read element names, find by name/role, invoke, toggle, expand/collapse, set value, query state. ' +
        `Pick an action: ${actionCatalog(ACCESSIBILITY_ACTIONS)}. ` +
        'Always preferred over `computer.click(x,y)` when the target has a name — more reliable across DPI, window resize, layout shifts. ' +
        'For sparse/ambiguous UIs: `compile_ui` fuses a11y+OCR into one ranked map of elements with stable ids; `find_button`/`find_field` locate a target semantically and return an {element_id, snapshot_id} you pass straight to `invoke`/`set_value` (survives layout shifts, no coordinates).',
      parameters: buildCompoundSchema(ACCESSIBILITY_ACTIONS),
      category: 'perception',
      safetyTier: 0,
      handler: (args, ctx) => dispatchCompound('accessibility', ACCESSIBILITY_ACTIONS, args, ctx),
    },

    {
      name: 'window',
      description:
        'Window, app, and display management. Open/focus/maximize/minimize/restore/close/resize windows; enumerate displays; switch browser tabs at the OS level; open apps/files/URLs. ' +
        `Pick an action: ${actionCatalog(WINDOW_ACTIONS)}.`,
      parameters: buildCompoundSchema(WINDOW_ACTIONS),
      category: 'window',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('window', WINDOW_ACTIONS, args, ctx),
    },

    {
      name: 'system',
      description:
        'System integration — clipboard read/write, system time, OCR screen-reading, undo shortcut, named shortcuts registry, delegate to a sub-agent. ' +
        `Pick an action: ${actionCatalog(SYSTEM_ACTIONS)}.`,
      parameters: buildCompoundSchema(SYSTEM_ACTIONS),
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('system', SYSTEM_ACTIONS, args, ctx),
    },

    {
      name: 'browser',
      description:
        'Chrome DevTools Protocol control — operates on DOM elements by CSS selector rather than screen pixels. Start with `navigate` (opens the URL in the agent\'s own CDP browser, launching it if needed) or `connect` (attach to a browser already on the debug port), then page_context/click/type on that page. Much more reliable than `computer` for web automation. ' +
        `Pick an action: ${actionCatalog(BROWSER_ACTIONS)}.`,
      parameters: buildCompoundSchema(BROWSER_ACTIONS),
      category: 'browser',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('browser', BROWSER_ACTIONS, args, ctx),
    },

    {
      name: 'task',
      description:
        '**Requires the `clawdcursor agent` daemon to be running** (binds 127.0.0.1:3847 with an LLM configured). ' +
        'Hand clawdcursor a WHOLE natural-language task and let its internal pipeline decide how to execute it (router → blind agent → hybrid → vision fallback). ' +
        'Use this when you don\'t want to micromanage every primitive — clawdcursor decomposes the task, picks the cheapest execution path, and returns a trace. ' +
        'BOUNDED-SYNC: waits up to `timeout` seconds (default 45) — a longer task returns {status:"running"} with progress while it CONTINUES in the background; re-call with the SAME instruction to keep waiting (re-attaches, never restarts), {action:"status"} to poll, {action:"abort"} to stop it. ' +
        'The `computer`/`accessibility`/`window`/`system`/`browser` compounds are for when you want step-level control yourself. ' +
        'If the daemon isn\'t running you get a clear error telling you how to start it.',
      parameters: {
        action: {
          type: 'string',
          description: 'Default "run" (submit/continue the instruction). "status" → poll the running task (cheap, poll at 1–2 Hz). "abort" → stop the running task.',
          required: false,
          enum: ['run', 'status', 'abort'],
        },
        instruction: {
          type: 'string',
          description: 'Natural-language task description, e.g. "open Notepad and type hello", "go to github.com", "send email in Outlook". Required for action "run" (the default); ignored for status/abort.',
          required: false,
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to WAIT for completion before returning a running receipt (default 45, clamped 1–50). The task keeps running — this only bounds the wait.',
          required: false,
        },
      },
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => {
        const action = typeof args.action === 'string' && args.action ? args.action : 'run';
        return dispatchCompound('task', TASK_ACTIONS, { ...args, action }, ctx);
      },
    },

    // `batch` — run an ordered list of the above calls in one shot (declarative,
    // guarded, safety-gated per step). The efficiency lever without a sandbox.
    ...getBatchTools(),
  ];
}

/** Names of all compact tools (for tier + doc lookups). */
export const COMPACT_TOOL_NAMES = ['computer', 'accessibility', 'window', 'system', 'browser', 'task', 'batch'] as const;
