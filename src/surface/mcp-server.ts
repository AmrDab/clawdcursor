/**
 * MCP Server — the single point of construction for clawdcursor's MCP
 * surface. Used by both the stdio transport (editor integrations like
 * Claude Code, Cursor, Windsurf) and the streamable-HTTP transport
 * (the long-running `clawdcursor agent` daemon).
 *
 * Why this module exists
 * ----------------------
 * Up to v0.8.x clawdcursor had two transports:
 *   - REST API in src/server.ts   (the daemon's /task /favorites /etc)
 *   - MCP stdio    in src/index.ts (the `mcp` subcommand, inline-built)
 *
 * v0.9 PR7 collapses those into a single MCP server with two transport
 * flavors. createMcpServer() is the registry-to-MCP adapter; the
 * transports are independent and either or both can be active.
 *
 * The HTTP transport is mounted on the existing Express app at /mcp,
 * with the same Bearer-token requireAuth middleware the REST routes used.
 * That keeps localhost-only auth invariants identical across transports.
 */

import type express from 'express';
import type { ZodTypeAny } from 'zod';
import { VERSION } from './version';
import type { ToolContext, ToolDefinition } from '../tools/registry';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { controlBanner } from '../core/banner';
import { osKeysGuide } from '../platform/keys';
import { enableHostAncestry } from '../core/ai-hosts';
import { ownUiRefusal, isPauseSafeCall, isStopSafeCall } from '../core/own-ui-guard';
import { isStopped, STOPPED_TEXT, actedIn, actRecord } from '../core/control';
import { logger } from '../core/observability/logger';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact';

const COMPOUND_TOOLS = new Set(Object.keys(COMPOUND_ROUTE_INDEX));
import { hasConsent, writeConsentFile } from './onboarding';
import { SessionLog, outcomeOf } from './session-log';
import { withSteps, watchChildProcesses } from '../core/observability/steps';
import { classifyResult, renderResultLine, isJsonText, isActingAction, isUnverifiableAction } from '../core/result-codes';
import { isImagePointerCall, isFullScreenshotCall, imagePointerRefusal, noteScreenshot, VISION_DISABLED_REFUSAL } from '../tools/screen-guard';

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
  /** Called once when the client session this server was made for closes. */
  onSessionEnd?: (reason: string) => void;
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

/** Options for createMcpServer. */
export interface CreateMcpServerOptions {
  /** When true, expose the 6-compound surface instead of granular. */
  compact?: boolean;
  /** Subsystem context every tool handler receives. */
  ctx: ToolContext;
}

/** A constructed MCP server with its registered tool count. */
export interface McpServerHandle {
  /** The configured McpServer instance — connect a transport via .connect(). */
  server: McpServerLike;
  /** Number of tools registered (mirrors the surface size). */
  toolCount: number;
  /** Snapshot of the tools that were registered (in registration order). */
  tools: ToolDefinition[];
  /** This server's session record: the stdio entry closes it with the exit reason. */
  sessionLog: SessionLog;
}

/**
 * Build a configured McpServer with all clawdcursor tools registered.
 *
 * The caller is responsible for connecting a transport via `server.connect(...)`.
 * Use `startMcpStdio` for editor integrations and `startMcpHttp` for the daemon.
 */
/** A compact (tool, action), or a granular tool reached through its compound route, that changes something. */
function isActingCall(toolName: string, action: string | undefined, test: typeof isActingAction = isActingAction): boolean {
  if (toolName in COMPOUND_ROUTE_INDEX) return test(toolName, action);
  for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
    const route = routes.find(r => r.delegate === toolName);
    if (route) return test(compound, route.action);
  }
  return false;
}

