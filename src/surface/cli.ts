#!/usr/bin/env node

/**
 * 🐾 Clawd Cursor — AI Desktop Agent
 *
 * Your AI controls your desktop natively.
 */

// Node.js v25+ on macOS: undici's fetch() can crash with EINVAL on setTypeOfService.
// The throw happens asynchronously inside libuv's socket machinery, so it CANNOT
// be try/caught at a call site — a process-level handler is the only intercept
// point. #114 scopes it as tightly as a global handler allows:
//   - the swallow matches ONE exact signature (code+syscall) AND only on darwin,
//     the only platform where the kernel no-op occurs;
//   - every other uncaught exception crashes with FULL provenance (name,
//     message, stack) and a non-zero exit — same observable semantics as
//     Node's default handler, plus our prefix for log correlation.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (process.platform === 'darwin' && err?.code === 'EINVAL' && err?.syscall === 'setTypeOfService') {
    // Known-benign: Node v25+ tries to set the IP QoS/TOS socket option via
    // undici's fetch(); macOS doesn't support it. The request continues — this
    // is purely a kernel-level no-op. Debug-level so it stays observable.
    console.debug('[clawdcursor] uncaughtException swallowed (known-benign): setTypeOfService EINVAL on macOS/Node v25+');
    return;
  }
  console.error(`Uncaught exception: ${err?.stack ?? err}`);
  process.exit(1);
});

// v0.8.1: unhandledRejection handler.
// Prior behavior: rejected promises inside the agent loop killed the Node
// process with only Node's default warning — HTTP clients would see connection
// drops with no trace. Log through the new leveled logger so correlation IDs
// come along, and keep the server running (server stability > loud death).
// In CLI mode (no active server) we still exit 1 to surface the bug.
process.on('unhandledRejection', (reason: any) => {
  try {
    // Lazy-require to avoid pulling the pipeline module at cold CLI startup.
    const { logger } = require('../core/observability/logger');
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('unhandledRejection', { msg, stack });
  } catch {
    // Logger itself failed — fall back to stderr.

    console.error('unhandledRejection (logger unavailable):', reason);
  }
  // In server mode, (process.env.CLAWD_SERVER_MODE === '1') keep running.
  // In CLI / one-shot mode, exit to surface the bug.
  if (process.env.CLAWD_SERVER_MODE !== '1') {
    process.exit(1);
  }
});

import { Command } from 'commander';
import { Agent } from '../core/agent';
import { createUtilityServer, requireAuth, initServerToken, getServerLogBuffer, isLoopbackHost, mountJson404 } from './http-utility';
import { DEFAULT_CONFIG } from '../types';
import type { ClawdConfig } from '../types';
import { VERSION } from './version';
import dotenv from 'dotenv';
import { resolveApiConfig } from '../llm/credentials';
import { resolveConfig } from '../llm/config';
import * as fs from 'fs';
import * as path from 'path';
import pc from 'picocolors';
import { migrateFromLegacyDir, getPackageRoot } from '../paths';
import { ensureHostAppRunning, stopHostApp } from '../platform/native-helper';
import { UIMapHolder } from '../core/sense/ui-map-holder';

dotenv.config({ quiet: true });

// Migrate data from legacy ~/.openclaw/clawdcursor/ to ~/.clawdcursor/
migrateFromLegacyDir();

// ── Auth helper ──────────────────────────────────────────────────────────────
// Reads the saved Bearer token from ~/.clawdcursor/token (written by start/serve).
function loadAuthToken(): string {
  try {
    const tokenPath = path.join(require('os').homedir(), '.clawdcursor', 'token');
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return '';
  }
}
function authHeaders(): Record<string, string> {
  const token = loadAuthToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── Emoji gate (shared utility) ──────────────────────────────────────────────
import { e } from './format';

// ── Single-instance pidfile lock ─────────────────────────────────────────────
// Implementation lives in ./pidfile so it can be unit-tested independently.
// The richer JSON lockfile records process start time, which lets the
// liveness check distinguish a real live duplicate from a recycled PID
// (the bug behind "Failed to reconnect to clawdcursor: -32000" on Windows).
import { claimPidFile, releasePidFile, isProcessAlive, pidFilePath, readPidLoose } from './pidfile';

/**
 * Graceful exit on a startup-time init failure (bad API key, no providers,
 * etc.). Synchronous `process.exit(N)` while async handles are mid-close
 * triggers libuv asserts on Windows ("Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING), src\\win\\async.c:76") — so set the exit code, kick
 * off cleanup, and let the event loop drain. A 2-second hard-kill safety
 * net guarantees the process always exits even if a handle gets stuck.
 */
function gracefulExitOnInitFailure(code: number, agent: { disconnect: () => unknown }): void {
  process.exitCode = code;
  releasePidFile('start');
  try { agent.disconnect(); } catch { /* non-fatal */ }
  // Hard-kill safety net: if the loop hangs, force-exit after 2s.
  // .unref() so the timer itself doesn't keep the loop alive.
  setTimeout(() => process.exit(code), 2000).unref();
}

const program = new Command();

async function isClawdInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json() as any;
    return data.status === 'ok' && typeof data.version === 'string';
  } catch {
    return false;
  }
}

async function forceKillPort(port: number): Promise<boolean> {
  const { execSync } = await import('child_process');
  const os = await import('os');

  // #114: only ever kill processes that are plausibly OURS. The port is
  // configurable and ports get reused — blindly SIGKILLing whatever listens on
  // it can take down an unrelated app (dev server, another tool). clawdcursor
  // always runs under node, so a listener with any other image name is not
  // ours: skip it, tell the user, and let them resolve the conflict.
  const OURS = /node|clawdcursor/i;

  if (os.platform() === 'win32') {
    try {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8' },
      );
      const pids = new Set(
        output.trim().split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
      );

      if (pids.size === 0) return false;
      let killedAny = false;
      for (const pid of pids) {
        let image = '';
        try {
          const row = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' });
          image = (row.split(',')[0] ?? '').replace(/"/g, '').trim();
        } catch { /* tasklist unavailable — treat as unknown */ }
        if (image && !OURS.test(image)) {
          console.warn(`${e('⚠️', '[WARN]')} Port ${port} is held by "${image}" (pid ${pid}) — not a clawdcursor process; refusing to kill it. Free the port or change server.port.`);
          continue;
        }
        execSync(`taskkill /F /PID ${pid}`);
        console.log(`${e('🐾', '>')} Killed process ${pid}${image ? ` (${image})` : ''}`);
        killedAny = true;
      }
      return killedAny;
    } catch {
      return false;
    }
  }

  // Non-Windows: enumerate PIDs explicitly before killing, mirroring the
  // Windows branch above. Running `kill -9 $(lsof -ti tcp:N)` with an empty
  // substitution sends SIGKILL with no target argument — behavior is
  // distro-dependent and can erroneously kill the current process on some
  // systems. Instead: capture lsof output, parse PIDs in JS, and only kill
  // when we have at least one confirmed PID.
  try {
    const lsofOut = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8', shell: '/bin/sh' });
    const pids = lsofOut.trim().split(/\s+/)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n > 0);

    if (pids.length === 0) return false;
    let killedAny = false;
    for (const pid of pids) {
      let image = '';
      try {
        image = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf-8', shell: '/bin/sh' }).trim();
      } catch { /* ps unavailable / pid gone — treat as unknown */ }
      if (image && !OURS.test(image)) {
        console.warn(`${e('⚠️', '[WARN]')} Port ${port} is held by "${image}" (pid ${pid}) — not a clawdcursor process; refusing to kill it. Free the port or change server.port.`);
        continue;
      }
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`${e('🐾', '>')} Killed process ${pid}${image ? ` (${image})` : ''}`);
        killedAny = true;
      } catch (err: any) {
        // ESRCH = the process already exited between lsof and now — that's
        // success for our purpose (the port is free). Re-throw anything else
        // (e.g. EPERM) so the outer catch returns false.
        if (err?.code !== 'ESRCH') throw err;
      }
    }
    return killedAny;
  } catch {
    return false;
  }
}

program
  .name('clawdcursor')
  .description('🐾 AI Desktop Agent — native screen control')
  .version(VERSION);

