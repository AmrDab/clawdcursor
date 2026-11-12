#!/usr/bin/env node

/**
 * 🐾 Clawd Cursor — desktop control for AI agents
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
  // Stack frames only, home path stripped: an error's name and message can carry window titles and field contents,
  // and the MCP host keeps stderr.
  let frames = '';
  let cls = 'unknown';
  try { const sl = require('./session-log'); frames = sl.safeStack(err?.stack); cls = sl.errorClass(err); } catch { /* none */ }
  console.error(`Uncaught exception (${cls}${err?.code ? `, ${err.code}` : ''}):\n${frames}`);
  try {
    const { logger } = require('../core/observability/logger');
    logger.error('crash', { name: cls, ...(err?.code ? { code: err.code } : {}), stack: frames });
  } catch { /* stderr above has it */ }
  // The crash report (telemetry.ts) gets a moment to go out.
  try { require('../core/observability/telemetry').flushBeforeExit().finally(() => process.exit(1)); } catch { process.exit(1); }
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
    // Code and stack frames only, home path stripped (same rule as `crash`): the message can carry user content.
    const code = reason instanceof Error ? (reason as NodeJS.ErrnoException).code : undefined;
    const sl = require('./session-log');
    const frames = sl.safeStack(reason instanceof Error ? reason.stack : undefined);
    const cls = sl.errorClass(reason);
    logger.error('unhandledRejection', { name: cls, ...(code ? { code } : {}), stack: frames });
    console.error(`unhandledRejection (${cls}${code ? `, ${code}` : ''}):\n${frames}`);
  } catch {
    // Logger itself failed — say that much, still without the message.
    console.error('unhandledRejection (logger unavailable)');
  }
  // In server mode, (process.env.CLAWD_SERVER_MODE === '1') keep running.
  // In CLI / one-shot mode, exit to surface the bug.
  if (process.env.CLAWD_SERVER_MODE !== '1') {
    try { require('../core/observability/telemetry').flushBeforeExit().finally(() => process.exit(1)); } catch { process.exit(1); }
  }
});

import './quiet-warnings';   // first: before any dependency can emit DEP0040
import { Command } from 'commander';
import { createUtilityServer, requireAuth, initServerToken, getServerLogBuffer, mountJson404 } from './http-utility';
import { VERSION } from './version';
import dotenv from 'dotenv';
import { resolveConfig } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import pc from 'picocolors';
import { migrateFromLegacyDir, getPackageRoot } from '../paths';
import { ensureHostAppRunning, stopHostApp } from '../platform/native-helper';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import { stopControl, resumeControl, isStopped } from '../core/control';

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
import { claimPidFile, releasePidFile, isProcessAlive, pidFilePath, readPidLoose, recordLockPort, daemonPortForClient } from './pidfile';
import { userArgs, parsePort } from './argv';
import { endAllSessions } from './session-log';
import { flushBeforeExit, setTelemetryEnabled, offReason, telemetryStatusText, STATE_FILE as TELEMETRY_FILE } from '../core/observability/telemetry';
import { privateRunDir, system32Exe } from '../platform/ps-spawn';

const program = new Command();

