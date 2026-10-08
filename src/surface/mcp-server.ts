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
import { evaluateToolCall } from '../tools/safety-gate';
import { controlBanner } from '../core/banner';
import { hasConsent, writeConsentFile } from './onboarding';
import { SessionLog, outcomeOf } from './session-log';

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
}

/**
 * Build a configured McpServer with all clawdcursor tools registered.
 *
 * The caller is responsible for connecting a transport via `server.connect(...)`.
 * Use `startMcpStdio` for editor integrations and `startMcpHttp` for the daemon.
 */
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
  // their own premium model — the expensive path — and never discover the
  // local fallback pipeline. The guidance differs by mode: only the daemon
  // (HTTP) context has a live agent, so only it can offer `task`.
  const instructions = ctx.agent
    ? // Daemon / HTTP MCP — the cheap local pipeline is available.
      'clawdcursor is a local desktop-automation execution layer. PREFER the ' +
      '`task` tool: it runs the full perceive→act→verify loop locally on a ' +
      'cheap model, so you spend almost no tokens driving the GUI yourself. ' +
      'Fall back to the granular tools only when you need fine-grained control. ' +
      'Every tool name carries a token-cost class — escalate in order: ' +
      '[act] (side-effect actions) < [inspect] (cheap structured reads) < ' +
      '[perceive-text] (a11y tree / OCR — no image bytes) < [perceive-image] (screenshot). ' +
      'For perception specifically: read the accessibility tree first; use OCR ' +
      '([perceive-text]) when the tree is empty or sparse; take a screenshot ' +
      '([perceive-image]) only as a last resort when both tree and OCR fail.'
    : // Stdio MCP (editor integration) — no pipeline; you drive the tools.
      'clawdcursor is a local desktop-automation tool layer. You drive the tools ' +
      'yourself. ' +
      (compact
        // Compact tools carry no per-tool cost prefix, so name the actions.
        ? 'Perceive BLIND FIRST, in this order: (1) `accessibility read_tree` / `find` / ' +
          '`compile_ui` — element names + screen positions, cheapest, start here; ' +
          '(2) `system copy_all_text` for the exact text of a page or document, `system ocr` ' +
          'when the tree is empty; (3) `computer screenshot` only as a last resort. ' +
          'ACT BY NAME: `accessibility invoke` / `smart_click` / `set_value` / `select` — ' +
          'coordinate clicks are the fallback. Accessibility positions are SCREEN ' +
          'coordinates: click them with `computer click` + space:"screen". '
        : 'To minimize tokens, follow the cost-class prefix on each tool — ' +
          '[act] < [inspect] < [perceive-text] < [perceive-image]. ' +
          'For perception always escalate in this order: ' +
          '(1) read the accessibility tree ([perceive-text], cheapest — start here); ' +
          '(2) use OCR ([perceive-text]) when the tree is empty or sparse; ' +
          '(3) capture a screenshot ([perceive-image]) only as a last resort when both fail. ' +
          'Prefer named-target actions (by a11y name) over pixel coordinates. ') +
      'For fully autonomous, low-cost execution, start the daemon (`clawdcursor agent`) ' +
      'and use the `task` tool — it runs a local cheap-model pipeline instead of your model. ' +
      '`task` waits up to 45s; longer tasks return {status:"running"} and CONTINUE in the ' +
      'background — re-call with the same instruction to keep waiting, task {action:"status"} ' +
      'to poll, task {action:"abort"} to stop. A timeout on your side is NOT a task failure. ' +
      'Drive UI symbolically: compile_ui / find_button / find_field return a stable ' +
      '{element_id, snapshot_id} you pass to invoke/set_value — it survives layout shifts, so ' +
      'prefer it over pixel coordinates. Pass `expect` on consequential actions so a failed one ' +
      'reports a DEVIATION instead of a hollow success. clawdcursor is a FALLBACK layer — prefer ' +
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
  const VISION_STREAK_HINT = (n: number) => compact
    ? `[clawdcursor] ${n} screenshots in a row with no text read. Cheaper and exact: accessibility compile_ui or smart_read (names + positions), system copy_all_text (exact page text); act by name with accessibility invoke / smart_click — coordinate clicks are the fallback.`
    : `[clawdcursor] ${n} screenshots in a row with no text read. Cheaper and exact: compile_ui / smart_read (names + positions), copy_all_text (exact page text); act by name with invoke_element / smart_click — coordinate clicks are the fallback.`;
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
            'It lets the AI use your mouse, keyboard and screen. Dangerous key combos stay ' +
            'blocked and destructive actions still ask first.',
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
          .refine(v => Array.isArray(v) || typeof v === 'string', {
            message: 'Expected an array (or a JSON-encoded array string).',
          })
          .meta({ type: 'array', items: def.items ?? { type: 'object' } });
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
      async (params: Record<string, unknown>): Promise<McpToolResult> => {
        // Consent gate (non-fatal): until the user accepts one-time consent,
        // every tool returns a clear, host-VISIBLE prompt instead of the server
        // dying with an opaque "failed". Re-checked per call so `clawdcursor
        // consent --accept` takes effect immediately, with no restart. A host
        // that supports elicitation asks the user in-app first.
        if (!hasConsent() && !(await askConsentInHost())) {
          return {
            content: [{ type: 'text', text:
              'clawdcursor needs one-time consent before it can control the desktop. ' +
              'Run `clawdcursor consent --accept` in a terminal once (or, if not installed globally — e.g. the npx-based plugin — ' +
              '`npx -y clawdcursor consent --accept`), then retry — no restart needed. ' +
              '(This grants the agent full mouse/keyboard/screen control of this machine.)'
            }],
            isError: true,
          };
        }
        // Pass the holder so el_NN refs resolve to their element label for
        // the destructive-label rule (Send/Delete/Pay) on the MCP route too.
        const safetyError = evaluateToolCall(tool, params ?? {}, { uiMaps: ctx.uiMaps });
        if (safetyError) {
          return { content: [{ type: 'text', text: safetyError.text }], isError: true };
        }
        // Transparency: any consequential (mutating) tool call from an
        // EXTERNAL agent pokes the on-screen control banner — it shows on the
        // first poke and auto-hides after ~30s of inactivity. Read-only
        // perception (tier 0) stays silent.
        if ((tool.safetyTier ?? 0) >= 1) controlBanner.touch();
        const action = typeof params?.action === 'string' ? params.action : undefined;
        const started = Date.now();
        let result;
        try {
          result = await tool.handler(params, ctx);
        } catch (err) {
          // A handler throw (e.g. projected tools' toolContextToAgent when the
          // platform adapter failed to init) must NOT propagate to the MCP SDK
          // — in stdio mode an unhandled rejection can corrupt the JSON-RPC
          // stream. Convert to a clean isError result.
          const msg = err instanceof Error ? err.message : String(err);
          sessionLog.record(tool.name, action, false, Date.now() - started, msg, clientInfo(), { outcome: outcomeOf(true, msg) });
          return { content: [{ type: 'text', text: `${tool.name}: ${msg}` }], isError: true };
        }
        const cls = sessionLog.record(tool.name, action, !result.isError, Date.now() - started,
          result.isError ? result.text : undefined, clientInfo(),
          { outcome: outcomeOf(!!result.isError, result.text ?? ''), space: typeof params?.space === 'string' ? params.space : undefined });
        // Blind first, then vision: field data showed agents drifting into a
        // screenshot → coordinate-click loop after an early blind miss. After
        // 3 screenshots with no text/a11y read in between (and every 5th
        // after), say once what the cheaper, exact path is.
        const streak = sessionLog.visionOnlyStreak;
        if (cls === 'vision' && !result.isError && streak >= 3 && (streak - 3) % 5 === 0) {
          result = { ...result, text: `${result.text}\n\n${VISION_STREAK_HINT(streak)}` };
        }
        const content: McpContentBlock[] = [];
        if (result.image) {
          content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
        }
        content.push({ type: 'text', text: result.text });
        return { content, isError: result.isError };
      },
    );
  }

  stripRootSchemaDialect(server);

  return { server, toolCount: tools.length, tools };
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
  await server.connect(transport);
}