// ── Agent mode (v0.9 PR7.4) ────────────────────────────────────────────
//
// Single daemon entry point. Replaces the legacy `start` (full daemon with
// LLM) and `serve` (tool-only, no LLM) commands; both still exist as
// deprecated aliases that print a warning and proxy to runAgentMode.
//
// Surface mounted on the daemon's port (default 3847):
//   GET  /         — dashboard (calls /mcp via JSON-RPC)
//   GET  /health   — readiness probe (no auth)
//   POST /stop     — graceful shutdown (auth + localhost-only)
//   POST /mcp      — MCP streamable-HTTP transport (auth)
//   GET  /mcp      — MCP SSE channel (auth)
//   DELETE /mcp    — MCP session terminate (auth)
//
// v0.9 daemon mode auto-detects whether an LLM is configured and adapts:
//   - LLM available → autonomous agent + MCP tool surface (full mode)
//   - LLM missing   → MCP tool surface only, agent disabled
//                     (drives clawdcursor from an external host's brain)
//
// `--no-llm` is also supported as an explicit force-tools-only mode. That
// matters for smoke tests, editor hosts, and users with stale credentials:
// the daemon starts the HTTP MCP surface without validating credentials,
// creating an Agent, or registering scheduled tasks.
interface AgentModeOpts {
  port?: string;
  provider?: string;
  model?: string;
  textModel?: string;
  visionModel?: string;
  baseUrl?: string;
  apiKey?: string;
  debug?: boolean;
  accept?: boolean;
  noVision?: boolean;
  noLlm?: boolean;
  skipConsent?: boolean;
  compact?: boolean;
  /** Commander `--no-banner` → false. Undefined = banner enabled (default). */
  banner?: boolean;
}

