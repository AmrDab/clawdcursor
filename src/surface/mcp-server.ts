/**
 * MCP Server — the single point of construction for clawdcursor's MCP
 * surface. Used by both the stdio transport (editor integrations like
 * Claude Code, Cursor, Windsurf) and the streamable-HTTP transport
 * (the long-running `clawdcursor agent` daemon).
 *
 * The HTTP transport is the daemon's /mcp route, gated like its other
 * routes (http-utility.ts ROUTES, auth.ts).
 */

import type express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ZodTypeAny } from 'zod';
import { VERSION } from '../version';
import type { ToolContext, ToolDefinition } from '../tools/registry';
import type { ParameterDef } from '../tools/types';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { controlBanner } from '../core/banner';
import { osKeysGuide } from '../platform/keys';
import { enableHostAncestry } from '../core/ai-hosts';
import { actedIn, actRecord, withTurnBudget } from '../core/control';
import { asPauseOwner, pauseGate } from '../core/pause-gate';
import { logger } from '../core/observability/logger';
import { COMPOUND_ROUTE_INDEX, compactCall } from '../tools/compact-routes';
import { resultCallsAsProse } from '../tools/call-prose';

const COMPOUND_TOOLS = new Set(Object.keys(COMPOUND_ROUTE_INDEX));
/** A compound call's arguments that its schema does not list (keepUndeclaredArgs), for the call being run. */
const undeclaredArgs = new AsyncLocalStorage<Record<string, unknown>>();
import { hasConsent, writeConsentFile } from './onboarding';
import { SessionLog, outcomeOf } from './session-log';
import { withSteps, watchChildProcesses } from '../core/observability/steps';
import { inMcpSession } from '../core/verify/assertions';
import { allowNames, setHost } from '../core/observability/telemetry';
import { setGuideSurface } from '../core/guides/hint';
import { classifyResult, renderResultLine, isJsonText, isActingAction, isUnverifiableAction } from '../core/result-codes';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { refusalBefore, afterCall, forgetScreenIfActed, guardedCall } from '../tools/call-guards';
import { OPAQUE_MARK } from '../tools/blind-hints';
import { bareStepName } from '../tools/batch';

// ── Typed SDK boundary (#115) ────────────────────────────────────────────────
//
// The SDK is ESM with subpath-"exports"-mapped types; our build is CJS with
// moduleResolution "node" (node10), which CANNOT resolve those subpath type
// declarations — that is what forced the previous `any`s (verified: switching
// to moduleResolution node16 type-resolves the SDK but demands explicit .js
// extensions on ~35 relative dynamic imports across the codebase — a separate
// migration). Until that migration, the boundary is typed STRUCTURALLY: these
// interfaces declare exactly the contract clawdcursor consumes, so drift in
// how WE use the SDK fails typecheck, and drift in the SDK's wire behavior is
// caught by the schema.snapshot.json test.

/** One content block in an MCP tools/call result. */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** The result shape clawdcursor's tool handlers produce for the SDK. */
export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;   // SDK result index signature compatibility
}

/** The slice of the SDK's McpServer that clawdcursor drives. */
export interface McpServerLike {
  tool(
    name: string,
    description: string,
    paramsSchema: Record<string, unknown>,
    annotations: Record<string, unknown>,
    handler: (params: Record<string, unknown>) => Promise<McpToolResult>,
  ): void;
  connect(transport: McpTransportLike): Promise<void>;
}

/** The slice of an SDK transport that clawdcursor drives. */
export interface McpTransportLike {
  close?: () => Promise<void> | void;
  handleRequest?: (
    req: express.Request,
    res: express.Response,
    body?: unknown,
  ) => Promise<void>;
}

export interface CreateMcpServerOptions {
  /** When true, expose the 6-compound surface instead of granular. */
  compact?: boolean;
  /** Subsystem context every tool handler receives. */
  ctx: ToolContext;
}

export interface McpServerHandle {
  /** The configured McpServer instance — connect a transport via .connect(). */
  server: McpServerLike;
  /** Number of tools registered (mirrors the surface size). */
  toolCount: number;
  /** Snapshot of the tools that were registered (in registration order). */
  tools: ToolDefinition[];
  /** This server's session record: closed with the exit reason (stdio), or when its HTTP session closes. */
  sessionLog: SessionLog;
}

/** The tools a server serves: the 6 compounds, or the granular surface where every action is its own tool. */
export function servedTools(compact: boolean | undefined): ToolDefinition[] {
  return compact ? getCompactSurface() : getAllTools();
}

/** A compact (tool, action), or a granular tool reached through its compound route, that changes something. */
function isActingCall(toolName: string, action: string | undefined, test: typeof isActingAction = isActingAction): boolean {
  const c = compactCall(toolName, action);
  return test(c.tool, c.action);
}

/** Does any step of a batch (compact or granular tool names, host prefix or not) change something? */
export function batchActs(steps: unknown): boolean {
  // `steps` may arrive as a JSON string (the batch tool accepts both).
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { return false; } }
  if (!Array.isArray(steps)) return false;
  return steps.some(s => {
    const step = (s ?? {}) as { name?: unknown; arguments?: { action?: unknown }; args?: { action?: unknown } };
    const action = step.arguments?.action ?? step.args?.action;
    return typeof step.name === 'string' && isActingCall(bareStepName(step.name), typeof action === 'string' ? action : undefined);
  });
}