// Flags and commands that went with the built-in agent (2.0): the failure stays, with one line saying why.
const REMOVED_IN_2 = /unknown option '--(provider|model|text-model|vision-model|base-url|api-key|no-save|reset)'|unknown command 'task'/;
program.configureOutput({
  outputError: (str, write) => {
    write(str);
    if (REMOVED_IN_2.test(str)) write('removed in 2.0: clawdcursor no longer runs a model; your agent drives the tools\n');
  },
});

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
  const { execSync, execFileSync } = await import('child_process');
  const os = await import('os');

  // #114: only ever kill processes that are plausibly OURS. The port is
  // configurable and ports get reused — blindly SIGKILLing whatever listens on
  // it can take down an unrelated app (dev server, another tool). clawdcursor
  // always runs under node, so a listener with any other image name is not
  // ours: skip it, tell the user, and let them resolve the conflict.
  const OURS = /node|clawdcursor/i;

  if (os.platform() === 'win32') {
    try {
      // No shell (it would search the working directory and parse the command line): netstat by absolute path, filtered here.
      const output = execFileSync(system32Exe('netstat.exe'), ['-ano'], { encoding: 'utf-8' })
        .split(/\r?\n/).filter(l => l.includes(`:${port}`) && l.includes('LISTENING')).join('\n');
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
          const row = execFileSync(system32Exe('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' });
          image = (row.split(',')[0] ?? '').replace(/"/g, '').trim();
        } catch { /* tasklist unavailable — treat as unknown */ }
        if (image && !OURS.test(image)) {
          console.warn(`${e('⚠️', '[WARN]')} Port ${port} is held by "${image}" (pid ${pid}) — not a clawdcursor process; refusing to kill it. Free the port or change server.port.`);
          continue;
        }
        execFileSync(system32Exe('taskkill.exe'), ['/F', '/PID', String(pid)]);
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
    // macOS / Linux only: lsof and ps run through /bin/sh, which has no current-directory lookup for them (CWE-427 is the Windows
    // rule); `port` and `pid` are numbers.
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
  .description('🐾 Desktop control for AI agents: an MCP tool layer your agent drives')
  .version(VERSION);

// ── Agent mode (v0.9 PR7.4) ────────────────────────────────────────────
//
// Single daemon entry point: the HTTP MCP server. It runs no model and needs no
// key; the connecting agent (Claude Code, Codex, Cursor, ...) drives the tools.
// Replaces the legacy `start` and `serve` commands; both still exist as
// deprecated aliases that print a warning and proxy to runAgentMode.
//
// Surface mounted on the daemon's port (default 3847):
//   GET  /         — dashboard (calls /mcp via JSON-RPC)
//   GET  /health   — readiness probe (no auth)
//   POST /stop     — graceful shutdown (auth + localhost-only)
//   GET  /resume   — the pending pause for the user, if any (auth + localhost-only)
//   POST /resume   — answer a pause for the user (auth + localhost-only)
//   POST /mcp      — MCP streamable-HTTP transport (auth)
//   GET  /mcp      — MCP SSE channel (auth)
//   DELETE /mcp    — MCP session terminate (auth)
//
// `--no-llm` is still accepted as a no-op so existing scripts keep working.
interface AgentModeOpts {
  port?: string;
  debug?: boolean;
  accept?: boolean;
  noVision?: boolean;
  skipConsent?: boolean;
  compact?: boolean;
  /** Commander `--no-banner` → false. Undefined = banner enabled (default). */
  banner?: boolean;
}

// SECURITY (#113, #293): this surface is full desktop control, so the daemon
// binds loopback only — there is no setting or flag that widens it. For remote
// use, tunnel the port: `ssh -L 3847:127.0.0.1:3847 user@host`.
const BIND_HOST = '127.0.0.1';

/** A `--port` flag: undefined when not given; anything but an integer in 1..65535 exits with "Invalid port number". */
function portFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = parsePort(raw);
  if (port === null) {
    console.error('Invalid port number');
    process.exit(1);
  }
  return port;
}

/** The port `stop` / `resume` talk to — never read from config (see daemonPortForClient). */
function clientPort(raw: string | undefined): number {
  return daemonPortForClient(portFlag(raw));
}

async function runAgentMode(opts: AgentModeOpts): Promise<void> {
  // commander stores the negated flag as `{ vision: false }`; callers/tests can also pass noVision directly.
  const forceNoVision = Boolean(opts.noVision || (opts as any).vision === false);
  const cliPort = portFlag(opts.port);

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
    const accepted = await runOnboarding('start', resolveConfig({ cliFlags: { port: cliPort } }).port);
    if (!accepted) process.exit(1);
  }

  if (process.platform === 'darwin') {
    await ensureHostAppRunning();
  }

  const resolved = resolveConfig({
    cliFlags: {
      port:     cliPort,
      debug:    opts.debug,
      noVision: forceNoVision,
    },
  });

  // ── Port pre-check — on the port the daemon will really bind (--port, else
  // server.port from config, else 3847), not just the flag. ──
  const net = await import('net');
  const portFree = await new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(); resolve(true); });
    tester.listen(resolved.port, BIND_HOST);
  });
  if (!portFree) {
    console.error(`\n${e('❌', '[ERR]')} Port ${resolved.port} is already in use.`);
    console.error(`Another clawdcursor instance may be running.`);
    console.error(`Run 'clawdcursor stop' first, or use --port <other_port>`);
    process.exit(1);
  }

  console.log(`${pc.green('✓')} ${pc.bold('clawdcursor')} ${pc.gray(`v${VERSION}`)} ${pc.gray(`— desktop control active on ${BIND_HOST}:${resolved.port}`)}`);

  // ── HTTP utility surface (/, /health, /stop) + MCP transport at /mcp ──
  const app = createUtilityServer({
    host: BIND_HOST,
    onStop: async () => {
      endAllSessions('stopped with clawdcursor stop (POST /stop)');  // synchronous: in the log before the exit
    },
  });

  // Starting the daemon is the user's own act: it gives control back after a stop.
  if (isStopped()) {
    resumeControl('daemon_start');
    console.log(`   ${e('▶', '>')} An earlier stop was cleared: starting clawdcursor gives it control again.`);
  }

  // ── On-screen control banner: double-click = the user takes control back ──
  // Every clawdcursor process refuses to act until the user gives control back
  // (control.ts, #294). The daemon stays up; `clawdcursor stop` still shuts it down. Disable with --no-banner / CLAWD_NO_BANNER=1.
  const { controlBanner } = await import('../core/banner');
  if (opts.banner === false) controlBanner.setEnabled(false);
  controlBanner.configure({
    onStopRequested: () => {
      console.log(`\n${e('🛑', '[STOP]')} Control banner double-clicked — stopped; nothing runs until you give control back.`);
      stopControl('pill');
      controlBanner.unpin();
    },
  });

  // Build the ToolContext shared by every MCP handler.

  // One UIMapHolder per daemon session, shared by the MCP surface (via toolCtx
  // → toolContextToAgent bridge).
  const uiMapHolder = new UIMapHolder();

  const toolCtx: any = await createToolContext();
  toolCtx.ensureInitialized().catch((err: any) => {
    console.error('Subsystem init failed:', err?.message);
  });
  if (toolCtx.cdp) {
    // connect() resolves false on failure (it logs the reason itself): only true is a connection.
    toolCtx.cdp.connect().then((ok: boolean) => {
      if (ok) console.log(`   ${e('🌐', '[NET]')} CDP connected to browser`);
      else console.log(`   ${e('ℹ️', 'i')} CDP: no browser detected (will retry when web tools are called)`);
    }).catch(() => {
      console.log(`   ${e('ℹ️', 'i')} CDP: no browser detected (will retry when web tools are called)`);
    });
  }
  toolCtx.getLogBuffer = getServerLogBuffer;
  toolCtx.uiMaps = uiMapHolder;
  toolCtx.disableVision = resolved.disableVision;

  // Mount /mcp behind the same Bearer-auth gate the legacy REST routes used.
  // Compact-over-HTTP: default granular for backward compatibility (the
  // dashboard at / calls 9 granular tool names — see dashboard.ts). External
  // agent hosts can opt into the 6-compound public surface via
  // `clawdcursor agent --compact` or `CLAWD_MCP_COMPACT=1`.
  const compactSurface = opts.compact === true || process.env.CLAWD_MCP_COMPACT === '1';
  let mcpToolCount = 0;
  try {
    const { createMcpServer, startMcpHttp } = await import('./mcp-server');
    const { server: mcpServer, toolCount } = await createMcpServer({ compact: compactSurface, ctx: toolCtx });
    mcpToolCount = toolCount;
    app.use('/mcp', requireAuth);
    // A server per SDK-client session and per concurrent one-shot post —
    // one shared server refused every request while another held it.
    await startMcpHttp(mcpServer, app, '/mcp',
      async () => {
        const h = await createMcpServer({ compact: compactSurface, ctx: toolCtx });
        h.server.onSessionEnd = reason => h.sessionLog.end(reason, 'session');
        return h.server;
      });
  } catch (err) {
    console.warn('MCP HTTP transport not loaded:', (err as Error).message);
  }

  // LAST mount — JSON 404 for unmatched routes (must come after /mcp).
  mountJson404(app);

  app.listen(resolved.port, BIND_HOST, async () => {
    // Where `stop` / `resume` find this daemon (see daemonPortForClient).
    recordLockPort('start', resolved.port);
    const serverToken = initServerToken();
    const tokenPath = path.join(require('os').homedir(), '.clawdcursor', 'token');
    console.log(`\n${pc.green(`${e('🌐', '[NET]')} API server:`)} http://${BIND_HOST}:${resolved.port}`);
    console.log(`${pc.yellow(`${e('🔑', '[KEY]')} Auth token:`)} ${serverToken.slice(0, 8)}...`);
    console.log(pc.gray(`   (full token saved to ${tokenPath})`));
    console.log(`\nSurviving HTTP routes:`);
    console.log(`  GET  /         — Dashboard (calls /mcp via JSON-RPC)`);
    console.log(`  GET  /health   — Readiness probe (no auth)`);
    console.log(`  POST /stop     — Graceful shutdown (auth, localhost only)`);
    console.log(`\nMCP endpoint (the only protocol):`);
    console.log(`  POST /mcp      — JSON-RPC tools/call & tools/list (auth) — ${compactSurface ? 'compact' : 'granular'} surface, ${mcpToolCount} tools`);
    console.log(`  GET  /mcp      — SSE notifications (auth)`);
    if (!compactSurface) {
      console.log(pc.gray(`   (tip: pass --compact or set CLAWD_MCP_COMPACT=1 to expose the 6-compound public surface)`));
    }
    console.log(`\nAll mutating endpoints require: ${pc.cyan('Authorization: Bearer <token>')}`);

    console.log(`\nReady. ${e('🐾', '')}`);
  });

  process.on('SIGINT', () => {
    console.log(`\n${e('👋', '--')} Shutting down...`);
    endAllSessions('SIGINT (Ctrl+C)');
    releasePidFile('start');
    void flushBeforeExit().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    endAllSessions('SIGTERM (a kill or the system stopped the daemon)');
    releasePidFile('start');
    void flushBeforeExit().finally(() => process.exit(0));
  });
}