async function runAgentMode(opts: AgentModeOpts): Promise<void> {
  // commander stores negated flags as `{ llm: false }` / `{ vision: false }`.
  // Keep the internal explicit names so callers/tests can also pass noLlm /
  // noVision directly.
  const forceNoLlm = Boolean(opts.noLlm || (opts as any).llm === false);
  const forceNoVision = Boolean(opts.noVision || (opts as any).vision === false);

  // Single-instance guard — uses the legacy `start` lockfile name so
  // existing `clawdcursor stop` sweeps still find it.
  const existingPid = claimPidFile('start');
  if (existingPid !== null) {
    console.error(`${e('❌', '[ERR]')} clawdcursor agent is already running (pid ${existingPid}). Run \`clawdcursor stop\` first.`);
    process.exit(1);
  }

  // ── Consent ──
  const { hasConsent, writeConsentFile, runOnboarding } = await import('./onboarding');
  const canSkipDev = opts.skipConsent && process.env.NODE_ENV === 'development';
  if (opts.accept) {
    writeConsentFile();
    console.log('  Consent recorded.\n');
  } else if (!canSkipDev && !hasConsent()) {
    const accepted = await runOnboarding('start', parseInt(opts.port ?? '3847', 10) || 3847);
    if (!accepted) process.exit(1);
  }

  if (process.platform === 'darwin') {
    await ensureHostAppRunning();
  }

  // ── Port pre-check ──
  const requestedPort = parseInt(opts.port ?? '3847', 10) || 3847;
  const requestedHost = '127.0.0.1';
  const net = await import('net');
  const portFree = await new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(); resolve(true); });
    tester.listen(requestedPort, requestedHost);
  });
  if (!portFree) {
    console.error(`\n${e('❌', '[ERR]')} Port ${requestedPort} is already in use.`);
    console.error(`Another clawdcursor instance may be running.`);
    console.error(`Run 'clawdcursor stop' first, or use --port <other_port>`);
    process.exit(1);
  }

  // ── First-run auto-setup — best-effort, never fatal. ──
  // If no AI providers are found we still boot: the MCP tool surface
  // works fine without an LLM (the host's brain drives it).
  //
  // Skip auto-detect entirely when CLI flags already supply a usable
  // model wiring — otherwise we'd print the misleading "No AI providers
  // found — booting in tools-only mode" line moments before "Using
  // externally configured models: text=X" (BUG-A: contradictory boot
  // banners). The CLI-flag path knows its own answer.
  const configPath = path.join(getPackageRoot(), '.clawdcursor-config.json');
  const cliSuppliesLlm = Boolean(
    opts.apiKey
    || (opts.baseUrl && (opts.textModel || opts.visionModel || opts.model))
    || ((opts.textModel || opts.visionModel || opts.model) && opts.provider),
  );
  if (!forceNoLlm && !cliSuppliesLlm && !fs.existsSync(configPath)) {
    console.log(`${e('🔍', '*')} First run — auto-detecting AI providers...\n`);
    const { quickSetup } = await import('./doctor');
    const pipeline = await quickSetup();
    if (pipeline) {
      console.log(`${e('✅', '[OK]')} Auto-configured! Run \`clawdcursor doctor\` to customize.\n`);
    } else {
      console.log(`${e('ℹ️', 'i')}  No AI providers found — booting in tools-only mode.`);
      console.log('   Your editor host (Claude Code, Cursor, Windsurf, OpenClaw) drives the tools.');
      console.log('   Run `clawdcursor doctor` later if you want the built-in autonomous agent.\n');
    }
  }

  const resolved = resolveConfig({
    cliFlags: {
      apiKey:      opts.apiKey,
      baseUrl:     opts.baseUrl,
      textModel:   opts.textModel,
      visionModel: opts.visionModel,
      model:       opts.model,
      provider:    opts.provider,
      port:        opts.port,
      debug:       opts.debug,
      noVision:    forceNoVision,
    },
  });

  const config: ClawdConfig = {
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      port: resolved.port,
    },
    ai: {
      provider: resolved.provider || DEFAULT_CONFIG.ai.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      textBaseUrl: resolved.textBaseUrl,
      textApiKey: resolved.textApiKey,
      visionBaseUrl: resolved.visionBaseUrl,
      visionApiKey: resolved.visionApiKey,
      model: resolved.model,
      visionModel: resolved.visionModel,
    },
    debug: resolved.debug,
  };

  // Auto-detect LLM availability: if neither a text nor a vision model is
  // resolvable, the daemon still boots, but in tools-only mode. The MCP
  // surface is fully available; the autonomous-agent path is disabled.
  const llmAvailable = !forceNoLlm && Boolean(
    resolved.apiKey || resolved.textApiKey || resolved.visionApiKey
    || (resolved.baseUrl && (resolved.model || resolved.visionModel))
    || (resolved.textBaseUrl && resolved.model)
    || (resolved.visionBaseUrl && resolved.visionModel)
  );
  // SECURITY (#113): this surface is full desktop control. Loopback-only by
  // default — a non-loopback bind (0.0.0.0 / LAN IP in config.server.host)
  // requires an explicit `--allow-remote`, so a config typo can't silently
  // expose the machine with only the bearer token in the way.
  if (!isLoopbackHost(config.server.host)) {
    if (!(opts as { allowRemote?: boolean }).allowRemote) {
      console.error(
        `${e('🛑', '[BLOCKED]')} Refusing to bind to non-loopback host "${config.server.host}".\n` +
        `   This endpoint grants FULL desktop control; exposing it beyond 127.0.0.1 means\n` +
        `   anyone on the network with the bearer token can drive this machine.\n` +
        `   If that is really what you want, restart with:  clawdcursor agent --allow-remote\n` +
        `   Otherwise set server.host back to 127.0.0.1 in your config.`,
      );
      process.exit(1);
    }
    console.warn(
      `${e('⚠️', '[WARN]')} --allow-remote: binding to "${config.server.host}" — desktop control is\n` +
      `   reachable from the network. The Bearer token is the ONLY protection. Prefer an\n` +
      `   SSH tunnel or VPN over exposing this directly.`,
    );
  }

  const modeLabel = llmAvailable ? '' : ' (tools-only)';
  console.log(`${pc.green('✓')} ${pc.bold('clawdcursor')} ${pc.gray(`v${VERSION}`)} ${pc.gray(`— desktop control active on ${config.server.host}:${config.server.port}${modeLabel}`)}`);

  // ── Agent (only when an LLM is configured) ──
  let agent: Agent | undefined;
  if (llmAvailable) {
    agent = new Agent(config, resolved);
    try {
      await agent.connect();
    } catch (err) {
      console.error(`\n${e('❌', '[ERR]')} Failed to initialize native desktop control: ${err}`);
      console.error(`\nThis usually means @nut-tree-fork/nut-js couldn't access the screen.`);
      console.error(`Make sure you're running this on a desktop with a display.`);
      process.exit(1);
    }
  }

  // ── Scheduler (recurring tasks via cron) ──
  // Loads persisted ScheduledTask[] from ~/.clawdcursor/scheduled-tasks.json
  // and registers every enabled cron job. Idempotent. Only active when an
  // agent is wired — the scheduler dispatches through agent.executeTask().
  // Stdio MCP and `agent --no-llm` skip this; the scheduler tools still load
  // but return an error explaining that no agent context is bound.
  if (agent) {
    try {
      const { initScheduler } = await import('../tools/scheduler');
      const minimalLog = {
        info:  (event: string, data?: unknown) => console.log(`[scheduler] ${event}`, data ?? ''),
        warn:  (event: string, data?: unknown) => console.warn(`[scheduler] ${event}`, data ?? ''),
        error: (event: string, data?: unknown) => console.error(`[scheduler] ${event}`, data ?? ''),
      };
      const result = initScheduler(agent, minimalLog);
      if (result.registered > 0 || result.failed > 0) {
        console.log(`   ${e('⏰', '[CRN]')} Scheduler: ${result.registered} active job(s)${result.failed ? `, ${result.failed} failed` : ''}`);
      }
    } catch (err) {
      console.warn(`   ${e('⚠️', '[WARN]')} Scheduler init failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // ── HTTP utility surface (/, /health, /stop) + MCP transport at /mcp ──
  const serverShutdown = {
    onAbort: () => {
      agent?.abort();
    },
    onStop: async () => {
      try {
        // Lazy require — only attempt when agent existed (scheduler bound).
        if (agent) {
          const { stopScheduler } = require('../tools/scheduler');
          stopScheduler();
        }
      } catch { /* non-fatal */ }
      // Abort the in-flight task and let the loop settle so the user sees
      // the "aborted by user" acknowledgment instead of a silent hard kill.
      try {
        agent?.abort();
        await agent?.waitForIdle(2000);
      } catch { /* non-fatal */ }
      agent?.disconnect();
    },
  };
  const app = createUtilityServer({
    host: config.server.host,
    ...serverShutdown,
  });

  // ── On-screen control banner: double-click = the `clawdcursor stop` flow ──
  // (same abort → graceful-stop → exit sequence as POST /stop, same grace
  // window and hard-kill net). Disable with --no-banner / CLAWD_NO_BANNER=1.
  const { controlBanner } = await import('../core/banner');
  if (opts.banner === false) controlBanner.setEnabled(false);
  controlBanner.configure({
    onStopRequested: () => {
      console.log(`\n${e('🛑', '[STOP]')} Control banner double-clicked — running the stop flow...`);
      try { serverShutdown.onAbort(); } catch { /* non-fatal */ }
      const grace = Promise.resolve().then(() => serverShutdown.onStop()).catch(() => {});
      const cap = new Promise<void>(resolve => setTimeout(resolve, 2500));
      void Promise.race([grace, cap]).then(() => process.exit(0));
      setTimeout(() => process.exit(1), 6000); // hard-kill safety net
    },
  });

  // Build the ToolContext shared by every MCP handler. In agent mode it
  // reuses the agent's already-connected NativeDesktop and AccessibilityBridge;
  // in --no-llm mode it boots a fresh ToolContext like the legacy serve cmd.
  const { getPlatform } = await import('../platform');

  // One UIMapHolder per daemon session — shared by the agent loop (via runAgent
  // deps) and the MCP surface (via toolCtx → toolContextToAgent bridge). Mirror
  // how cdpDriver is wired: create once here, attach to the agent, pass via ctx.
  const uiMapHolder = new UIMapHolder();

  let toolCtx: any;
  if (agent) {
    let platform: import('../platform/types').PlatformAdapter | undefined;
    try { platform = await getPlatform(); } catch { /* non-fatal */ }

    // The Agent class doesn't currently own a CDPDriver — that bridge lives
    // on the toolCtx for both `agent` and `agent --no-llm`. Without this,
    // navigate_browser / cdp_* tools hit "Cannot read properties of
    // undefined" on first call. Instantiate one here and wire it into the
    // context so the MCP catalog has the same surface in both modes.
    const { CDPDriver } = await import('../platform/cdp-driver');
    const { DEFAULT_CDP_PORT } = await import('../llm/browser-config');
    const cdp = (agent as any).cdpDriver ?? new CDPDriver(DEFAULT_CDP_PORT);
    if (!(agent as any).cdpDriver) (agent as any).cdpDriver = cdp;
    if (!(agent as any).uiMapHolder) (agent as any).uiMapHolder = uiMapHolder;

    // Mouse-scale: agent mode used to hardcode 1, which broke every
    // vision-driven click on HiDPI. The contract for mouse_* tools is
    // "input is image-space coords, scale internally to whatever the
    // input driver expects." On Windows + recent nut-js the driver
    // operates in physical-pixel space, so the right factor is
    // physical / image = getScaleFactor(). On 2× DPI: image (418, 453)
    // × 2 → click at physical (836, 906) — which IS image (418, 453)
    // visually. On 1× DPI: factor = 1, no change. Fixes the "agent
    // sees the orange circle, clicks the sidebar 2× to the left" bug.
    toolCtx = {
      desktop: agent.getDesktop(),
      a11y: (agent as any).a11y,
      cdp,
      uiMaps: uiMapHolder,
      platform,
      agent,
      getLogBuffer: getServerLogBuffer,
      getMouseScaleFactor: () => agent!.getDesktop().getScaleFactor(),
      getScreenshotScaleFactor: () => agent!.getDesktop().getScaleFactor(),
      ensureInitialized: async () => {},  // agent already initialized
    };
  } else {
    toolCtx = await createToolContext();
    toolCtx.ensureInitialized().catch((err: any) => {
      console.error('Subsystem init failed:', err?.message);
    });
    if (toolCtx.cdp) {
      toolCtx.cdp.connect().then(() => {
        console.log(`   ${e('🌐', '[NET]')} CDP connected to browser`);
      }).catch(() => {
        console.log(`   ${e('ℹ️', 'i')} CDP: no browser detected (will retry when web tools are called)`);
      });
    }
    toolCtx.getLogBuffer = getServerLogBuffer;
    toolCtx.uiMaps = uiMapHolder;
  }

  // Mount /mcp behind the same Bearer-auth gate the legacy REST routes used.
  // Compact-over-HTTP: default granular for backward compatibility (the
  // dashboard at / calls 9 granular tool names — see dashboard.ts). External
  // agent hosts can opt into the 7-compound public surface via
  // `clawdcursor agent --compact` or `CLAWD_MCP_COMPACT=1`.
  const compactSurface = opts.compact === true || process.env.CLAWD_MCP_COMPACT === '1';
  let mcpToolCount = 0;
  try {
    const { createMcpServer, startMcpHttp } = await import('./mcp-server');
    const { server: mcpServer, toolCount } = await createMcpServer({ compact: compactSurface, ctx: toolCtx });
    mcpToolCount = toolCount;
    app.use('/mcp', requireAuth);
    await startMcpHttp(mcpServer, app, '/mcp');
  } catch (err) {
    console.warn('MCP HTTP transport not loaded:', (err as Error).message);
  }

  // LAST mount — JSON 404 for unmatched routes (must come after /mcp).
  mountJson404(app);

  app.listen(config.server.port, config.server.host, async () => {
    const serverToken = initServerToken();
    const tokenPath = path.join(require('os').homedir(), '.clawdcursor', 'token');
    console.log(`\n${pc.green(`${e('🌐', '[NET]')} API server:`)} http://${config.server.host}:${config.server.port}`);
    console.log(`${pc.yellow(`${e('🔑', '[KEY]')} Auth token:`)} ${serverToken.slice(0, 8)}...`);
    console.log(pc.gray(`   (full token saved to ${tokenPath})`));
    console.log(`\nSurviving HTTP routes:`);
    console.log(`  GET  /         — Dashboard (calls /mcp via JSON-RPC)`);
    console.log(`  GET  /health   — Readiness probe (no auth)`);
    console.log(`  POST /abort    — Abort the in-flight task (auth, localhost only)`);
    console.log(`  POST /stop     — Graceful shutdown (auth, localhost only)`);
    console.log(`\nMCP endpoint (the only protocol):`);
    console.log(`  POST /mcp      — JSON-RPC tools/call & tools/list (auth) — ${compactSurface ? 'compact' : 'granular'} surface, ${mcpToolCount} tools`);
    console.log(`  GET  /mcp      — SSE notifications (auth)`);
    if (!compactSurface) {
      console.log(pc.gray(`   (tip: pass --compact or set CLAWD_MCP_COMPACT=1 to expose the 7-compound public surface)`));
    }
    console.log(`\nAll mutating endpoints require: ${pc.cyan('Authorization: Bearer <token>')}`);

    if (llmAvailable) {
      const { loadPipelineConfig } = await import('./doctor');
      // Pass the resolved CLI overlay so the validation/print path sees the
      // same pipeline config the agent runtime will use.
      const pipelineConfig = loadPipelineConfig(resolved);
      if (pipelineConfig && pipelineConfig.layer2.enabled) {
        try {
          const { callTextLLMDirect } = await import('../llm/client');
          const { PROVIDERS, PROVIDER_ENV_VARS } = await import('../llm/providers');
          const { inferProviderFromBaseUrl } = await import('../llm/credentials');
          const layer2ProviderKey = inferProviderFromBaseUrl(pipelineConfig.layer2.baseUrl) || pipelineConfig.providerKey;
          const layer2Provider = PROVIDERS[layer2ProviderKey] || pipelineConfig.provider;
          const layer2ApiKey = (PROVIDER_ENV_VARS[layer2ProviderKey] || [])
            .map((k: string) => process.env[k]).find((v: string | undefined) => v && v.length > 0)
            || pipelineConfig.apiKey;
          await callTextLLMDirect({
            baseUrl: pipelineConfig.layer2.baseUrl,
            model: pipelineConfig.layer2.model,
            apiKey: layer2ApiKey,
            isAnthropic: !layer2Provider.openaiCompat,
            messages: [{ role: 'user', content: 'Reply with just the word "ok"' }],
            maxTokens: 5,
            timeoutMs: 10000,
            retries: 0,
          });
          console.log(`${e('✅', '[OK]')} API key validated for ${layer2Provider.name}`);
          // Print the resolved model wiring so the user can see which model
          // drives reasoning (text) vs perception (vision) BEFORE any task
          // runs. Without this you only see model names on the task header,
          // which is too late if the wiring is wrong (mismatched provider,
          // unexpected default, stale .clawdcursor-config.json).
          try {
            const textModel   = pipelineConfig.layer2?.model   || '(default)';
            const visionModel = pipelineConfig.layer3?.model   || '(default)';
            const textBase    = pipelineConfig.layer2?.baseUrl || '(provider default)';
            const visionBase  = pipelineConfig.layer3?.baseUrl || textBase;
            const visionState = pipelineConfig.layer3?.enabled === false ? ' [disabled]' : '';
            console.log(pc.gray(`   text  : ${textModel}   ← ${textBase}`));
            console.log(pc.gray(`   vision: ${visionModel}${visionState}   ← ${visionBase}`));
          } catch { /* non-fatal — boot continues either way */ }
        } catch (err: any) {
          if (err.name === 'LLMAuthError') {
            console.error(`\n${e('❌', '[ERR]')} API key INVALID for ${pipelineConfig.provider.name} (${pipelineConfig.layer2.model})`);
            console.error(`   The saved config has an expired or revoked key. Tools-only mode still works.\n`);
            const staleConfig = path.join(getPackageRoot(), '.clawdcursor-config.json');
            try { fs.unlinkSync(staleConfig); } catch { /* ok */ }
            console.error(`   ${e('🗑️', '[DEL]')}  Removed stale config. Fix your key and restart:`);
            console.error(`   1. Update your API key in .env or environment variables`);
            console.error(`   2. Run: clawdcursor agent   (will re-detect providers)`);
            console.error(`   Or run: clawdcursor doctor   to reconfigure manually\n`);
            if (agent) gracefulExitOnInitFailure(1, agent);
            else process.exit(1);
            return;
          } else if (err.name === 'LLMBillingError') {
            console.error(`\n${e('❌', '[ERR]')} API credits exhausted for ${pipelineConfig.provider.name}`);
            console.error(`   Add credits or switch providers, then restart.`);
            console.error(`   Run: clawdcursor doctor   to reconfigure\n`);
            if (agent) gracefulExitOnInitFailure(1, agent);
            else process.exit(1);
            return;
          } else {
            console.warn(`${e('⚠️', '[WARN]')} Could not validate API key: ${err.message?.substring(0, 100)}`);
          }
        }
      } else if (config.ai.model || config.ai.visionModel) {
        console.log(`${e('✅', '[OK]')} Using externally configured models: text=${config.ai.model} | vision=${config.ai.visionModel}`);
      }

      const { MIN_RECOMMENDED_CONTEXT } = await import('../llm/providers');
      const ctxWindow = pipelineConfig?.provider?.textContextWindow;
      if (ctxWindow && ctxWindow < MIN_RECOMMENDED_CONTEXT) {
        console.warn(`${e('⚠️', '[WARN]')} Text model context window (${Math.round(ctxWindow / 1000)}K) is below the recommended minimum (${Math.round(MIN_RECOMMENDED_CONTEXT / 1000)}K).`);
        console.warn(`   Web pages with many elements may overflow. Consider using a larger model.`);
        console.warn(`   Run: clawdcursor doctor   to switch models\n`);
      }
    } else {
      // Tools-only mode — the MCP catalog is fully available, the autonomous
      // agent is disabled (no LLM was configured). External hosts (Claude
      // Code, Cursor, Windsurf, OpenClaw) drive the verbs directly.
      console.log(`${e('🐾', '>')} Tools-only mode. Connect any MCP-capable host — your model drives the verbs.`);
      console.log(`   Run \`clawdcursor doctor\` if you want to enable the built-in autonomous agent later.`);
    }

    console.log(`\nReady. ${e('🐾', '')}`);
  });

  process.on('SIGINT', () => {
    console.log(`\n${e('👋', '--')} Shutting down...`);
    releasePidFile('start');
    agent?.disconnect();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    releasePidFile('start');
    agent?.disconnect();
    process.exit(0);
  });
}