/**
 * Build a configured McpServer with all clawdcursor tools registered.
 *
 * The caller is responsible for connecting a transport via `server.connect(...)`.
 * Use `startMcpStdio` for editor integrations and `startMcpHttp` for the daemon.
 */
let sessionSeq = 0;

export async function createMcpServer(options: CreateMcpServerOptions): Promise<McpServerHandle> {
  const { compact, ctx } = options;
  // Dynamic import: the SDK is ESM and our build is CJS. The specifier cast is
  // a moduleResolution:"node" limitation (see the #115 note above); the VALUE
  // is immediately narrowed to the structural contract.
  const sdkMcp = await import('@modelcontextprotocol/sdk/server/mcp.js' as string) as {
    McpServer: new (info: { name: string; version: string }, opts: { instructions: string }) => McpServerLike;
  };
  const { McpServer } = sdkMcp;
  const { z } = await import('zod');

  // MCP `instructions` — sent once at the initialize handshake and injected
  // into the connecting agent's context. This is the only channel to tell an
  // integrating agent (Claude Code, Cursor, Windsurf, Zed, OpenClaw) HOW to
  // use clawdcursor cheaply. Without it, agents drive the raw GUI tools with
  // their own premium model, the expensive path.
  // The one tool that asks the user, named the way this surface names it (compact: a compound tool and its action).
  const pauseTool = compact ? 'the system tool, action pause_for_user' : 'the pause_for_user tool';
  const instructions =
      // Owner 2026-11-17: the agent should know, without being told to use clawdcursor, that no task asked of it is out of
      // reach (the 0.5-era rules a 2026-02 skill scan cut and the 2.x "FALLBACK layer" line replaced).
      'clawdcursor is your eyes and hands on this computer: with it, no task the user asks for is impossible — if a human can do it ' +
      'on a screen, you can. Use it on your own whenever a request needs an app, a window, a website or anything on the screen; ' +
      'the user does not have to name it. Do not tell the user you cannot reach their desktop or an app, and do not ask them to do ' +
      'a step you can do with these tools. You drive the tools yourself. ' +
      // Live runs (audit 2026-11-19, and the 2026-11-19 terminal runs): the first call often went to a bare `window`, which
      // the host does not have, because it lists the tools with its own prefix.
      'The tool names in this text are short: call each tool by the full name your host lists for it (hosts add a prefix). ' +
      (compact
        // Compact tools carry no per-tool cost prefix, so name the actions.
        ? 'TO SEE: (1) accessibility read_tree lists the window\'s elements by name; ' +
          '(2) system copy_all_text gives the exact text of a page (find returns only the lines with one value); ' +
          '(3) system ocr reads the screen when read_tree is empty. ' +
          'TO ACT: (1) accessibility invoke with name clicks an element, set_value types into a field; ' +
          '(2) if the name is not found, accessibility smart_click with target = the visible label; ' +
          '(3) only for a target with no name and no text: computer screenshot, then computer click with x,y from that image. '
        : 'To minimize tokens, follow the cost-class prefix on each tool — ' +
          '[act] < [inspect] < [perceive-text] < [perceive-image]. ' +
          'For perception always escalate in this order: ' +
          '(1) read the accessibility tree ([perceive-text], cheapest — start here); ' +
          '(2) use OCR ([perceive-text]) when the tree is empty or sparse; ' +
          '(3) capture a screenshot ([perceive-image]) only as a last resort when both fail. ' +
          'Prefer named-target actions (by a11y name) over pixel coordinates. ') +
      // The OS is read once, here, when the server starts: the agent knows from its first message which keys to send.
      osKeysGuide() +
      'A surface with no names and no text (a drawing canvas, whiteboard, CAD viewport or map; read_tree says "Opaque area") ' +
      'is where a screenshot is the right tool, inside that area only: plan every stroke from one screenshot, send them in ONE batch ' +
      '(click with path, drag_path), then check with ONE screenshot_region of only the changed area, max_edge 512. ' +
      'The toolbars, fields and dialogs around it are still pressed by name (invoke) or by visible label (smart_click), not by pixel. ' +
      `Roadblocks only the user can clear (sign-in, 2FA, CAPTCHA, a step that needs their confirmation): call ${pauseTool} with a message — ` +
      'ask for that ONE step only ("Sign in to Glama") and do everything before and after it yourself; for a sign-in, code or CAPTCHA, done_when ' +
      '(what shows on screen once they are done) ends the pause the moment they finish, with no Resume click — never for a confirmation or a choice. Never type or guess credentials. ' +
      'A step your own rules won\'t let you take (creating an account, downloading a private key, entering a password, key or token) is a roadblock too, ' +
      'not a reason to turn the task down: hand over that step, as wide as your rules draw it, and do the rest they allow. When a secret must go into a field or a terminal prompt, put the cursor there ' +
      'and ask only for the paste ("Paste your app-specific password into the Terminal, press Enter, then click Resume"), naming where it goes: never into the prompt\'s own reply box, whose text reaches you; afterwards pass the saved key\'s file path or keychain profile name, never the secret. A plan limit or upgrade wall is a roadblock too: ' +
      'stop, quote the blocking text and pause_for_user; never click Upgrade / Subscribe yourself. ' +
      'While you are driving the desktop, the user is watching the screen, not your chat: ask them on the pause card (use choices when there are options), not in your own chat — ' +
      `${pauseTool} with message, choices (a list, when there are options) and input (placeholder, multiline). Before an irreversible action the user did not ask for (sending, deleting, paying, closing unsaved work), ask there first and follow the answer {status:"replied", choice | reply}: clawdcursor does not judge what you do, so that decision is yours. ` +
      'Drive UI symbolically: compile_ui / find_button / find_field return a stable ' +
      '{element_id, snapshot_id} you pass to invoke/set_value — it survives layout shifts, so ' +
      'prefer it over pixel coordinates. ' +
      `When a result shows keys from a guide, press them instead of hunting with the mouse; the rest of that guide is ${compact ? 'the system tool, action shortcuts_list' : 'the shortcuts_list tool'}, with context. ` +
      'Pass `expect` on consequential actions so a failed one ' +
      'reports a DEVIATION instead of a hollow success. Each action result and error ends with one line: ' +
      '[confirmed | unverified | refused · CODE · hint · next | failed · CODE · hint · next] — follow its next call instead of guessing. ' +
      'PAUSED (the user paused clawdcursor) means nothing was sent: call the same step again until it runs, and do not give up or act another way meanwhile. USER_ACTIVE (the user is using the computer, which they may while you work in the background) means nothing was sent: keep working by name meanwhile, and call that step again in a few seconds. A STOPPED reply is different: do not retry it. ' +
      'A native API, CLI or direct file edit that does the same job is cheaper: use it when it exists, and never decline a task ' +
      'because none does. Full usage guide: the `clawdcursor` skill registered in your agent, or ' +
      'https://clawdcursor.com/llms.txt.';

  const server = new McpServer({ name: 'clawdcursor', version: VERSION }, { instructions });
  setGuideSurface(compact);   // the app-guide hint names the tool as this surface spells it

  // Local record of this session (tool / action / blind-vs-vision / ok — no
  // content). Feeds `clawdcursor report` and the vision-streak nudge below.
  const sessionLog = new SessionLog({ version: VERSION, surface: compact ? 'compact' : 'granular' });
  watchChildProcesses();  // each child process a call starts is one of its steps (steps.ts)
  const VISION_STREAK_HINT = (n: number) => compact
    ? `[clawdcursor] ${n === 1 ? 'A screenshot before any text was read.' : `${n} screenshots in a row with no text read.`} Cheaper and exact: accessibility compile_ui or smart_read (names + positions), system copy_all_text (exact page text); act by name with accessibility invoke / smart_click — coordinate clicks are the fallback.`
    : `[clawdcursor] ${n === 1 ? 'A screenshot before any text was read.' : `${n} screenshots in a row with no text read.`} Cheaper and exact: compile_ui / smart_read (names + positions), copy_all_text (exact page text); act by name with invoke_element / smart_click — coordinate clicks are the fallback.`;
  // The last blind read found nothing to act on in the window (an empty tree, an opaque area): the advice above cannot be followed there.
  const CANVAS_HINT = compact
    ? '[clawdcursor] The last text read found nothing to act on in the drawn area, so a screenshot is right for picks INSIDE it: send all remaining strokes in ONE batch (computer click with path, drag_path), then ONE computer screenshot_region of only the changed area with max_edge 512. A toolbar button, field or dialog button with a visible label is pressed with accessibility smart_click target "<label>", no screenshot.'
    : '[clawdcursor] The last text read found nothing to act on in the drawn area, so a screenshot is right for picks INSIDE it: send all remaining strokes in ONE batch (mouse_click with path, mouse_drag_stepped), then ONE desktop_screenshot_region of only the changed area with max_edge 512. A toolbar button, field or dialog button with a visible label is pressed with smart_click target "<label>", no screenshot.';
  // A CAD run (2026-11-16) made 73 coordinate clicks, ~58 on labelled buttons, and 7 accessibility calls: after 3 coordinate clicks with no
  // click by name since, say once that a label is pressed by name. A batch is act-other and is not counted.
  const COORD_CLICK_HINT = compact
    ? '[clawdcursor] 3 clicks by coordinates and none by name. A button, tab, menu or field with a visible label: smart_click {"target":"<label>"} presses it with no screenshot; keep x,y for points with no label, like inside a canvas.'
    : '[clawdcursor] 3 clicks by coordinates and none by name. A button, tab, menu or field with a visible label: smart_click {"target":"<label>"} presses it with no screenshot; keep x,y for points with no label, like inside a canvas.';
  let coordClicks = 0;
  let coordNudged = false;
  let blindFoundNothing = false;
  let nudgedThisStreak = false;
  const clientInfo = () => (server as unknown as { server?: { getClientVersion?: () => { name?: string; version?: string } | undefined } })
    .server?.getClientVersion?.();

  // First tool call without consent: ask the USER in the host's own UI (MCP
  // elicitation) instead of telling them to go run a terminal command. The
  // model cannot answer an elicitation — the host shows it to the person.
  // Asked at most once per server: concurrent calls share the one prompt, and
  // a decline is not re-asked on every call (the text prompt takes over).
  let consentPrompt: Promise<boolean> | null = null;
  const askConsentInHost = (): Promise<boolean> => {
    consentPrompt ??= (async () => {
      const host = (server as unknown as { server?: {
        getClientCapabilities?: () => { elicitation?: unknown } | undefined;
        elicitInput?: (params: unknown) => Promise<{ action: string; content?: Record<string, unknown> }>;
      } }).server;
      if (!host?.getClientCapabilities?.()?.elicitation || !host.elicitInput) return false;
      try {
        const answer = await host.elicitInput({
          message:
            'clawdcursor needs your OK once before it can control this computer. ' +
            'It lets the AI use your mouse, keyboard and screen, with your own permissions. ' +
            'You can stop it at any time from the on-screen pill, and it never sends the key combos that lock the screen or log you out.',
          requestedSchema: {
            type: 'object',
            properties: {
              allow: {
                type: 'boolean',
                title: 'Allow clawdcursor to control this computer',
                default: false,
              },
            },
            required: ['allow'],
          },
        });
        if (answer.action === 'accept' && answer.content?.allow === true) {
          writeConsentFile('mcp-elicitation');
          return true;
        }
      } catch { /* the host could not show it — fall back to the text prompt */ }
      return false;
    })();
    return consentPrompt;
  };
  const tools = servedTools(compact);
  // Bug telemetry sends a tool or action name only when it is one of these (telemetry.ts), and the host only by an allowlist.
  allowNames(tools.flatMap(t => [t.name, ...(t.parameters.action?.enum ?? [])]));
  // When this session started: when its agent connected (initialized). `expect` / `verify` file_changed_since_start
  // measures from here. A call with no session (the daemon's one-shot pool: dashboard, curl) measures from its own start,
  // not from when the daemon came up days ago.
  let sessionStartedAt: number | undefined;
  const lowLevel = (server as unknown as { server?: { oninitialized?: () => void } }).server;
  if (lowLevel) lowLevel.oninitialized = () => { sessionStartedAt = Date.now(); setHost(clientInfo()?.name); };
  // This session's pause card comes down when the session ends (stdio closing, an HTTP session closed): nobody is left to read
  // the answer, and the card would keep every other agent out. A process exit takes its own overlay down (banner.ts).
  const sessionId = `mcp-${process.pid}-${++sessionSeq}`;
  const lowClose = server as unknown as { server?: { onclose?: () => void } };
  if (lowClose.server) {
    const prior = lowClose.server.onclose;
    lowClose.server.onclose = () => { prior?.(); pauseGate.withdrawFor(sessionId); };
  }

  for (const tool of tools) {
    // Convert parameter defs to a Zod schema map. The MCP SDK uses zod
    // shape objects (Record<string, ZodType>) — not full ZodObjects.
    const zodParams: Record<string, ZodTypeAny> = {};
    for (const [key, def] of Object.entries(tool.parameters)) zodParams[key] = paramSchema(z, def);

    // MCP SDK 1.29 arg parsing breaks if schema is undefined (shifts callback
    // position). Always pass a schema — use empty object for parameterless tools.
    const hasParams = Object.keys(zodParams).length > 0;
    // Surface the token-cost class to the tool-picking LLM. The
    // high-level SDK `server.tool()` API has no slot for a vendor metadata
    // field, so a `[costClass]` description prefix is the reliable
    // LLM-readable channel in tools/list. `costClass` in source stays the
    // single source of truth; the prefix is rendered only at this projection.
    const description = tool.costClass
      ? `[${tool.costClass}] ${tool.description}`
      : tool.description;
    server.tool(
      tool.name,
      description,
      hasParams ? zodParams : {},
      toolAnnotations(tool),
      async (params: Record<string, unknown>): Promise<McpToolResult> => {
        // One line saying what the result means — confirmed / unverified / refused / failed, and for a failure a code, a
        // hint and a safe next call (result-codes.ts). Not on JSON results (they carry their own status) or a batch
        // (its report has a status per step).
        const callAction = typeof params?.action === 'string' ? params.action : undefined;
        // Every call a hint names goes out as prose for this surface ("the browser tool, action page_context"), never as a
        // call-shaped text the host has no tool of that name for (call-prose.ts).
        const surface = compact ? 'compact' : 'granular';
        const withOutcome = (text: string, isError: boolean): string => {
          if (tool.name === 'batch' || isJsonText(text)) return resultCallsAsProse(text, surface);
          const c = classifyResult(text, isError, isActingCall(tool.name, callAction, isUnverifiableAction), 'mcp', isActingCall(tool.name, callAction));
          return resultCallsAsProse(c ? `${text}\n${renderResultLine(c)}` : text, surface);
        };
        // Consent gate (non-fatal): until the user accepts one-time consent,
        // every tool returns a clear, host-VISIBLE prompt instead of the server
        // dying with an opaque "failed". Re-checked per call so `clawdcursor
        // consent --accept` takes effect immediately, with no restart. A host
        // that supports elicitation asks the user in-app first.
        // Turning off error reports touches nothing on screen: it never waits on consent.
        const telemetryOptout = tool.name === 'telemetry_optout' || (tool.name === 'system' && callAction === 'telemetry_optout');
        if (!telemetryOptout && !hasConsent() && !(await askConsentInHost())) {
          sessionLog.record(tool.name, typeof params?.action === 'string' ? params.action : undefined, false, 0,
            undefined, clientInfo(), { outcome: 'consent_required' });
          return {
            content: [{ type: 'text', text: withOutcome(
              'clawdcursor needs one-time consent before it can control the desktop. ' +
              'Run `clawdcursor consent --accept` in a terminal once (or, if not installed globally — e.g. the npx-based plugin — ' +
              '`npx -y clawdcursor consent --accept`), then retry — no restart needed. ' +
              '(This grants the agent full mouse/keyboard/screen control of this machine.)', true),
            }],
            isError: true,
          };
        }
        // What zod dropped from a compound call goes to its dispatcher, which reports or refuses it (keepUndeclaredArgs).
        if (COMPOUND_TOOLS.has(tool.name)) {
          const more = undeclaredArgs.getStore();
          if (more) params = { ...more, ...params };
        }
        const action = callAction;
        // A guard that refuses logs its own verdict.
        const refuse = (guard: string, why: string): McpToolResult => {
          const label = action ? `${tool.name} {action:"${action}"}` : tool.name;
          logger.warn('safety.refused', { tool: tool.name, action, guard, reason: why });
          sessionLog.record(tool.name, action, false, 0, why, clientInfo(), { outcome: 'refused' });
          return { content: [{ type: 'text', text: withOutcome(`${label}: ${why}`, true) }], isError: true };
        };
        const call = guardedCall(tool.name, action, params ?? {});
        // Once the call is known not to be stopped, a consequential one (tier 1+) pokes the pill: it shows on the first
        // poke and hides after ~30 s without one. Compound tools decide per action in dispatchCompound. A batch that acts
        // at any step shows it from its start: its first step may be a 30 s wait, and a pill that is not there cannot be
        // double-clicked (#294).
        const refused = await refusalBefore(call, ctx, () => {
          if ((tool.safetyTier ?? 0) >= 1 && !COMPOUND_TOOLS.has(tool.name)) controlBanner.touch();
          if (tool.name === 'batch' && batchActs(params?.steps)) controlBanner.touch();
        });
        if (refused) return refuse(refused.guard, refused.why);
        const started = Date.now();
        const wasIn = actedIn();
        // What this call acted on, as the input guard verified it when it sent the act (control.ts actRecord).
        const acted = () => actRecord(wasIn);
        const releasePill = controlBanner.hold();  // the call has control until it returns, waits included
        sessionLog.running(tool.name, action, clientInfo());
        // withTurnBudget: the call's waits for the user (control.ts) end before a host's 60 s call limit.
        const run = await withSteps(tool.name, action, () => inMcpSession(sessionStartedAt ?? started, () => withTurnBudget(() => asPauseOwner(sessionId, () => tool.handler(params, ctx)))));  // where the call's time went
        releasePill();
        if (!run.ok) {
          // A handler throw (e.g. core tools' toolContextToAgent when the
          // platform adapter failed to init) must NOT propagate to the MCP SDK
          // — in stdio mode an unhandled rejection can corrupt the JSON-RPC
          // stream. Convert to a clean isError result.
          forgetScreenIfActed(call);   // a throw skips afterCall
          const err = run.error;
          const msg = err instanceof Error ? err.message : String(err);
          sessionLog.record(tool.name, action, false, Date.now() - started, msg, clientInfo(), { outcome: outcomeOf(true, msg), ...acted(), timing: run.steps });
          return { content: [{ type: 'text', text: withOutcome(`${tool.name}: ${msg}`, true) }], isError: true };
        }
        let result = run.result;
        const after = await afterCall(call, result, ctx);
        if ('guard' in after) return refuse(after.guard, after.why);
        if (after.screenshotNote) result = { ...result, text: `${result.text}\n${after.screenshotNote}` };
        // A batch: one row per step class, not one act-other row. Steps the cap skipped never ran.
        const steps = result.steps?.filter(s => s.status !== 'skipped').map(s => ({
          tool: s.tool, action: s.action, ok: s.status === 'ok',
          outcome: s.status === 'blocked' ? 'refused' as const : outcomeOf(s.status !== 'ok', s.text),
          ...(s.pressedKeys ? { cls: 'act-other' as const } : {}),
          // Each step's own target, recorded by the batch when that step ran.
          ...(s.app ? { app: s.app } : {}), ...(s.appPid ? { appPid: s.appPid } : {}), ...(s.appHandle ? { appHandle: s.appHandle } : {}),
        }));
        // A batch halts at its first failed step, so a halt a guard caused is a refusal, not an error.
        const batchRefused = result.isError && steps?.[steps.length - 1]?.outcome === 'refused';
        const outcome = batchRefused ? 'refused' : outcomeOf(!!result.isError, result.text ?? '');
        const blindBefore = sessionLog.summary.blind;
        const cls = sessionLog.record(tool.name, action, !result.isError, Date.now() - started,
          result.isError ? result.text : undefined, clientInfo(),
          { outcome, space: typeof params?.space === 'string' ? params.space : undefined,
            ...acted(), steps, timing: run.steps, ...(result.pressedKeys ? { cls: 'act-other' as const } : {}) });
        // What the latest blind read (alone or a batch step) found about the WHOLE window: an empty tree or an opaque area.
        // A missed find, an empty clipboard or a timeout says nothing about the window. Only the tool's own words count,
        // never the screen text inside the block.
        if (sessionLog.summary.blind > blindBefore) {
          nudgedThisStreak = false;   // a blind read ends the run of screenshots; clicks between screenshots do not
          const own = (result.text ?? '').split('</untrusted-screen-content>').pop()!;
          blindFoundNothing = cls === 'blind' && (own.startsWith('(empty a11y tree') || own.includes(OPAQUE_MARK));
        }
        // Blind first, then vision: field data showed agents drifting into a
        // screenshot → coordinate-click loop after an early blind miss. After
        // 3 screenshots with no text/a11y read in between, say what the cheaper,
        // exact path is — once per run of screenshots (#380: repeating it every
        // 5th was noise). Where the last blind read found nothing (a canvas),
        // say instead how to use screenshots well there (#356).
        const streak = sessionLog.visionOnlyStreak;
        // The first screenshot of a session that has read nothing yet is the cheapest moment to say it.
        const firstBlind = streak === 1 && sessionLog.summary.blind === 0;
        if (cls === 'vision' && !result.isError && !nudgedThisStreak && (blindFoundNothing || firstBlind || streak >= 3)) {
          nudgedThisStreak = true;
          result = { ...result, text: `${result.text}\n\n${blindFoundNothing ? CANVAS_HINT : VISION_STREAK_HINT(streak)}` };
        }
        if (cls === 'act-name') coordClicks = 0;
        // Clicks only (click, double_click, mouse_click…): a scroll, hover or drag at x,y has no label to press instead.
        else if (cls === 'act-coords' && /click$/.test(action ?? tool.name) && !result.isError && ++coordClicks >= 3 && !coordNudged) {
          coordNudged = true;
          result = { ...result, text: `${result.text}\n\n${COORD_CLICK_HINT}` };
        }
        const content: McpContentBlock[] = [];
        if (result.image) {
          content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
        }
        content.push({ type: 'text', text: withOutcome(result.text, !!result.isError) });
        // What the agent's browser downloaded since the last call, now in the user's Downloads folder (cdp-driver.ts). A
        // block of its own: a JSON or value result stays exactly as it was.
        const saved: string[] = (ctx.cdp as { takeSavedDownloads?: () => string[] } | undefined)?.takeSavedDownloads?.() ?? [];
        if (saved.length) content.push({ type: 'text', text: `Downloaded to: ${saved.map(quoteScreenText).join(', ')}` });
        return { content, isError: result.isError };
      },
    );
  }

  stripRootSchemaDialect(server);
  keepUndeclaredArgs(server, new Map(tools.filter(t => COMPOUND_TOOLS.has(t.name)).map(t => [t.name, new Set(Object.keys(t.parameters))])));

  return { server, toolCount: tools.length, tools, sessionLog };
}