program
  .command('agent')
  .description('Start the clawdcursor daemon (MCP over HTTP; your own agent drives the tools)')
  .option('--port <port>', 'API server port (default: server.port in config, else 3847)')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .option('--accept', 'Accept desktop control consent non-interactively and start')
  .option('--no-vision', 'High-security mode: no screenshot goes to any model — MCP clients work blind (also CLAWD_DISABLE_VISION=1)')
  .option('--no-llm', 'No effect (kept so existing scripts keep working): the daemon never runs a model')
  .option('--skip-consent', 'Skip consent prompt (requires NODE_ENV=development)')
  .option('--compact', 'Expose the 6-compound MCP surface (computer/accessibility/window/system/browser/batch) over HTTP /mcp instead of the granular surface, where every action is its own tool (also CLAWD_MCP_COMPACT=1)')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts) => {
    await runAgentMode(opts);
  });

program
  .command('start')
  .description('[deprecated — use `clawdcursor agent`] Start the Clawd Cursor agent')
  .option('--port <port>', 'API server port (default: server.port in config, else 3847)')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .option('--accept', 'Accept desktop control consent non-interactively and start')
  .option('--no-vision', 'High-security mode: no screenshot goes to any model — MCP clients work blind (also CLAWD_DISABLE_VISION=1)')
  .option('--no-llm', 'No effect (kept so existing scripts keep working): the daemon never runs a model')
  .option('--compact', 'Expose the 6-compound MCP surface over HTTP /mcp (also CLAWD_MCP_COMPACT=1)')
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
  .description('🩺 Diagnose setup: version, consent, screen capture, accessibility, permissions. Driving clawdcursor over MCP needs no doctor: consent + (macOS) `grant` is the whole setup.')
  .action(async () => {
    const { runDoctor } = await import('./doctor');
    await runDoctor();
  });