program
  .command('agent')
  .description('Start the clawdcursor daemon (autonomous agent + MCP-over-HTTP)')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .option('--model <model>', 'Vision model to use')
  .option('--text-model <model>', 'Text/reasoning model for Layer 2')
  .option('--vision-model <model>', 'Vision model for Layer 3')
  .option('--base-url <url>', 'Custom API base URL (OpenAI-compatible)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .option('--accept', 'Accept desktop control consent non-interactively and start')
  .option('--no-vision', 'Refuse vision fallback — blind-first only (high-security mode)')
  .option('--no-llm', 'Force tools-only HTTP MCP mode; skip AI setup, scheduler, and credential validation')
  .option('--skip-consent', 'Skip consent prompt (requires NODE_ENV=development)')
  .option('--compact', 'Expose the 7-compound MCP surface (computer/accessibility/window/system/browser/task/batch) over HTTP /mcp instead of the 98 granular tools (also CLAWD_MCP_COMPACT=1)')
  .option('--allow-remote', 'Permit binding to a non-loopback server.host. DANGER: exposes full desktop control to the network; the Bearer token is the only protection')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts) => {
    await runAgentMode(opts);
  });

program
  .command('start')
  .description('[deprecated — use `clawdcursor agent`] Start the Clawd Cursor agent')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .option('--model <model>', 'Vision model to use')
  .option('--text-model <model>', 'Text/reasoning model for Layer 2')
  .option('--vision-model <model>', 'Vision model for Layer 3')
  .option('--base-url <url>', 'Custom API base URL (OpenAI-compatible)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .option('--accept', 'Accept desktop control consent non-interactively and start')
  .option('--no-vision', 'Refuse vision fallback — blind-first only (high-security mode)')
  .option('--no-llm', 'Force tools-only HTTP MCP mode; skip AI setup, scheduler, and credential validation')
  .option('--compact', 'Expose the 7-compound MCP surface over HTTP /mcp (also CLAWD_MCP_COMPACT=1)')
  .option('--allow-remote', 'Permit binding to a non-loopback server.host. DANGER: exposes full desktop control to the network; the Bearer token is the only protection')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts) => {
    // v0.9 PR7.4 — `start` is now a thin deprecation alias for `agent`.
    // The legacy /task /favorites /execute REST surface was deleted; callers
    // that still ran `clawdcursor start` keep working through this proxy
    // until v0.10. Removed in v0.10.
    console.warn(`${e('⚠', '[WARN]')} \`clawdcursor start\` is deprecated; use \`clawdcursor agent\`. Removed in v0.10.`);
    await runAgentMode(opts);
  });

// ── Legacy start command body deleted in PR7.4 ──
// The runAgentMode() function above is the canonical implementation.
// `start` and `serve` are now thin deprecation aliases.

program
  .command('doctor')
  .description('🩺 Diagnose setup and configure the AI provider — only needed for `clawdcursor agent` (the autonomous daemon with its own LLM). Driving clawdcursor from your own agent over MCP needs no doctor: consent + (macOS) `grant` is the whole setup.')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--no-save', 'Don\'t save config to disk')
  .option('--reset', 'Delete saved config and re-detect everything from scratch')
  .action(async (opts) => {
    const { runDoctor } = await import('./doctor');
    const resolvedApi = resolveApiConfig({
      apiKey: opts.apiKey,
      provider: opts.provider,
    });

    if (opts.reset) {
      const configPath = path.join(getPackageRoot(), '.clawdcursor-config.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        console.log(`${e('🗑️', '[DEL]')}  Cleared saved config — re-detecting from scratch\n`);
      }
    }

    // Only use explicit CLI flags for single-provider override.
    // Auto-detected external credentials should go through multi-provider scan.
    const isExplicit = !!(opts.apiKey || opts.provider);
    await runDoctor({
      apiKey: isExplicit ? resolvedApi.apiKey : undefined,
      provider: isExplicit ? (resolvedApi.provider || opts.provider) : undefined,
      baseUrl: isExplicit ? resolvedApi.baseUrl : undefined,
      textModel: isExplicit ? resolvedApi.textModel : undefined,
      visionModel: isExplicit ? resolvedApi.visionModel : undefined,
      save: opts.save !== false,
    });
  });