/** The zod schema a tool parameter is published and validated with (zod is passed in: it is loaded lazily). */
export function paramSchema(z: typeof import('zod').z, def: ParameterDef): ZodTypeAny {
  let schema: ZodTypeAny;
  if (def.type === 'number') schema = z.number();
  else if (def.type === 'boolean') schema = z.boolean();
  // 'array' params accept a real array (preferred) OR a JSON-encoded string,
  // matching dual-accept handlers (e.g. batch.steps). Without this branch the
  // default below coerced arrays to z.string() and rejected the array form
  // the README/inputSchema advertise ("Expected string, received array").
  //
  // Published as a PLAIN `{type:"array", items:<real schema>}`, not as the
  // `z.union` it used to be. The union serialized to
  // `anyOf:[{type:"array",items:{}},{type:"string"}]`, which hits two
  // documented provider rejections that stop a host registering the server:
  //   - Gemini (verbatim-relay hosts): `anyOf` with a sibling `description`
  //     is a 400 — "schema specified other fields alongside any_of".
  //   - OpenAI `strict: true`: `items: {}` has no `type` — "schema must
  //     have a 'type' key".
  // Runtime acceptance is unchanged: z.any() + refine still takes a real
  // array OR a JSON-encoded string, so dual-accept handlers see the same
  // inputs, and anything else is still rejected as before.
  else if (def.type === 'array') {
    schema = z.any()
      .refine(v => v === null || Array.isArray(v) || typeof v === 'string', {   // null: some hosts send it for "not given"
        message: 'Expected an array (or a JSON-encoded array string).',
      })
      .meta({ type: 'array', items: def.items ?? { type: 'object' } });
  }
  // 'object' params: a real object (or its JSON text, like arrays); the handler validates the fields.
  else if (def.type === 'object') {
    schema = z.any()
      .refine(v => v === null || (typeof v === 'object' && !Array.isArray(v)) || typeof v === 'string', {
        message: 'Expected an object (or a JSON-encoded object string).',
      })
      .meta({ type: 'object', properties: def.properties ?? {} });
  }
  else schema = z.string();
  if (def.enum) schema = z.enum(def.enum as [string, ...string[]]);
  schema = schema.describe(def.description);
  if (def.required === false) schema = schema.optional();
  return schema;
}