/** Does any step of a batch (compact or granular tool names) change something? */
function batchActs(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some(s => {
    const step = (s ?? {}) as { name?: unknown; arguments?: { action?: unknown }; args?: { action?: unknown } };
    const action = step.arguments?.action ?? step.args?.action;
    return typeof step.name === 'string' && isActingCall(step.name, typeof action === 'string' ? action : undefined);
  });
}

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
  const instructions =
      'clawdcursor is a local desktop-automation tool layer. You drive the tools ' +
      'yourself. ' +
      (compact
        // Compact tools carry no per-tool cost prefix, so name the actions.
        ? 'TO SEE: (1) accessibility read_tree lists the window\'s elements by name; ' +
          '(2) system copy_all_text gives the exact text of a page; ' +
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
      'Roadblocks only the user can clear (sign-in, 2FA, CAPTCHA, a step that needs their confirmation): call system {action:"pause_for_user", message} — ' +
      'ask for that ONE step only ("Sign in to Glama") and do everything before and after it yourself; for a sign-in, code or CAPTCHA, done_when ' +
      '(what shows on screen once they are done) ends the pause the moment they finish, with no Resume click — never for a confirmation or a choice. Never type or guess credentials. ' +
      'A step your own rules won\'t let you take (creating an account, downloading a private key, entering a password, key or token) is a roadblock too, ' +
      'not a reason to turn the task down: hand over that step, as wide as your rules draw it, and do the rest they allow. When a secret must go into a field or a terminal prompt, put the cursor there ' +
      'and ask only for the paste ("Paste your app-specific password into the Terminal, press Enter, then click Resume"), naming where it goes: never into the prompt\'s own reply box, whose text reaches you; afterwards pass the saved key\'s file path or keychain profile name, never the secret. A plan limit or upgrade wall is a roadblock too: ' +
      'stop, quote the blocking text and pause_for_user; never click Upgrade / Subscribe yourself. ' +
      'While you are driving the desktop, the user is watching the screen, not your chat: ask them on the pause card (use choices when there are options), not in your own chat — ' +
      'system {action:"pause_for_user", message, choices:[...], input:{placeholder?, multiline?}}. Before an irreversible action the user did not ask for (sending, deleting, paying, closing unsaved work), ask there first and follow the answer {status:"replied", choice | reply}: clawdcursor does not judge what you do, so that decision is yours. ' +
      'Drive UI symbolically: compile_ui / find_button / find_field return a stable ' +
      '{element_id, snapshot_id} you pass to invoke/set_value — it survives layout shifts, so ' +
      'prefer it over pixel coordinates. Pass `expect` on consequential actions so a failed one ' +
      'reports a DEVIATION instead of a hollow success. Each action result and error ends with one line: ' +
      '[confirmed | unverified | refused · CODE · hint · next | failed · CODE · hint · next] — follow its next call instead of guessing. ' +
      'clawdcursor is a FALLBACK layer — prefer ' +
      'a native API, CLI, or direct file edit when one exists; reach for it when the only surface ' +
      'is a GUI. Full usage guide: the `clawdcursor` skill registered in your agent, or ' +
      'https://clawdcursor.com/llms.txt.';

  const server = new McpServer({ name: 'clawdcursor', version: VERSION }, { instructions });

  // First tool call without consent: ask the USER in the host's own UI (MCP
  // elicitation) instead of telling them to go run a terminal command. The
  // model cannot answer an elicitation — the host shows it to the person.
  // Asked at most once per server: concurrent calls share the one prompt, and
  // a decline is not re-asked on every call (the text prompt takes over).
  // Local record of this session (tool / action / blind-vs-vision / ok — no
  // content). Feeds `clawdcursor report` and the vision-streak nudge below.
  const sessionLog = new SessionLog({ version: VERSION, surface: compact ? 'compact' : 'granular' });
  watchChildProcesses();  // each child process a call starts is one of its steps (steps.ts)
  const VISION_STREAK_HINT = (n: number) => compact
    ? `[clawdcursor] ${n === 1 ? 'A screenshot before any text was read.' : `${n} screenshots in a row with no text read.`} Cheaper and exact: accessibility compile_ui or smart_read (names + positions), system copy_all_text (exact page text); act by name with accessibility invoke / smart_click — coordinate clicks are the fallback.`
    : `[clawdcursor] ${n === 1 ? 'A screenshot before any text was read.' : `${n} screenshots in a row with no text read.`} Cheaper and exact: compile_ui / smart_read (names + positions), copy_all_text (exact page text); act by name with invoke_element / smart_click — coordinate clicks are the fallback.`;
  const clientInfo = () => (server as unknown as { server?: { getClientVersion?: () => { name?: string; version?: string } | undefined } })
    .server?.getClientVersion?.();

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
  const tools = compact ? getCompactSurface() : getAllTools();

  for (const tool of tools) {
    // Convert parameter defs to a Zod schema map. The MCP SDK uses zod
    // shape objects (Record<string, ZodType>) — not full ZodObjects.
    const zodParams: Record<string, ZodTypeAny> = {};
    for (const [key, def] of Object.entries(tool.parameters)) {
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
      zodParams[key] = schema;
    }

    // MCP SDK 1.29 arg parsing breaks if schema is undefined (shifts callback
    // position). Always pass a schema — use empty object for parameterless tools.
    const hasParams = Object.keys(zodParams).length > 0;
    // Phase A: surface the token-cost class to the tool-picking LLM. The
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
        const withOutcome = (text: string, isError: boolean): string => {
          if (tool.name === 'batch' || isJsonText(text)) return text;
          const c = classifyResult(text, isError, isActingCall(tool.name, callAction, isUnverifiableAction), 'mcp', isActingCall(tool.name, callAction));
          return c ? `${text}\n${renderResultLine(c)}` : text;
        };
        // Consent gate (non-fatal): until the user accepts one-time consent,
        // every tool returns a clear, host-VISIBLE prompt instead of the server
        // dying with an opaque "failed". Re-checked per call so `clawdcursor
        // consent --accept` takes effect immediately, with no restart. A host
        // that supports elicitation asks the user in-app first.
        if (!hasConsent() && !(await askConsentInHost())) {
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
        // The user's stop comes right after consent and before every other refusal (screen binding, own UI):
        // an agent told "no screenshot taken" never learns the user took control back (control.ts).
        if (isStopped() && !isStopSafeCall(tool.name, callAction)) {
          const label = callAction ? `${tool.name} {action:"${callAction}"}` : tool.name;
          logger.warn('safety.refused', { tool: tool.name, action: callAction, guard: 'stopped', reason: STOPPED_TEXT });
          sessionLog.record(tool.name, callAction, false, 0, STOPPED_TEXT, clientInfo(), { outcome: 'refused' });
          return { content: [{ type: 'text', text: withOutcome(`${label}: ${STOPPED_TEXT}`, true) }], isError: true };
        }
        // Transparency: any consequential (mutating) tool call from an
        // EXTERNAL agent pokes the on-screen control banner — it shows on the
        // first poke and auto-hides after ~30s of inactivity. Read-only
        // perception (tier 0) stays silent.
        // Compound tools (compact surface) decide per action in dispatchCompound.
        if ((tool.safetyTier ?? 0) >= 1 && !COMPOUND_TOOLS.has(tool.name)) controlBanner.touch();
        // A batch that acts at any step shows the pill from its start: its first step may be a 30 s wait, and a pill that
        // is not there cannot be double-clicked (#294).
        if (tool.name === 'batch' && batchActs(params?.steps)) controlBanner.touch();
        const action = typeof params?.action === 'string' ? params.action : undefined;
        // A guard that refuses logs its own verdict.
        const refuse = (guard: string, why: string): McpToolResult => {
          const label = action ? `${tool.name} {action:"${action}"}` : tool.name;
          logger.warn('safety.refused', { tool: tool.name, action, guard, reason: why });
          sessionLog.record(tool.name, action, false, 0, why, clientInfo(), { outcome: 'refused' });
          return { content: [{ type: 'text', text: withOutcome(`${label}: ${why}`, true) }], isError: true };
        };
        // Screenshot-bound pointer actions: image coordinates from a screenshot of a screen that has since changed
        // point at something else (screen-binding.ts).
        if (isImagePointerCall(tool.name, action, params ?? {})) {
          const why = await imagePointerRefusal(ctx, params ?? {});
          if (why) return refuse('screen_binding', why);
        }
        // The user's own controls (the pill, the pause prompt) are never a target, and nothing acts while a pause waits.
        // Last before the handler: a pause that came up during the checks above still stops it.
        const ownUi = ownUiRefusal(params, isPauseSafeCall(tool.name, action), isStopSafeCall(tool.name, action));
        if (ownUi) return refuse('own_ui', ownUi);
        const started = Date.now();
        const wasIn = actedIn();
        // The app this call acted in, labelled as on the pill: each act keeps its own foreground read, so the same one means it did not.
        // What this call acted on, as the input guard verified it when it sent the act (control.ts actRecord).
        const acted = () => actRecord(wasIn);
        const releasePill = controlBanner.hold();  // the call has control until it returns, waits included
        sessionLog.running(tool.name, action, clientInfo());
        const run = await withSteps(tool.name, action, () => tool.handler(params, ctx));  // where the call's time went
        releasePill();
        if (!run.ok) {
          // A handler throw (e.g. projected tools' toolContextToAgent when the
          // platform adapter failed to init) must NOT propagate to the MCP SDK
          // — in stdio mode an unhandled rejection can corrupt the JSON-RPC
          // stream. Convert to a clean isError result.
          const err = run.error;
          const msg = err instanceof Error ? err.message : String(err);
          sessionLog.record(tool.name, action, false, Date.now() - started, msg, clientInfo(), { outcome: outcomeOf(true, msg), ...acted(), timing: run.steps });
          return { content: [{ type: 'text', text: withOutcome(`${tool.name}: ${msg}`, true) }], isError: true };
        }
        let result = run.result;
        // High-security mode: no image reaches the model, whichever tool produced it. The capture stays in memory and
        // is dropped here, before the screenshot is recorded as one the model has seen.
        if (ctx.disableVision && result.image) {
          return refuse('no_vision', VISION_DISABLED_REFUSAL);
        }
        if (!result.isError && isFullScreenshotCall(tool.name, action)) {
          result = { ...result, text: `${result.text}\n${await noteScreenshot(ctx)}` };
        }
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
        const cls = sessionLog.record(tool.name, action, !result.isError, Date.now() - started,
          result.isError ? result.text : undefined, clientInfo(),
          { outcome: batchRefused ? 'refused' : outcomeOf(!!result.isError, result.text ?? ''), space: typeof params?.space === 'string' ? params.space : undefined,
            ...acted(), steps, timing: run.steps, ...(result.pressedKeys ? { cls: 'act-other' as const } : {}) });
        // Blind first, then vision: field data showed agents drifting into a
        // screenshot → coordinate-click loop after an early blind miss. After
        // 3 screenshots with no text/a11y read in between (and every 5th
        // after), say once what the cheaper, exact path is.
        const streak = sessionLog.visionOnlyStreak;
        // The first screenshot of a session that has read nothing yet is the cheapest moment to say it.
        const firstBlind = streak === 1 && sessionLog.summary.blind === 0;
        if (cls === 'vision' && !result.isError && (firstBlind || (streak >= 3 && (streak - 3) % 5 === 0))) {
          result = { ...result, text: `${result.text}\n\n${VISION_STREAK_HINT(streak)}` };
        }
        const content: McpContentBlock[] = [];
        if (result.image) {
          content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
        }
        content.push({ type: 'text', text: withOutcome(result.text, !!result.isError) });
        return { content, isError: result.isError };
      },
    );
  }

  stripRootSchemaDialect(server);

  return { server, toolCount: tools.length, tools, sessionLog };
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
/**
 * MCP tool annotations: the tool's own, else derived — tier 0 reads only; an input tool carries destructiveHint only when
 * it declares `destructive: true` (closing a window, overwriting the clipboard, opening a file or URI, page script).
 * The values are the ones 1.5.27 published: hosts build their own approval UI on them, so they change only on purpose.
 */