program
  .command('status')
  .description('📊 Check readiness status (consent, permissions, AI config)')
  .action(async () => {
    const { printStatusReport } = await import('./readiness');
    await printStatusReport();
  });

program
  .command('grant')
  .description('🔐 Request macOS permissions (triggers system permission dialogs)')
  .action(async () => {
    if (process.platform !== 'darwin') {
      console.log('Permission grants are only needed on macOS.');
      return;
    }
    const { requestPermissions } = await import('../platform/native-helper');
    console.log('🔐 Requesting macOS permissions...');
    console.log('   System dialogs may appear — please allow access.\n');
    try {
      const perms = await requestPermissions();
      console.log(`   Accessibility:    ${perms.accessibility ? '✅ Granted' : '❌ Denied'}`);
      console.log(`   Screen Recording: ${perms.screenRecording ? '✅ Granted' : '❌ Denied'}`);
      if (perms.accessibility && perms.screenRecording) {
        console.log('\n🎉 All permissions granted — ready for desktop control!');
      } else {
        console.log('\n⚠️  Some permissions still missing. Grant them in System Settings, then run this again.');
      }
    } catch (err) {
      console.error(`❌ Failed to request permissions: ${err}`);
      console.error('   Ensure ClawdCursor.app is built: cd native && ./build.sh');
    }
  });

program
  .command('stop')
  .description('Stop a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number');
      process.exit(1);
    }
    const isClawd = await isClawdInstance(port);
    if (!isClawd) {
      console.log(`${e('🐾', '>')} No running instance found on port ` + port);
      if (process.platform === 'darwin') {
        await stopHostApp();
      }
      return;
    }

    // Abort first so any active task exits quickly before shutdown.
    try {
      await fetch(`http://127.0.0.1:${port}/abort`, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(2000) });
    } catch {
      // Best effort only.
    }

    const url = `http://127.0.0.1:${port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(5000) });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log(`${e('🐾', '>')} Clawd Cursor stopped`);
      } else {
        console.error('Unexpected response:', JSON.stringify(data));
      }
    } catch {
      // fetch may fail because server died mid-response — that's actually success
    }

    // Verify it actually stopped (wait up to 3s)
    let serverStopped = false;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        // Still alive — keep waiting
      } catch {
        // Connection refused = dead = success
        console.log(`${e('✅', '[OK]')} Server confirmed stopped`);
        serverStopped = true;
        break;
      }
    }
    if (!serverStopped) {
      console.log(`${e('⚠️', '[WARN]')}  Graceful stop did not complete — force killing...`);
      const killed = await forceKillPort(port);
      if (killed) {
        console.log(`${e('🐾', '>')} Clawd Cursor force stopped`);
      } else {
        console.error(`${e('❌', '[ERR]')} Could not force stop process on port ` + port);
      }
    }

    // v0.8.3 — also sweep every other clawdcursor-owned pidfile (mcp, serve,
    // start) and kill anything still alive. The old `stop` only targeted
    // port 3847 via `/stop`, which missed `mcp` (stdio, no port) and any
    // zombie `serve` / `start` that had crashed-but-not-released its pidfile.
    // User-reported symptom: "Outlook keeps opening" — a stale serve process
    // was still receiving MCP / REST traffic after the user thought they'd
    // stopped. This sweep ensures `clawdcursor stop` means stop EVERYTHING.
    let sweptCount = 0;
    for (const mode of ['start', 'mcp', 'serve'] as const) {
      try {
        const pidPath = pidFilePath(mode);
        if (!fs.existsSync(pidPath)) continue;
        // readPidLoose accepts both legacy bare-int and the new JSON format.
        const pid = readPidLoose(mode);
        if (pid === null || pid === process.pid) { fs.unlinkSync(pidPath); continue; }
        if (isProcessAlive(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            // Give it a moment to exit gracefully, then SIGKILL if still up.
            await new Promise(r => setTimeout(r, 500));
            if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
            sweptCount++;
            console.log(`${e('🐾', '>')} Stopped ${mode} instance (pid ${pid})`);
          } catch {
            // Could not kill — the process may be owned by a different user.
            console.warn(`${e('⚠', '[WARN]')} Could not stop ${mode} pid ${pid}`);
          }
        }
        // Clean up the pidfile regardless.
        try { fs.unlinkSync(pidPath); } catch {}
      } catch { /* best-effort */ }
    }
    if (sweptCount > 0) {
      console.log(`${e('✅', '[OK]')} Swept ${sweptCount} additional clawdcursor instance${sweptCount === 1 ? '' : 's'}`);
    }

    if (process.platform === 'darwin') {
      await stopHostApp();
    }
  });

program
  .command('task [text]')
  .description('Send a task to a running Clawd Cursor instance (interactive if no text given)')
  .option('--port <port>', 'API server port', '3847')
  .action(async (text, opts) => {
    const url = `http://127.0.0.1:${opts.port}/mcp`;

    const sendTask = async (taskText: string) => {
      try {
        console.log(`\n${e('🐾', '>')} Sending: ${taskText}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...authHeaders(),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'submit_task', arguments: { task: taskText } },
          }),
        });
        if (res.status === 401) {
          console.error('Auth failed (401). Token mismatch — run: clawdcursor stop && clawdcursor agent');
          return;
        }
        if (!res.ok) {
          console.error(`Server error (${res.status}). Check server logs.`);
          return;
        }
        const data = await res.json() as any;
        if (data?.error) {
          console.error(`MCP error: ${data.error.message ?? JSON.stringify(data.error)}`);
          return;
        }
        // Pull the task result text out of the JSON-RPC envelope
        const content = data?.result?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') console.log(block.text);
          }
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      } catch {
        console.error(`Failed to connect to Clawd Cursor at ${url}`);
        console.error('Is the agent running? Start it with: clawdcursor agent');
      }
    };

    if (text) {
      // One-shot mode: clawdcursor task "Open Calculator"
      await sendTask(text);
    } else {
      // Interactive mode: spawn a new terminal window
      const os = await import('os');
      const { execFile: spawnExec } = await import('child_process');
      const platform = os.platform();

      const token = loadAuthToken();
      const scriptContent = platform === 'win32'
        ? // Windows: PowerShell script
          `
$host.UI.RawUI.WindowTitle = "Clawd Cursor - Task Console"
Write-Host "Clawd Cursor - Interactive Task Mode" -ForegroundColor Cyan
Write-Host "   Type a task and press Enter. Type 'quit' to exit." -ForegroundColor Gray
Write-Host ""
$headers = @{ "Content-Type" = "application/json"; "Accept" = "application/json, text/event-stream"${token ? `; "Authorization" = "Bearer ${token}"` : ''} }
$rpcId = 0
while ($true) {
    $task = Read-Host "Enter task"
    if (-not $task -or $task -eq "quit" -or $task -eq "exit") {
        Write-Host "Bye!"
        break
    }
    # Strip control characters (Ctrl+L, etc.) that break JSON
    $task = $task -replace '[\\x00-\\x1f]', ''
    $task = $task.Trim()
    if (-not $task) { continue }
    Write-Host "> Sending: $task" -ForegroundColor Yellow
    try {
        $rpcId = $rpcId + 1
        $body = @{
            jsonrpc = '2.0'
            id      = $rpcId
            method  = 'tools/call'
            params  = @{ name = 'submit_task'; arguments = @{ task = $task } }
        } | ConvertTo-Json -Depth 6 -Compress
        $response = Invoke-RestMethod -Uri http://127.0.0.1:${opts.port}/mcp -Method POST -Headers $headers -Body $body
        if ($response.error) {
            Write-Host ("MCP error: " + ($response.error.message)) -ForegroundColor Red
        } elseif ($response.result -and $response.result.content) {
            foreach ($block in $response.result.content) {
                if ($block.type -eq 'text') { Write-Host $block.text }
            }
        } else {
            $response | ConvertTo-Json -Depth 5
        }
    } catch {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 401) {
                Write-Host 'Auth failed (401). Token mismatch. Run: clawdcursor stop then clawdcursor agent' -ForegroundColor Red
            } else {
                Write-Host "Server error ($code). Check server logs." -ForegroundColor Red
            }
        } else {
            Write-Host 'Failed to connect. Is clawdcursor agent running?' -ForegroundColor Red
        }
    }
    Write-Host ""
}
`
        : // macOS/Linux: bash script
          `
echo "Clawd Cursor - Interactive Task Mode"
echo "   Type a task and press Enter. Type 'quit' to exit."
echo ""
AUTH_HEADER="${token ? `Authorization: Bearer ${token}` : ''}"
RPC_ID=0
while true; do
    printf "Enter task: "
    read task
    if [ -z "$task" ] || [ "$task" = "quit" ] || [ "$task" = "exit" ]; then
        echo "Bye!"
        break
    fi
    echo "> Sending: $task"
    RPC_ID=$((RPC_ID + 1))
    # JSON-encode the task by piping through python; falls back to naive escape if python missing
    BODY=$(python3 -c "import json,sys; print(json.dumps({'jsonrpc':'2.0','id':$RPC_ID,'method':'tools/call','params':{'name':'submit_task','arguments':{'task':sys.argv[1]}}}))" "$task" 2>/dev/null) || BODY="{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$RPC_ID,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"submit_task\\",\\"arguments\\":{\\"task\\":\\"$task\\"}}}"
    curl -s -X POST http://127.0.0.1:${opts.port}/mcp \\
      -H "Content-Type: application/json" \\
      -H "Accept: application/json, text/event-stream"${token ? ' \\\n      -H "$AUTH_HEADER"' : ''} \\
      -d "$BODY" \\
      | python3 -c "import json,sys; r=json.load(sys.stdin); content=r.get('result',{}).get('content',[]); [print(b.get('text','')) for b in content if b.get('type')=='text']" 2>/dev/null \\
      || echo "Failed to connect. Is clawdcursor agent running?"
    echo ""
done
`;

      if (platform === 'win32') {
        // Write temp PS1 and open in new Windows Terminal / PowerShell window
        const fs = await import('fs');
        const path = await import('path');
        // Private 0700 temp dir (mkdtemp, unguessable suffix) — this script is
        // EXECUTED, so a predictable tmpdir/clawdcursor-task-<time>.ps1 name was a
        // symlink/race window (CWE-377). The dir persists for the spawned terminal.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-task-'));
        const tmpScript = path.join(tmpDir, 'task.ps1');
        fs.writeFileSync(tmpScript, scriptContent);
        spawnExec('powershell.exe', [
          '-Command', `Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${tmpScript}'`
        ], { detached: true, stdio: 'ignore' } as any);
      } else if (platform === 'darwin') {
        const fs = await import('fs');
        const path = await import('path');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-task-'));
        const tmpScript = path.join(tmpDir, 'task.sh');
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('open', ['-a', 'Terminal', tmpScript], { detached: true, stdio: 'ignore' } as any);
      } else {
        // Linux fallback
        const fs = await import('fs');
        const path = await import('path');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-task-'));
        const tmpScript = path.join(tmpDir, 'task.sh');
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        // $TERMINAL may be set with surrounding quotes on some distros — strip them before use.
        const termEnv = (process.env.TERMINAL || '').replace(/^["']|["']$/g, '').trim();
        const termExec = termEnv || 'x-terminal-emulator';
        spawnExec(termExec, ['-e', tmpScript], { detached: true, stdio: 'ignore' } as any);
      }

      console.log(`${e('🐾', '>')} Task console opened in a new terminal window.`);
    }
  });