/**
 * MCP tool annotations: the tool's own, else derived — tier 0 reads only; an input tool carries destructiveHint only when
 * it declares `destructive: true` (closing a window, overwriting the clipboard, opening a file or URI, page script).
 * The values are the ones 1.5.27 published: hosts build their own approval UI on them, so they change only on purpose.
 */
export function toolAnnotations(tool: Pick<ToolDefinition, 'annotations' | 'safetyTier' | 'destructive'>): NonNullable<ToolDefinition['annotations']> {
  if (tool.annotations) return tool.annotations;
  return (tool.safetyTier ?? 1) === 0 ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: tool.destructive === true };
}

/**
 * Drop the root `$schema` keyword from every tool's inputSchema in tools/list.
 *
 * SDK 1.29's zod-to-JSON-Schema step always stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on each inputSchema.
 * Gemini's FunctionDeclaration schema has no `$schema` field, so hosts that
 * relay MCP schemas into Gemini verbatim get a 400 —
 * `Unknown name "$schema" at 'tools.function_declarations[0].parameters'` —
 * and the WHOLE server fails to register, not just one tool. MCP does not need
 * the keyword (inputSchema is JSON Schema by definition), and Claude, Codex and
 * the OpenAI Agents SDK all ignore it, so removing it is safe everywhere.
 *
 * McpServer installs tools/list itself and exposes no hook to post-process it,
 * so this wraps the handler in the low-level Server's handler map — an SDK
 * internal. It FAILS SAFE: if a future SDK reshapes that map, this does nothing
 * and nothing crashes. A wire-level test asserts `$schema` is absent, so such
 * an upgrade is caught by CI rather than silently re-breaking Gemini.
 */