program
  .command('status')
  .description('📊 Check readiness status (consent, permissions)')
  .action(async () => {
    const { printStatusReport } = await import('./readiness');
    await printStatusReport();
  });

program
  .command('versions')
  .description('📦 List every copy of clawdcursor on this machine (global install, Claude Desktop extension, Claude Code plugin) and flag old ones')
  .action(async () => {
    const { findInstalledCopies, describeCopies } = await import('./installed-copies');
    const { lines } = describeCopies(findInstalledCopies(), { latest: VERSION, running: getPackageRoot() });
    for (const line of lines) console.log(`  ${line}`);
  });

program
  .command('update')
  .description('⬆️  Update the global npm install to the latest version, then list the other copies (Desktop extension, Claude Code plugin) that need their own update')
  .action(async () => {
    const { runUpdate } = await import('./update');
    await runUpdate();
  });

program
  .command('grant')
  .description('🔐 Request macOS permissions (triggers system permission dialogs)')
  .action(async () => {
    if (process.platform !== 'darwin') {
      console.log('Permission grants are only needed on macOS.');
      return;
    }
    const { requestPermissions, nativeBuildHint } = await import('../platform/native-helper');
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
      console.error(`   ${nativeBuildHint()}`);
    }
  });

program
  .command('stop')
  .description('Stop every running Clawd Cursor instance; agents stay stopped until `clawdcursor resume`')
  .option('--port <port>', 'API server port (default: the running daemon\'s port, else 3847)')
  .action(async (opts) => {
    const port = clientPort(opts.port);
    // Every clawdcursor process — stdio MCP servers too, which have no port or pidfile to reach — stops acting now, and a
    // server the host starts again stays stopped until the user gives control back (control.ts, #294).
    stopControl('cli');
    console.log(`${e('🛑', '[STOP]')} Agents can't act until you run \`clawdcursor resume\`, click Resume when one asks, or start \`clawdcursor agent\`.`);
    const isClawd = await isClawdInstance(port);
    if (!isClawd) {
      console.log(`${e('🐾', '>')} No running instance found on port ` + port);
      if (process.platform === 'darwin') {
        await stopHostApp();
      }
      return;
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
  .command('resume')
  .description('Continue a task paused for you (same as the on-screen Resume), or --end it. After a stop, gives control back.')
  .option('--end', 'End the paused task')
  .option('--port <port>', 'API server port (default: the running daemon\'s port, else 3847)')
  .action(async (opts) => {
    const port = clientPort(opts.port);
    const answer = opts.end ? 'end' : 'resume';
    const gaveBack = !opts.end && isStopped();
    if (gaveBack) {
      resumeControl('cli');
      console.log(`${e('▶', '>')} control given back: clawdcursor may act again`);
    }
    if (!(await isClawdInstance(port))) {
      if (gaveBack) return;
      console.log(`${e('🐾', '>')} No running instance found on port ${port}`);
      process.exitCode = 1;
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/resume`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as { outcome?: string; was?: string; error?: string };
      if (res.ok) {
        console.log(`${e('▶', '>')} ${data.outcome}${data.was ? `: ${data.was}` : ''}`);
      } else if (gaveBack) {
        // Nothing was paused: giving control back was the whole job.
      } else {
        console.error(`${e('❌', '[ERR]')} ${data.error ?? res.statusText}`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`${e('❌', '[ERR]')} ${(err as Error).message}`);
      process.exitCode = 1;
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
      path.join(clawdRoot, '.clawdcursor-favorites.json'),   // written by installs before 1.6
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
      // Left on PATH on purpose: the user runs this uninstall themselves, and npm is theirs to resolve (not a system program).
      execSync('npm unlink -g clawdcursor', { stdio: 'pipe', timeout: 15000, cwd: privateRunDir() });
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

/**
 * Image-space → mouse-driver factor for the image the model was last sent.
 * Physical px on Windows/Linux (= screenshot scale); logical points on macOS
 * (logical width / image width — may be < 1, e.g. a 2560-px panel shown at
 * 1024 points). Read live, never cached.
 */
function mouseScaleFor(
  desktop: { getScaleFactor(): number; getLlmWidth(): number },
  macLogicalWidth: number,
): number {
  const llmW = desktop.getLlmWidth();
  if (process.platform === 'darwin' && macLogicalWidth > 0 && llmW > 0) return macLogicalWidth / llmW;
  return desktop.getScaleFactor();
}

async function createToolContext() {
  const { NativeDesktop } = await import('../platform/native-desktop');
  const { AccessibilityBridge } = await import('../platform/accessibility');
  const { CDPDriver } = await import('../platform/cdp-driver');
  const { DEFAULT_CONFIG } = await import('../types');
  const { DEFAULT_CDP_PORT } = await import('../platform/browser-config');
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
  // macOS logical (point) width; 0 elsewhere. Scale factors are read LIVE from
  // the desktop's last capture (mouseScaleFor) — freezing them at startup broke
  // clicks after a rotation / resolution change.
  let macLogicalWidth = 0;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await desktop.connect();
      platform = await getPlatform();
      // mouse factor: image-space → mouse-driver coords (see mouseScaleFor).
      //  • Windows / Linux: nut-js drives PHYSICAL px → the screenshot scale.
      //  • macOS: nut-js drives LOGICAL points; on Retina physical≠logical and
      //    the physical scale double-counts the backing scale (#154).
      if (process.platform === 'darwin') {
        try {
          const lsize = await platform.getScreenSize(); // NSScreen logical + physical dims
          macLogicalWidth = lsize?.logicalWidth ?? 0;
        } catch { /* best-effort fallback: physical scale */ }
      }
      await a11y.warmup();
      initialized = true;
      console.log(`Subsystems initialized (mouseScale=${mouseScaleFor(desktop, macLogicalWidth)}, screenshotScale=${desktop.getScaleFactor()})`);
    })();
    return initPromise;
  };

  return {
    desktop, a11y, cdp, uiMaps,
    get platform() { return platform; },
    getMouseScaleFactor: () => mouseScaleFor(desktop, macLogicalWidth),
    getScreenshotScaleFactor: () => desktop.getScaleFactor(),
    ensureInitialized,
  };
}

// ── MCP Mode (for Claude Code, Cursor, Windsurf, Zed, etc.) ──

program
  .command('mcp')
  .description('Run as MCP tool server over stdio (for Claude Code, Cursor, Windsurf, Zed)')
  .option('--compact', 'Expose 6 compound tools instead of the granular surface, where every action is its own tool (recommended for most agents)')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts: { compact?: boolean; banner?: boolean }) => {
    // No single-instance lock in MCP mode. Hosts legitimately run several
    // copies at once — Claude Desktop starts a protocol probe, the main
    // connection and a Cowork/Code pool for one extension, and another editor
    // may be running clawdcursor too — and the old lock made every copy after
    // the first exit "already running … Kill it first", so the .mcpb never
    // connected (live, 2026-10). The lock existed to stop orphans piling up;
    // each copy now reaps itself instead (stdin EOF + parent-PID watchdog below).

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
    const { hasConsent, acceptConsentFromEnv } = await import('./onboarding');
    // A host that collected consent in its own UI (the .mcpb install screen)
    // passes it as CLAWDCURSOR_CONSENT=true.
    if (acceptConsentFromEnv()) process.stderr.write('[clawdcursor] Consent accepted via the host\'s install setting.\n');
    if (!hasConsent()) {
      process.stderr.write(
        `\n[clawdcursor] One-time consent not yet accepted. The server will start, but\n` +
        `every tool call returns a consent prompt until you run:\n` +
        `  clawdcursor consent --accept   # this tool gives AI full control of your desktop\n\n`
      );
    }

    const mode = opts.compact ? 'compact' : 'granular';
    console.log(`clawdcursor MCP mode starting... (${mode})`);

    const ctx: import('../tools/types').ToolContext = await createToolContext();
    // CLAWD_DISABLE_VISION=1 / config disableVision holds here too (no --no-vision flag on stdio).
    ctx.disableVision = resolveConfig().disableVision;

    // v0.9 PR7: server construction is shared with the HTTP transport in
    // src/mcp-server.ts — same registry, same guards, same param shape.
    const { createMcpServer, startMcpStdio } = await import('./mcp-server');
    const { server, toolCount, sessionLog } = await createMcpServer({ compact: opts.compact, ctx });
    await startMcpStdio(server);
    console.log(`clawdcursor MCP ready — ${toolCount} tools registered`);
    const { logger } = await import('../core/observability/logger');
    logger.info('mcp.start', { version: VERSION, pid: process.pid, hostPid: process.ppid, surface: mode, readyMs: Math.round(process.uptime() * 1000) });
    const { reportUncleanExits } = await import('./session-log');
    reportUncleanExits();

    ctx.ensureInitialized().catch((err: any) => {
      console.error('Subsystem init failed:', err?.message);
    });

    // Exit when the host goes away. Guard against double-fire (both 'end' and
    // 'close' can emit on the same stdin teardown). Defer process.exit via
    // setImmediate so libuv finishes its stream-close bookkeeping before the
    // exit syscall — calling process.exit() synchronously inside a stdin
    // 'end' handler causes SIGSEGV on Linux where libuv is still unwinding
    // the read handle.
    let mcpExiting = false;
    const releaseMcp = (reason: string) => {
      if (mcpExiting) return;
      mcpExiting = true;
      sessionLog.end(reason);                      // synchronous: in the log before the exit
      // Deferred — lets libuv unwind cleanly; a queued bug report (telemetry.ts) gets a moment to go out.
      setImmediate(() => { void flushBeforeExit().finally(() => process.exit(0)); });
    };
    process.on('SIGINT', () => releaseMcp('SIGINT (Ctrl+C or the host stopping the server)'));
    process.on('SIGTERM', () => releaseMcp('SIGTERM (the host or a kill stopped the server)'));

    // On-screen control banner for EXTERNAL agents driving over stdio. The
    // mcp-server tool wrapper touches it on every consequential call; a
    // double-click is the human kill switch. It used to exit the server, but the host
    // respawned a fresh one on the agent's next call that knew nothing of the stop (#294):
    // now the stop is a state every clawdcursor process honours (control.ts), and the
    // agent's in-flight batch ends with "stopped by the user" instead of a dead transport.
    const { controlBanner } = await import('../core/banner');
    if (opts.banner === false) controlBanner.setEnabled(false);
    controlBanner.configure({
      onStopRequested: () => {
        process.stderr.write('\n[STOP] Control banner double-clicked — stopped; nothing runs until the user gives control back.\n');
        stopControl('pill');
        controlBanner.unpin();
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
    process.stdin.on('end', () => releaseMcp('the host closed the connection (stdin ended)'));
    process.stdin.on('close', () => releaseMcp('the host closed the connection (stdin closed)'));
    process.stdin.on('error', (err) => releaseMcp(`stdin error: ${err?.message ?? err}`));

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
        if (!isProcessAlive(parentPid)) releaseMcp(`the host process (pid ${parentPid}) is gone`);
      }, 2000).unref();
    }
  });

// ── `serve` deprecation alias (v0.9 PR7.4) ──
//
// `clawdcursor serve` was the legacy "tool server only" daemon. v0.9.0
// folded it into `clawdcursor agent`. Kept here as a soft-deprecation alias
// for one release; removed in v0.10.
program
  .command('serve')
  .description('[deprecated — use `clawdcursor agent`] Start the tool server only')
  .option('--port <port>', 'HTTP server port (default: server.port in config, else 3847)')
  .option('--skip-consent', 'Skip consent prompt (requires NODE_ENV=development)')
  .action(async (opts) => {
    console.warn(`${e('⚠', '[WARN]')} \`clawdcursor serve\` is deprecated; use \`clawdcursor agent\`. Removed in v0.10.`);
    await runAgentMode(opts);
  });

program
  .command('report')
  .description('Report the last session (or agent task) to the clawdcursor team. Shows a preview first; no typed text, clipboard or screenshots.')
  .option('--log <path>', 'Path to a specific task log file')
  .option('--note <text>', 'Add a note describing what went wrong')
  .option('--save-only', 'Save report locally without sending')
  .action(async (opts) => {
    const { interactiveReport, buildReport, buildLatestReport, saveReportLocally, submitReport, issueUrl } = await import('./report');

    if (!process.stdin.isTTY) {
      // Non-interactive (e.g. an agent ran this): report on the newest MCP
      // session or task log; if the server is unreachable, print a prefilled
      // GitHub issue link the user opens, reviews and submits.
      const report = opts.log ? buildReport(opts.log, opts.note) : buildLatestReport(opts.note);
      if (opts.saveOnly) {
        const p = saveReportLocally(report);
        console.log(`Report saved: ${p}`);
      } else {
        const result = await submitReport(report);
        if (result.success) {
          console.log(`Report sent. ID: ${result.reportId}`);
        } else {
          const p = saveReportLocally(report);
          console.log(`Report server unreachable (${result.error}). Saved locally: ${p}`);
          console.log(`Send it as a GitHub issue (review, then submit):\n${issueUrl(report)}`);
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

// Anonymous bug reports (core/observability/telemetry.ts): on by default, off on request.
program
  .command('optout')
  .description('Turn off anonymous error reports (see `clawdcursor telemetry` for what they contain)')
  .action(() => {
    if (!setTelemetryEnabled(false)) { console.error(`${e('❌', '[ERR]')} Could not write ${TELEMETRY_FILE}`); process.exitCode = 1; return; }
    console.log('Anonymous error reports: off. Turn them back on with `clawdcursor optin`.');
  });

program
  .command('optin')
  .description('Turn anonymous error reports back on')
  .action(() => {
    if (!setTelemetryEnabled(true)) { console.error(`${e('❌', '[ERR]')} Could not write ${TELEMETRY_FILE}`); process.exitCode = 1; return; }
    const off = offReason();
    console.log(off ? `Anonymous error reports: on in the settings, but still off here because of ${off}.` : 'Anonymous error reports: on. Thank you.');
  });

program
  .command('telemetry')
  .description('Show whether anonymous error reports are on, and exactly which fields they send')
  .action(() => {
    console.log(telemetryStatusText());
  });

/** Two-path "what to do next" panel shown after consent and after doctor success. */
function printPostConsentNextSteps(): void {
  console.log('');
  console.log(`  ${pc.bold('Use clawdcursor from your own agent (Claude Code, Codex, Cursor, ...):')}`);
  console.log('');
  console.log(`       Register ${pc.cyan('clawdcursor mcp')} with Claude Code, Cursor, Windsurf, Zed, etc.`);
  console.log(`       No daemon, no API key: your editor spawns clawdcursor on demand.`);
  console.log(`       Or start the HTTP MCP server yourself: ${pc.cyan('clawdcursor agent')} (on :3847).`);
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

// Explicit user args: commander's Electron auto-detection misreads argv in a
// packaged Electron host (Claude Desktop's extension runtime) — see argv.ts.
program.parse(userArgs(process.argv, __filename), { from: 'user' });