program
  .command('uninstall')
  .description('Remove all Clawd Cursor config, data, and skill registrations')
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`\n${e('❌', '[ERR]')}  clawdcursor uninstall requires an interactive terminal.\n`);
      process.exit(1);
    }

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const readline = await import('readline');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n${e('⚠️', '[WARN]')}  This will remove all Clawd Cursor config and data. Continue? (y/N) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    console.log(`\n${e('🗑️', '[DEL]')}  Uninstalling Clawd Cursor...\n`);
    const clawdRoot = getPackageRoot();
    const homeDir = os.homedir();
    let removed = 0;
    const failed: string[] = [];

    // Resilient remove: never let one locked / permission-denied path abort the
    // whole uninstall. On Windows a file handle (a running daemon, the logger's
    // current log file, AV/indexer) can briefly hold a path open → EPERM/EBUSY.
    // rmSync's maxRetries rides out the transient lock; the try/catch downgrades
    // a hard failure to a warning + manual-cleanup hint and CONTINUES to the next
    // step (the old code threw here, crashing as an unhandledRejection and
    // leaving the install half-removed).
    const safeRemove = (target: string, label: string): void => {
      try {
        if (!fs.existsSync(target)) return;
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(target);
        else fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        console.log(`   ${e('🗑️', '[DEL]')}  Removed ${label}`);
        removed++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code || (err as Error).message;
        failed.push(`${target} (${code})`);
        console.log(`   ${e('⚠️', '[WARN]')}  Could not remove ${label} (${code}) — close any running clawdcursor, then delete manually: ${target}`);
      }
    };

    // 0. Stop any running server first (before deleting token)
    try {
      const tokenPath = path.join(homeDir, '.clawdcursor', 'token');
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        const resp = await fetch('http://127.0.0.1:3847/stop', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          console.log(`   ${e('🛑', '[STOP]')}  Stopped running server`);
          // Give it a moment to shut down
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch { /* server not running — that's fine */ }

    // 0b. Fallback: if /stop didn't work, try killing via pidfile.
    // readPidLoose() handles both the new JSON format and the legacy
    // bare-int format from pre-0.9.2 lockfiles, so this works whether
    // the running process is stale-old or freshly-installed.
    for (const mode of ['start', 'mcp', 'serve'] as const) {
      try {
        if (!fs.existsSync(pidFilePath(mode))) continue;
        const pid = readPidLoose(mode);
        if (pid !== null && pid !== process.pid) {
          try {
            process.kill(pid, 0); // check if alive
            process.kill(pid, 'SIGTERM');
            console.log(`   ${e('🛑', '[STOP]')}  Killed running ${mode} process (pid ${pid})`);
            await new Promise(r => setTimeout(r, 500));
          } catch { /* process already dead */ }
        }
      } catch { /* pidfile read failed — that's fine */ }
    }

    // 1. Remove config files in project root
    const configFiles = [
      path.join(clawdRoot, '.clawdcursor-config.json'),
      path.join(clawdRoot, '.clawdcursor-favorites.json'),
      path.join(clawdRoot, '.env'),
    ];
    for (const f of configFiles) safeRemove(f, path.basename(f));

    // 2. Remove ~/.clawdcursor data directory (token, consent, task logs, pid)
    safeRemove(path.join(homeDir, '.clawdcursor'), path.join(homeDir, '.clawdcursor'));
    // Also remove legacy data directory
    safeRemove(path.join(homeDir, '.clawd-cursor'), `legacy ${path.join(homeDir, '.clawd-cursor')}`);

    // 3. Remove debug folder
    safeRemove(path.join(clawdRoot, 'debug'), 'debug/');

    // 4. Remove external skill registrations (OpenClaw, Codex, etc.)
    const skillPaths = [
      path.join(homeDir, '.openclaw', 'workspace', 'skills', 'clawdcursor'),
      path.join(homeDir, '.openclaw-dev', 'workspace', 'skills', 'clawdcursor'),
      path.join(homeDir, '.openclaw', 'skills', 'clawdcursor'),
      path.join(homeDir, '.codex', 'skills', 'clawdcursor'),
    ];
    for (const sp of skillPaths) safeRemove(sp, `skill registration: ${sp}`);

    // 5. Remove MCP server entries from known config files
    const mcpConfigs = [
      // Claude Code
      path.join(homeDir, '.claude', 'settings.json'),
      path.join(homeDir, '.claude', 'settings.local.json'),
      // Cursor
      path.join(homeDir, '.cursor', 'mcp.json'),
      // Windsurf
      path.join(homeDir, '.windsurf', 'mcp.json'),
      path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
      // VS Code / Continue
      path.join(homeDir, '.vscode', 'mcp.json'),
    ];
    for (const configPath of mcpConfigs) {
      try {
        if (!fs.existsSync(configPath)) continue;
        const raw = fs.readFileSync(configPath, 'utf-8');
        const json = JSON.parse(raw);
        // Look for "clawdcursor" or "clawd-cursor" key in mcpServers
        const servers = json.mcpServers || json.servers || {};
        let found = false;
        for (const key of Object.keys(servers)) {
          if (key.toLowerCase().includes('clawdcursor') || key.toLowerCase().includes('clawd-cursor')) {
            delete servers[key];
            found = true;
          }
        }
        if (found) {
          fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
          console.log(`   ${e('🗑️', '[DEL]')}  Removed MCP entry from ${configPath}`);
          removed++;
        }
      } catch { /* skip unreadable configs */ }
    }

    // 6. Remove dist folder
    safeRemove(path.join(clawdRoot, 'dist'), 'dist/');
    // macOS native helper build output — regenerable, not tracked (#155).
    safeRemove(path.join(clawdRoot, 'native', '.build'), 'native/.build/');
    safeRemove(path.join(clawdRoot, 'native', 'ClawdCursor.app'), 'native/ClawdCursor.app/');

    // 7. Unlink global npm command
    try {
      const { execSync } = await import('child_process');
      execSync('npm unlink -g clawdcursor', { stdio: 'pipe', timeout: 15000 });
      console.log(`   ${e('🗑️', '[DEL]')}  Removed global clawdcursor command`);
      removed++;
    } catch { /* may not be linked globally */ }

    if (removed === 0 && failed.length === 0) {
      console.log('   Nothing to clean up.');
    }

    if (failed.length > 0) {
      console.log(`\n${e('⚠️', '[WARN]')}  ${failed.length} item(s) could not be removed (a running process likely held a file open). Close any clawdcursor process, then delete these manually:`);
      for (const f of failed) console.log(`   ${f}`);
    }

    console.log(`\n${e('🐾', '>')} ${failed.length > 0 ? 'Uninstall finished with warnings' : 'Fully uninstalled'}. To remove the source code, delete:`);
    console.log(`   ${clawdRoot}`);

    // Closing the reinstall dead-end: this command just removed the global
    // `clawdcursor` shim, so `clawdcursor install` can't work afterwards — and
    // the natural next step shouldn't be a guess. Point the user at the package
    // manager (works everywhere) plus the turnkey one-liner for their OS.
    const reinstallOneLiner = process.platform === 'win32'
      ? 'irm https://clawdcursor.com/install.ps1 | iex'
      : 'curl -fsSL https://clawdcursor.com/install.sh | bash';
    console.log(`\n${e('📦', '>')} To reinstall:  npm i -g clawdcursor`);
    console.log(`   or:           ${reinstallOneLiner}\n`);
  });