function stripRootSchemaDialect(server: McpServerLike): void {
  const handlers = (server as unknown as {
    server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  }).server?._requestHandlers;
  const original = handlers?.get('tools/list');
  if (!handlers || !original) return;
  handlers.set('tools/list', async (req, extra) => {
    const res = (await original(req, extra)) as { tools?: Array<{ inputSchema?: Record<string, unknown> }> };
    for (const t of res.tools ?? []) {
      if (t.inputSchema && '$schema' in t.inputSchema) delete t.inputSchema.$schema;
    }
    return res;
  });
}

/**
 * Put back the arguments of a compound call (`system`, `accessibility`, …) that its schema does not list. The SDK
 * validates a call with zod, which drops unknown keys in silence, so the dispatcher never saw them: neither its "ignored
 * an argument" warning nor its refusal of a read it cannot limit to one window ran over MCP. `system ocr` with processId
 * read the whole screen, other apps' windows included, with no word about processId (Mac, 2026-11-17).
 *
 * The dropped keys are kept for the call (AsyncLocalStorage, so concurrent calls never mix) and merged under the
 * validated arguments in the tool's callback; a granular tool never gets them. Like stripRootSchemaDialect, this wraps
 * the handler in the low-level Server's handler map (an SDK internal), and does nothing if that map is not there.
 */