export function toolAnnotations(tool: Pick<ToolDefinition, 'annotations' | 'safetyTier' | 'destructive'>): NonNullable<ToolDefinition['annotations']> {
  if (tool.annotations) return tool.annotations;
  return (tool.safetyTier ?? 1) === 0 ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: tool.destructive === true };
}

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
 * Mount the streamable HTTP MCP transport on an Express app at /mcp.
 *
 * Two kinds of caller share the endpoint:
 *   - MCP SDK clients (editor hosts, agents) send `initialize`, then reuse the
 *     Mcp-Session-Id they get back and open a long-lived GET stream. Each such
 *     session gets its OWN server (from `createServer`) and a stateful
 *     transport — the MCP TS SDK's jsonResponseStreamableHttp pattern.
 *   - One-shot JSON-RPC posts with no initialize and no session (the
 *     dashboard, curl) get a fresh stateless transport on
 *     an idle server: `server` when it is free, another from `createServer`
 *     while it is busy (a long tool call must not block a status poll).
 *
 * Previously ONE server was connected to a fresh transport per request. An SDK
 * client's GET stream (or any in-flight call) kept that server connected, so
 * every other request failed with "Already connected to a transport" (live,
 * Ubuntu VM 2026-10-15).
 *
 * `enableJsonResponse: true` keeps POST replies as one plain JSON-RPC body
 * instead of SSE (`event: message\ndata: …`), which single-JSON clients
 * (Claude Code's among them) need.
 *
 * Auth — the caller must apply Bearer-token middleware before this route.
 */
export async function startMcpHttp(
  server: McpServerLike,
  app: express.Express,
  mountPath: string = '/mcp',
  createServer?: () => Promise<McpServerLike>,
): Promise<{ close: () => Promise<void> }> {
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
  const idleServers: McpServerLike[] = [server];
  const oneShot = async (req: express.Request, res: express.Response, body: unknown) => {
    const srv = idleServers.pop() ?? (createServer ? await createServer() : undefined);
    if (!srv) { jsonError(res, 503, -32000, 'MCP server busy — retry'); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { await transport.close(); } catch { /* already closed */ }
      idleServers.push(srv);
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
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    const srv = await createServer!();
    // A session's server is not reused: when its client goes away its session log is closed (the daemon's `live` set stays small).
    const closed = transport.onclose;
    transport.onclose = () => { closed?.(); srv.onSessionEnd?.('the client session closed'); };
    await srv.connect(transport);
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

  // POST /mcp — JSON-RPC requests. Express has already parsed the body.
  app.post(mountPath, (req, res) => {
    void (async () => {
      try {
        const s = sessionOf(req, res);
        if (s === null) return;
        if (s) { track(s, res); await s.transport.handleRequest?.(req, res, req.body); return; }
        if (createServer && isInitializeRequest(req.body)) { await openSession(req, res, req.body); return; }
        await oneShot(req, res, req.body);
      } catch (err) {
        jsonError(res, 500, -32603, `MCP transport error: ${(err as Error).message}`);
      }
    })();
  });

  // GET /mcp — a session's server-to-client SSE stream. Stateless has none.
  // DELETE /mcp — end a session.
  const sessionOnly = (req: express.Request, res: express.Response) => {
    void (async () => {
      try {
        const s = sessionOf(req, res);
        if (s === null) return;
        if (!s) { res.status(405).set('Allow', 'POST').send('Method Not Allowed'); return; }
        track(s, res);
        await s.transport.handleRequest?.(req, res);
      } catch (err) {
        jsonError(res, 500, -32603, `MCP transport error: ${(err as Error).message}`);
      }
    })();
  };
  app.get(mountPath, sessionOnly);
  app.delete(mountPath, sessionOnly);

  return {
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(s => s.transport.close().catch(() => { /* gone */ })));
      sessions.clear();
    },
  };
}