// ── Shared subsystem initialization (used by mcp + serve) ──

async function createToolContext() {
  const { NativeDesktop } = await import('../platform/native-desktop');
  const { AccessibilityBridge } = await import('../platform/accessibility');
  const { CDPDriver } = await import('../platform/cdp-driver');
  const { DEFAULT_CONFIG } = await import('../types');
  const { DEFAULT_CDP_PORT } = await import('../llm/browser-config');
  const { getPlatform } = await import('../platform');

  const desktop = new NativeDesktop({ ...DEFAULT_CONFIG });
  const a11y = new AccessibilityBridge();
  const cdp = new CDPDriver(DEFAULT_CDP_PORT);
  // Session-scoped el_NN UIMap cache. Without this, compile_ui / find_* and
  // the {element_id, snapshot_id} ref path fail with "no UIMap holder on this
  // context" over stdio MCP — the v1.5.0 substrate was unreachable for editor-
  // hosted agents (only the `agent` daemon constructed one). Gauntlet F1.
  const { UIMapHolder } = await import('../core/sense/ui-map-holder');
  const uiMaps = new UIMapHolder();
  // Lazy adapter handle — Tranche 1A primitives run through this. Populated
  // in ensureInitialized so we share the same adapter the unified pipeline uses.
  let platform: import('../platform/types').PlatformAdapter | undefined;

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let mouseScaleFactor = 1;
  let screenshotScaleFactor = 1;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await desktop.connect();
      platform = await getPlatform();
      screenshotScaleFactor = desktop.getScaleFactor();
      // mouseScaleFactor: image-space → mouse-driver coords.
      //  • Windows / Linux-X11: nut-js drives in PHYSICAL pixels → use the
      //    physical/image ratio (screenshotScaleFactor).
      //  • macOS: nut-js drives in LOGICAL points (Cocoa/CGEvent space). On a
      //    Retina panel physical≠logical, so the physical scale double-counts
      //    the backing scale and every click lands ~2× off (#154). Map
      //    image-space → LOGICAL instead, using NSScreen's logical width.
      //    (Mirrors imageScale() in agent-loop/coord-scale.ts for System B.)
      if (process.platform === 'darwin') {
        try {
          const { LLM_TARGET_WIDTH } = await import('../core/agent-loop/coord-scale');
          const lsize = await platform.getScreenSize(); // NSScreen logical + physical dims
          const lw = lsize?.logicalWidth ?? 0;
          mouseScaleFactor = lw > LLM_TARGET_WIDTH ? lw / LLM_TARGET_WIDTH : 1;
        } catch {
          mouseScaleFactor = screenshotScaleFactor; // best-effort fallback
        }
      } else {
        mouseScaleFactor = screenshotScaleFactor;
      }
      await a11y.warmup();
      initialized = true;
      console.log(`Subsystems initialized (mouseScale=${mouseScaleFactor}, screenshotScale=${screenshotScaleFactor})`);
    })();
    return initPromise;
  };

  return {
    desktop, a11y, cdp, uiMaps,
    get platform() { return platform; },
    getMouseScaleFactor: () => mouseScaleFactor,
    getScreenshotScaleFactor: () => screenshotScaleFactor,
    ensureInitialized,
  };
}

// ── MCP Mode (for Claude Code, Cursor, Windsurf, Zed, etc.) ──

program
  .command('mcp')
  .description('Run as MCP tool server over stdio (for Claude Code, Cursor, Windsurf, Zed)')
  .option('--compact', 'Expose 7 compound tools instead of 98 granular ones (Anthropic Computer-Use style — recommended for most agents)')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts: { compact?: boolean; banner?: boolean }) => {
    // Single-instance guard (MCP servers can accumulate when editors restart them)
    const existingMcpPid = claimPidFile('mcp');
    if (existingMcpPid !== null) {
      process.stderr.write(`[ERROR] clawdcursor mcp is already running (pid ${existingMcpPid}). Kill it first.\n`);
      process.exit(1);
    }

    // MCP mode: stdout is protocol, logs go to stderr
    const stderrWrite = (prefix: string, args: any[]) =>
      process.stderr.write(`${prefix}${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
    console.log = (...args: any[]) => stderrWrite('', args);
    console.warn = (...args: any[]) => stderrWrite('[WARN] ', args);
    console.error = (...args: any[]) => stderrWrite('[ERROR] ', args);
    // debug / info / dir / table ALSO write to stdout in Node. Only the three
    // above were redirected, so any of these on a reachable path — e.g. the
    // console.debug on every Linux accessibility call, and on the CDP failure
    // paths — wrote a non-JSON line into the protocol stream and corrupted it
    // for every stdio host at once.
    console.debug = (...args: any[]) => stderrWrite('[DEBUG] ', args);
    console.info = (...args: any[]) => stderrWrite('', args);
    console.dir = (obj: unknown) => stderrWrite('', [obj]);
    console.table = (data: unknown) => stderrWrite('', [data]);

    // Consent gate — REQUIRED before any tool runs, but NON-FATAL to startup.
    // Exiting here made the host show an opaque "MCP server failed" with no
    // reason: the message only goes to stderr, which most editor hosts hide.
    // Instead we start the server normally so the requirement surfaces as a
    // VISIBLE consent prompt on every tool call (enforced in mcp-server.ts) —
    // and it takes effect the moment `clawdcursor consent --accept` runs, with
    // no restart needed.
    const { hasConsent } = await import('./onboarding');
    if (!hasConsent()) {
      process.stderr.write(
        `\n[clawdcursor] One-time consent not yet accepted. The server will start, but\n` +
        `every tool call returns a consent prompt until you run:\n` +
        `  clawdcursor consent --accept   # this tool gives AI full control of your desktop\n\n`
      );
    }

    const mode = opts.compact ? 'compact' : 'granular';
    console.log(`clawdcursor MCP mode starting... (${mode})`);

    const ctx = await createToolContext();

    // v0.9 PR7: server construction is shared with the HTTP transport in
    // src/mcp-server.ts — same registry, same safety gate, same param shape.
    const { createMcpServer, startMcpStdio } = await import('./mcp-server');
    const { server, toolCount } = await createMcpServer({ compact: opts.compact, ctx });
    await startMcpStdio(server);
    console.log(`clawdcursor MCP ready — ${toolCount} tools registered`);

    ctx.ensureInitialized().catch((err: any) => {
      console.error('Subsystem init failed:', err?.message);
    });

    // Release pidfile on exit so a fresh restart can claim it immediately.
    // Guard against double-fire (both 'end' and 'close' can emit on the
    // same stdin teardown). Defer process.exit via setImmediate so libuv
    // finishes its stream-close bookkeeping before the exit syscall —
    // calling process.exit() synchronously inside a stdin 'end' handler
    // causes SIGSEGV on Linux where libuv is still unwinding the read
    // handle.
    //
    // releasePidFile MUST stay synchronous (before the setImmediate). On
    // headless Linux CI the native subsystems (nut-js → libxdo, sharp's
    // libvips) can still segfault during process.exit's destructor
    // chain — so the only way to guarantee the lockfile gets cleaned up
    // is to unlink it BEFORE any deferred work runs. The orphan-teardown
    // test asserts lockfile-is-gone for exactly this reason.
    let mcpExiting = false;
    const releaseMcp = () => {
      if (mcpExiting) return;
      mcpExiting = true;
      releasePidFile('mcp');                       // sync — must run before any segfault
      setImmediate(() => process.exit(0));         // deferred — lets libuv unwind cleanly
    };
    process.on('SIGINT', releaseMcp);
    process.on('SIGTERM', releaseMcp);

    // On-screen control banner for EXTERNAL agents driving over stdio. The
    // mcp-server tool wrapper touches it on every consequential call; a
    // double-click is the human kill switch — exiting the server severs the
    // editor's desktop control (the host respawns a fresh server on demand).
    const { controlBanner } = await import('../core/banner');
    if (opts.banner === false) controlBanner.setEnabled(false);
    controlBanner.configure({
      onStopRequested: () => {
        process.stderr.write('\n[STOP] Control banner double-clicked — shutting down the MCP server.\n');
        releaseMcp();
      },
    });

    // Parent-death detection (orphan teardown).
    //
    // MCP stdio servers receive their JSON-RPC traffic over stdin. When the
    // host editor (Claude Code, Cursor, etc.) exits without first killing
    // its child, the child's stdin pipe closes immediately. Without an EOF
    // handler the orphaned server keeps running, holds its lockfile, and
    // blocks every subsequent reconnect with "already running, kill it
    // first". Listen for end / close / error and shut down cleanly so the
    // next host spawn finds a fresh slate.
    //
    // The MCP SDK's StdioServerTransport also installs handlers on stdin,
    // but its close path is asynchronous and host-dependent; treating EOF
    // as a hard exit signal here makes the orphan-reaping behavior
    // deterministic and the same on every platform.
    process.stdin.on('end', releaseMcp);
    process.stdin.on('close', releaseMcp);
    process.stdin.on('error', releaseMcp);

    // Parent-death watchdog — the DETERMINISTIC orphan reaper.
    //
    // The stdin EOF handlers above are only a fast path. The comment's claim
    // that "the child's stdin pipe closes immediately" is FALSE when the host
    // is a GUI app: quitting the Claude *desktop* app on Windows does not
    // deliver stdin EOF to this child, so the server orphans, keeps its
    // lockfile, and blocks every reconnect with "already running, kill it
    // first" (observed in the wild). Polling the parent PID closes that gap on
    // every platform: once the host process is gone, release the lock and exit.
    // .unref() so the watchdog never keeps the process alive on its own.
    const parentPid = process.ppid;
    if (parentPid && parentPid > 1) {
      setInterval(() => {
        if (!isProcessAlive(parentPid)) releaseMcp();
      }, 2000).unref();
    }
  });