function keepUndeclaredArgs(server: McpServerLike, declared: Map<string, Set<string>>): void {
  const handlers = (server as unknown as {
    server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  }).server?._requestHandlers;
  const original = handlers?.get('tools/call');
  if (!handlers || !original) return;
  handlers.set('tools/call', (req, extra) => {
    const p = (req as { params?: { name?: unknown; arguments?: unknown } }).params;
    const known = typeof p?.name === 'string' ? declared.get(p.name) : undefined;
    const args = p?.arguments;
    if (!known || !args || typeof args !== 'object' || Array.isArray(args)) return original(req, extra);
    const more = Object.fromEntries(Object.entries(args).filter(([k]) => !known.has(k)));
    return Object.keys(more).length ? undeclaredArgs.run(more, () => original(req, extra)) : original(req, extra);
  });
}

/**
 * Start the stdio MCP transport. Used by `clawdcursor mcp` for editor
 * integrations (Claude Code, Cursor, Windsurf, Zed). Stdout becomes the
 * protocol channel; logs must already be redirected to stderr by the
 * caller.
 */
export async function startMcpStdio(server: McpServerLike): Promise<void> {
  const sdkStdio = await import('@modelcontextprotocol/sdk/server/stdio.js' as string) as {
    StdioServerTransport: new () => McpTransportLike;
  };
  const transport = new sdkStdio.StdioServerTransport();
  enableHostAncestry();  // this server's host is the process it was started from (core/ai-hosts.ts)
  await server.connect(transport);
}