/**
 * Mount the streamable HTTP MCP transport on an Express app at /mcp.
 *
 * Mounts both POST (JSON-RPC requests) and GET (SSE notifications), plus
 * DELETE for session termination. Returns the underlying transport so the
 * caller can close it on shutdown.
 *
 * Auth — the caller must apply Bearer-token middleware before this route
 * (mirrors the REST surface's requireAuth). We don't apply auth here so
 * tests and agent-mode can share the same mount with their own gate.
 */
export async function startMcpHttp(
  server: McpServerLike,
  app: express.Express,
  mountPath: string = '/mcp',
): Promise<{ close: () => Promise<void> }> {
  const sdkHttp = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js' as string
  ) as {
    StreamableHTTPServerTransport: new (opts: {
      sessionIdGenerator: undefined;
      enableJsonResponse: boolean;
    }) => McpTransportLike;
  };
  const { StreamableHTTPServerTransport } = sdkHttp;

  // Stateless mode: each POST is independent — no session init handshake
  // required. This makes the dashboard, `clawdcursor task` CLI, and
  // delegate_to_agent tool work as one-shot JSON-RPC clients without
  // needing to initialize and track an Mcp-Session-Id per call.
  //
  // CRITICAL: in stateless mode the SDK requires a FRESH transport per
  // HTTP request — a single shared transport accumulates per-request
  // state (response writers, in-flight message correlation) and
  // returns 500 on every call after the first. The pattern we use
  // here matches the MCP SDK's stateless example:
  //   for each request:
  //     1) construct a new transport
  //     2) server.connect(transport)
  //     3) transport.handleRequest(req, res, req.body)
  //     4) on response close → transport.close()
  //
  // This is per-request boilerplate, not per-connection — there's
  // still one McpServer (and one tool registry) for the whole daemon.
  // `enableJsonResponse: true` makes the SDK serialize tools/call results as
  // plain JSON-RPC instead of SSE (`event: message\ndata: {...}`). Without
  // this, MCP clients that expect a single JSON body (Claude Code's MCP
  // client among them) blow up with `Unexpected token 'e', "event: mes"...`
  // because the SDK defaults to text/event-stream for everything. We don't
  // need streaming progress here — `submit_task` is the only long-running
  // call, and even there a single final JSON response is the cleaner
  // contract for callers. Editor hosts that DO want streaming use stdio
  // MCP which has its own framing.
  const newTransport = () => new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const handle = async (req: express.Request, res: express.Response, body?: unknown) => {
    const transport = newTransport();
    res.on('close', () => {
      // Best-effort cleanup whenever the response ends, errors out, or the
      // client disconnects mid-stream.
      try { void transport.close?.(); } catch { /* swallow */ }
    });
    try {
      await server.connect(transport);
      await transport.handleRequest?.(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: `MCP transport error: ${(err as Error).message}` });
      }
    }
  };

  // POST /mcp — JSON-RPC requests. Express has already parsed the body
  // via express.json(); pass it through so the SDK doesn't re-read req.
  app.post(mountPath, (req, res) => { void handle(req, res, req.body); });

  // GET /mcp — SSE channel for server-initiated notifications.
  app.get(mountPath, (req, res) => { void handle(req, res); });

  // DELETE /mcp — explicit session termination (no-op in stateless).
  app.delete(mountPath, (req, res) => { void handle(req, res); });

  return {
    close: async () => {
      // Per-request transports clean themselves up on response close;
      // nothing global to tear down.
    },
  };
}