// ── `serve` deprecation alias (v0.9 PR7.4) ──
//
// `clawdcursor serve` was the legacy "tool server only" daemon. v0.9.0
// folded it into `clawdcursor agent`, which now auto-detects LLM
// availability — if no model is configured, the daemon boots into
// tools-only mode automatically. Kept here as a soft-deprecation alias
// for one release; removed in v0.10.
program
  .command('serve')
  .description('[deprecated — use `clawdcursor agent`] Start the tool server only')
  .option('--port <port>', 'HTTP server port', '3847')
  .option('--skip-consent', 'Skip consent prompt (requires NODE_ENV=development)')
  .action(async (opts) => {
    console.warn(`${e('⚠', '[WARN]')} \`clawdcursor serve\` is deprecated; use \`clawdcursor agent\`. Removed in v0.10.`);
    await runAgentMode({ ...opts, noLlm: true });
  });

program
  .command('report')
  .description('Send an error report to help improve clawdcursor. Shows a preview before sending.')
  .option('--log <path>', 'Path to a specific task log file')
  .option('--note <text>', 'Add a note describing what went wrong')
  .option('--save-only', 'Save report locally without sending')
  .action(async (opts) => {
    const { interactiveReport, buildReport, saveReportLocally, submitReport } = await import('./report');

    if (!process.stdin.isTTY) {
      // Non-interactive: build and submit directly
      const report = buildReport(opts.log, opts.note);
      if (opts.saveOnly) {
        const p = saveReportLocally(report);
        console.log(`Report saved: ${p}`);
      } else {
        const result = await submitReport(report);
        if (result.success) {
          console.log(`Report sent. ID: ${result.reportId}`);
        } else {
          const p = saveReportLocally(report);
          console.log(`Send failed: ${result.error}. Saved locally: ${p}`);
        }
      }
      return;
    }

    // Interactive mode
    await interactiveReport();
  });

// ── Consent management ──────────────────────────────────────────────────────
program
  .command('consent')
  .description('Manage desktop control consent (required before MCP/REST use)')
  .option('--accept', 'Accept consent non-interactively (CI/scripted environments)')
  .option('--revoke', 'Remove stored consent')
  .option('--status', 'Show current consent status')
  .action(async (opts) => {
    const { hasConsent, writeConsentFile, revokeConsent, runOnboarding } = await import('./onboarding');

    if (opts.status) {
      if (hasConsent()) {
        console.log(`${e('✅', '[OK]')}  Consent: accepted — clawdcursor is authorized to control this desktop.`);
      } else {
        console.log(`${e('❌', '[ERR]')}  Consent: not given — run \`clawdcursor consent\` to authorize.`);
      }
      return;
    }

    if (opts.revoke) {
      revokeConsent();
      console.log('  Consent revoked. clawdcursor will require re-authorization before next use.');
      return;
    }

    if (opts.accept) {
      writeConsentFile();
      console.log('  Consent accepted. clawdcursor can now control your desktop.');
      await autoRegisterSkill();
      printPostConsentNextSteps();
      return;
    }

    // Interactive flow
    const accepted = await runOnboarding('consent');
    if (accepted) {
      await autoRegisterSkill();
      printPostConsentNextSteps();
    } else {
      process.exit(1);
    }
  });

/** Two-path "what to do next" panel shown after consent and after doctor success. */
function printPostConsentNextSteps(): void {
  console.log('');
  console.log(`  ${pc.bold('Two ways to use clawdcursor:')}`);
  console.log('');
  console.log(`  ${pc.cyan('→ As an autonomous AI agent')} ${pc.gray('(clawdcursor brings the brain)')}`);
  console.log(`       1. ${pc.cyan('clawdcursor doctor')}    Configure your AI provider + models`);
  console.log(`       2. ${pc.cyan('clawdcursor agent')}     Start the daemon (HTTP + MCP on :3847)`);
  console.log('');
  console.log(`  ${pc.cyan('→ As an MCP tool server')} ${pc.gray('(your editor brings the brain)')}`);
  console.log(`       Register ${pc.cyan('clawdcursor mcp')} with Claude Code, Cursor, Windsurf, Zed, etc.`);
  console.log(`       No daemon, no API key — your editor spawns clawdcursor on demand.`);
  console.log('');
}

/** Register the skill into every detected agent framework (best-effort). Runs on
 *  consent so MCP-direct users get clawdcursor's skill without needing `doctor`
 *  — the skill carries the "how to use me sustainably" knowledge the bare MCP
 *  tools don't (fallback positioning, the el_NN UI map, the autonomous daemon). */
async function autoRegisterSkill(): Promise<void> {
  try {
    const { registerSkills } = await import('./skill-register');
    const { registered, results } = registerSkills();
    if (registered > 0) {
      const hosts = results
        .filter(r => r.ok && r.name.endsWith(' skill'))
        .map(r => r.name.replace(/ skill$/, ''))
        .join(', ');
      console.log(`  ${e('🧩', '[OK]')}  Registered clawdcursor as a skill in: ${hosts}`);
    }
  } catch { /* best-effort — never block consent */ }
}

program
  .command('register-skill')
  .description('(Re)register clawdcursor as a skill in your AI agents (Claude Code, OpenClaw, Codex, Cursor)')
  .action(async () => {
    const { registerSkills } = await import('./skill-register');
    const { registered, results } = registerSkills();
    for (const r of results) {
      console.log(`  ${r.ok ? e('✅', '[OK]') : e('❌', '[ERR]')}  ${r.name}: ${r.detail}`);
    }
    console.log('');
    if (registered > 0) {
      console.log(`  ${e('🐾', '>')} Registered into ${registered} agent skill registr${registered === 1 ? 'y' : 'ies'}. Restart the agent to pick it up.`);
    } else {
      console.log(`  ${e('ℹ️', '[i]')}  No agent framework detected (Claude Code, OpenClaw, Codex, Cursor). clawdcursor still works via MCP.`);
    }
  });

program.parse();