/**
 * The streamable HTTP MCP transport, as one request handler for POST / GET / DELETE on the daemon's /mcp route.
 *
 * Two kinds of caller share the endpoint:
 *   - MCP SDK clients (editor hosts, agents) send `initialize`, then reuse the
 *     Mcp-Session-Id they get back and open a long-lived GET stream. Each such
 *     session gets its OWN server (from `createHandle`) and a stateful
 *     transport — the MCP TS SDK's jsonResponseStreamableHttp pattern. When the
 *     session closes, its session log is closed with it.
 *   - One-shot JSON-RPC posts with no initialize and no session (curl) get a
 *     fresh stateless transport on an idle server from a pool (a long tool call
 *     must not block another post).
 *
 * Previously ONE server was connected to a fresh transport per request. An SDK
 * client's GET stream (or any in-flight call) kept that server connected, so
 * every other request failed with "Already connected to a transport" (live,
 * Ubuntu VM 2026-10-15).
 *
 * `enableJsonResponse: true` keeps POST replies as one plain JSON-RPC body
 * instead of SSE (`event: message
data: …`), which single-JSON clients
 * (Claude Code's among them) need.
 *
 * Auth — the caller gates the route (the daemon's route table, http-utility.ts).
 */
export type McpHttpHandle = Pick<McpServerHandle, 'server'> & { sessionLog: Pick<SessionLog, 'end'> };

export async function startMcpHttp(
  createHandle: () => Promise<McpHttpHandle>,
): Promise<{ handle: (req: express.Request, res: express.Response) => void; close: () => Promise<void> }> {
  type HttpTransport = Omit<McpTransportLike, 'close'> & { sessionId?: string; onclose?: () => void; close: () => Promise<void> };
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js' as string
  ) as {
    StreamableHTTPServerTransport: new (opts: {
      sessionIdGenerator: (() => string) | undefined;
      enableJsonResponse: boolean;
      onsessioninitialized?: (sessionId: string) => void;
    }) => HttpTransport;
  };
  const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js' as string) as {
    isInitializeRequest: (value: unknown) => boolean;
  };
  const { randomUUID } = await import('crypto');

  const jsonError = (res: express.Response, status: number, code: number, message: string) => {
    if (!res.headersSent) res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  };

  // ── One-shot posts: stateless transport on an idle server ──
  const idle: McpServerLike[] = [];
  const oneShot = async (req: express.Request, res: express.Response, body: unknown) => {
    const srv = idle.pop() ?? (await createHandle()).server;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { await transport.close(); } catch { /* already closed */ }
      idle.push(srv);
    };
    res.on('close', () => { void release(); });
    try {
      await srv.connect(transport);
      await transport.handleRequest?.(req, res, body);
    } catch (err) {
      jsonError(res, 500, -32603, `MCP transport error: ${(err as Error).message}`);
      void release();
    }
  };

  // ── Sessions: a server + stateful transport per initialized client ──
  const IDLE_MS = 30 * 60_000;
  const sessions = new Map<string, { transport: HttpTransport; open: number; lastActive: number }>();
  const track = (s: { open: number; lastActive: number }, res: express.Response) => {
    s.open++;
    res.on('close', () => { s.open--; s.lastActive = Date.now(); });
  };
  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const s of sessions.values()) {
      if (s.open === 0 && s.lastActive < cutoff) void s.transport.close().catch(() => { /* gone */ });
    }
  }, 60_000);
  sweep.unref?.();

  const openSession = async (req: express.Request, res: express.Response, body: unknown) => {
    const transport: HttpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: id => { sessions.set(id, { transport, open: 0, lastActive: Date.now() }); },
    });
    const h = await createHandle();
    // A session's server is not reused: when its client goes away its session log is closed (the daemon's `live` set stays small).
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      h.sessionLog.end('the client session closed', 'session');
    };
    await h.server.connect(transport);
    await transport.handleRequest?.(req, res, body);
  };

  /** The request's session, or a 404 already sent for an unknown id. undefined = no session header. */
  const sessionOf = (req: express.Request, res: express.Response) => {
    const id = req.header('mcp-session-id');
    if (!id) return undefined;
    const s = sessions.get(id);
    if (!s) jsonError(res, 404, -32001, 'Session not found');
    return s ?? null;
  };

  // POST — JSON-RPC requests (Express has already parsed the body). GET — a session's server-to-client SSE stream
  // (stateless has none). DELETE — end a session.
  const handle = (req: express.Request, res: express.Response) => {
    void (async () => {
      try {
        const s = sessionOf(req, res);
        if (s === null) return;
        if (req.method !== 'POST') {
          if (!s) { res.status(405).set('Allow', 'POST').send('Method Not Allowed'); return; }
          track(s, res);
          await s.transport.handleRequest?.(req, res);
          return;
        }
        if (s) { track(s, res); await s.transport.handleRequest?.(req, res, req.body); return; }
        if (isInitializeRequest(req.body)) { await openSession(req, res, req.body); return; }
        await oneShot(req, res, req.body);
      } catch (err) {
        jsonError(res, 500, -32603, `MCP transport error: ${(err as Error).message}`);
      }
    })();
  };

  return {
    handle,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(s => s.transport.close().catch(() => { /* gone */ })));
      sessions.clear();
    },
  };
}
