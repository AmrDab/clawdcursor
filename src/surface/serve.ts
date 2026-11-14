/**
 * Serve clawdcursor's MCP surface: over stdio (`clawdcursor mcp`, started by an editor host) or over HTTP (the
 * `clawdcursor agent` daemon). Both get the same startup — console capture for logs_recent, one tool context, the
 * on-screen banner, the start event, the report of earlier servers that died without a clean exit, and one exit
 * routine. Only what a transport really needs differs: stdio keeps stdout for the protocol and reaps itself when its
 * host goes; the daemon holds a lock, checks its port, mints the token and serves the HTTP routes.
 */
import pc from 'picocolors';
import { VERSION } from './version';
import { e } from './format';
import { resolveConfig } from '../config';
import type { ToolContext } from '../tools/types';
import { createToolContext } from './tool-context';
import { captureConsole } from './log-buffer';
import { createMcpServer, servedTools, startMcpStdio, startMcpHttp, type McpServerHandle } from './mcp-server';
import { createUtilityServer, describeRoutes } from './http-utility';
import { initServerToken } from './auth';
import { endAllSessions, reportUncleanExits } from './session-log';
import { claimPidFile, releasePidFile, recordLockPort, isProcessAlive, DAEMON_LOCK } from './pidfile';
import { spoolBeforeExit } from '../core/observability/telemetry';
import { logger } from '../core/observability/logger';
import { controlBanner } from '../core/banner';
import { stopControl, resumeControl, isStopped } from '../core/control';
import { ensureHostAppRunning } from '../platform/native-helper';
import { TOKEN_PATH } from '../paths';

export type Transport = 'stdio' | 'http';

export interface ServeOptions {
  transport: Transport;
  /** The 6 compound tools instead of the granular surface (`--compact`; HTTP also CLAWD_MCP_COMPACT=1). */
  compact: boolean;
  /** false: no on-screen control banner (`--no-banner`). */
  banner: boolean;
  /** HTTP: `--port`, already validated. */
  port?: number;
  /** HTTP: false = `--no-vision`. */
  vision?: boolean;
  /** HTTP: `--accept`, record consent and start. */
  accept?: boolean;
  /** HTTP: `--skip-consent` (NODE_ENV=development only). */
  skipConsent?: boolean;
}

// SECURITY (#113, #293): this surface is full desktop control, so the daemon
// binds loopback only — there is no setting or flag that widens it. For remote
// use, tunnel the port with the same port on both ends (auth.ts checks the Host):
// `ssh -L 3847:127.0.0.1:3847 user@host`.
const BIND_HOST = '127.0.0.1';

export async function serveMcp(opts: ServeOptions): Promise<void> {
  if (opts.transport === 'stdio') await serveStdio(opts);
  else await serveHttp(opts);
}

/**
 * What both transports share before their transport is up. `makeContext` is the desktop by default; the tests pass a stub.
 * On stdio the console must already write to stderr when this runs (captureConsole copies what it writes).
 */
export async function startServing(
  opts: { compact: boolean; banner: boolean; disableVision: boolean },
  makeContext: (o: { disableVision: boolean }) => Promise<ToolContext> = createToolContext,
): Promise<{ ctx: ToolContext; createHandle: () => Promise<McpServerHandle> }> {
  captureConsole();
  const ctx = await makeContext({ disableVision: opts.disableVision });
  // On-screen control banner: a double-click is the human kill switch. The stop is a state every clawdcursor process
  // honours until the user gives control back (control.ts, #294) — a stdio host that respawns its server cannot undo it.
  if (!opts.banner) controlBanner.setEnabled(false);
  controlBanner.configure({
    onStopRequested: () => {
      console.log(`\n${e('🛑', '[STOP]')} Control banner double-clicked — stopped; nothing runs until the user gives control back.`);
      stopControl('pill');
      controlBanner.unpin();
    },
  });
  return { ctx, createHandle: () => createMcpServer({ compact: opts.compact, ctx }) };
}

/** Once the transport is up: the start event, and the servers that died earlier without a clean exit. */
function announceStart(transport: Transport, compact: boolean): void {
  logger.info('mcp.start', { version: VERSION, pid: process.pid, hostPid: process.ppid, transport,
    surface: compact ? 'compact' : 'granular', readyMs: Math.round(process.uptime() * 1000) });
  reportUncleanExits();
}

function initInBackground(ctx: ToolContext): void {
  ctx.ensureInitialized().catch((err: unknown) => {
    console.error('Subsystem init failed:', (err as Error)?.message);
  });
}

/**
 * The one exit routine: close the sessions with the reason, release what the transport holds, keep a queued bug report
 * for the next start (telemetry.ts), exit. Runs once however many signals arrive. process.exit is deferred so libuv
 * finishes its stream-close bookkeeping first — exiting synchronously inside a stdin 'end' handler segfaults on Linux.
 */
function exitRoutine(endSessions: (reason: string) => void, release?: () => void): (reason: string) => void {
  let exiting = false;
  return (reason: string) => {
    if (exiting) return;
    exiting = true;
    endSessions(reason);  // synchronous: in the log before the exit
    release?.();
    spoolBeforeExit();
    setImmediate(() => process.exit(0));
  };
}

async function serveStdio(opts: ServeOptions): Promise<void> {
  // No single-instance lock in MCP mode. Hosts legitimately run several
  // copies at once — Claude Desktop starts a protocol probe, the main
  // connection and a Cowork/Code pool for one extension, and another editor
  // may be running clawdcursor too — and the old lock made every copy after
  // the first exit "already running … Kill it first", so the .mcpb never
  // connected (live, 2026-10). The lock existed to stop orphans piling up;
  // each copy now reaps itself instead (stdin EOF + parent-PID watchdog below).

  // MCP mode: stdout is protocol, logs go to stderr
  const stderrWrite = (prefix: string, args: unknown[]) =>
    process.stderr.write(`${prefix}${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
  console.log = (...args: unknown[]) => stderrWrite('', args);
  console.warn = (...args: unknown[]) => stderrWrite('[WARN] ', args);
  console.error = (...args: unknown[]) => stderrWrite('[ERROR] ', args);
  // debug / info / dir / table ALSO write to stdout in Node. Only the three
  // above were redirected, so any of these on a reachable path — e.g. the
  // console.debug on every Linux accessibility call, and on the CDP failure
  // paths — wrote a non-JSON line into the protocol stream and corrupted it
  // for every stdio host at once.
  console.debug = (...args: unknown[]) => stderrWrite('[DEBUG] ', args);
  console.info = (...args: unknown[]) => stderrWrite('', args);
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

  console.log(`clawdcursor MCP mode starting... (${opts.compact ? 'compact' : 'granular'})`);
  // CLAWD_DISABLE_VISION=1 / config disableVision holds here too (no --no-vision flag on stdio).
  const { ctx, createHandle } = await startServing({ compact: opts.compact, banner: opts.banner, disableVision: resolveConfig().disableVision });
  const { server, toolCount, sessionLog } = await createHandle();
  await startMcpStdio(server);
  console.log(`clawdcursor MCP ready — ${toolCount} tools registered`);
  announceStart('stdio', opts.compact);
  initInBackground(ctx);

  const exit = exitRoutine(reason => sessionLog.end(reason));
  process.on('SIGINT', () => exit('SIGINT (Ctrl+C or the host stopping the server)'));
  process.on('SIGTERM', () => exit('SIGTERM (the host or a kill stopped the server)'));

  // Parent-death detection (orphan teardown). When the host editor exits
  // without killing its child, the child's stdin pipe closes: shut down so
  // the next host spawn finds a fresh slate. The SDK's StdioServerTransport
  // also listens on stdin, but its close path is asynchronous and
  // host-dependent; EOF as a hard exit signal makes the reaping the same on
  // every platform.
  process.stdin.on('end', () => exit('the host closed the connection (stdin ended)'));
  process.stdin.on('close', () => exit('the host closed the connection (stdin closed)'));
  process.stdin.on('error', (err) => exit(`stdin error: ${err?.message ?? err}`));

  // Parent-death watchdog — the DETERMINISTIC orphan reaper. Stdin EOF is
  // only a fast path: quitting the Claude *desktop* app on Windows does not
  // deliver it, so the server orphaned (observed in the wild). Polling the
  // parent PID closes that gap on every platform. .unref() so the watchdog
  // never keeps the process alive on its own.
  const parentPid = process.ppid;
  if (parentPid && parentPid > 1) {
    setInterval(() => {
      if (!isProcessAlive(parentPid)) exit(`the host process (pid ${parentPid}) is gone`);
    }, 2000).unref();
  }
}

async function serveHttp(opts: ServeOptions): Promise<void> {
  const existingPid = claimPidFile(DAEMON_LOCK);
  if (existingPid !== null) {
    console.error(`${e('❌', '[ERR]')} clawdcursor agent is already running (pid ${existingPid}). Run \`clawdcursor stop\` first.`);
    process.exit(1);
  }

  const { hasConsent, writeConsentFile, runOnboarding } = await import('./onboarding');
  const canSkipDev = opts.skipConsent && process.env.NODE_ENV === 'development';
  if (opts.accept) {
    writeConsentFile();
    console.log('  Consent recorded.\n');
  } else if (!canSkipDev && !hasConsent()) {
    const accepted = await runOnboarding('start', resolveConfig({ cliFlags: { port: opts.port } }).port);
    if (!accepted) process.exit(1);
  }

  if (process.platform === 'darwin') {
    await ensureHostAppRunning();
  }

  const resolved = resolveConfig({ cliFlags: { port: opts.port, noVision: opts.vision === false } });

  // Port pre-check — on the port the daemon will really bind (--port, else
  // server.port from config, else 3847), not just the flag.
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

  // Default granular for backward compatibility; agent hosts can opt into the 6-compound surface.
  const compact = opts.compact || process.env.CLAWD_MCP_COMPACT === '1';
  const { ctx, createHandle } = await startServing({ compact, banner: opts.banner, disableVision: resolved.disableVision });

  // Starting the daemon is the user's own act: it gives control back after a stop.
  if (isStopped()) {
    resumeControl('daemon_start');
    console.log(`   ${e('▶', '>')} An earlier stop was cleared: starting clawdcursor gives it control again.`);
  }

  initInBackground(ctx);
  // connect() resolves false on failure (it logs the reason itself): only true is a connection.
  ctx.cdp?.connect().then((ok: boolean) => {
    if (ok) console.log(`   ${e('🌐', '[NET]')} CDP connected to browser`);
    else console.log(`   ${e('ℹ️', 'i')} CDP: no browser detected (will retry when web tools are called)`);
  }).catch(() => {
    console.log(`   ${e('ℹ️', 'i')} CDP: no browser detected (will retry when web tools are called)`);
  });

  let mcp: Awaited<ReturnType<typeof startMcpHttp>> | undefined;
  try {
    // A server per SDK-client session and per concurrent one-shot post — one shared server refused every request while
    // another held it.
    mcp = await startMcpHttp(createHandle);
  } catch (err) {
    console.warn('MCP HTTP transport not loaded:', (err as Error).message);
  }
  const exit = exitRoutine(endAllSessions, () => releasePidFile(DAEMON_LOCK));
  const app = createUtilityServer({
    host: BIND_HOST,
    // POST /stop (and the dashboard Stop) exits like Ctrl+C: the lock is released, so `stop` never meets a stale one.
    onStop: () => exit('stopped with clawdcursor stop (POST /stop)'),
    mcp: mcp?.handle,
  });

  const toolCount = servedTools(compact).length;
  app.listen(resolved.port, BIND_HOST, async () => {
    // Where `stop` / `resume` find this daemon (see daemonPortForClient).
    recordLockPort(DAEMON_LOCK, resolved.port);
    const serverToken = initServerToken();
    console.log(`\n${pc.green(`${e('🌐', '[NET]')} API server:`)} http://${BIND_HOST}:${resolved.port}`);
    console.log(`${pc.yellow(`${e('🔑', '[KEY]')} Auth token:`)} ${serverToken.slice(0, 8)}...`);
    console.log(pc.gray(`   (full token saved to ${TOKEN_PATH})`));
    console.log(`\nHTTP routes (agents use MCP at /mcp: the ${compact ? 'compact' : 'granular'} surface, ${toolCount} tools):`);
    for (const line of describeRoutes()) console.log(`  ${line}`);
    if (!compact) {
      console.log(pc.gray(`   (tip: pass --compact or set CLAWD_MCP_COMPACT=1 to expose the 6-compound public surface)`));
    }
    console.log(`\nAll mutating endpoints require: ${pc.cyan('Authorization: Bearer <token>')}`);
    console.log(`\nReady. ${e('🐾', '')}`);
    announceStart('http', compact);
  });

  process.on('SIGINT', () => {
    console.log(`\n${e('👋', '--')} Shutting down...`);
    exit('SIGINT (Ctrl+C)');
  });
  process.on('SIGTERM', () => exit('SIGTERM (a kill or the system stopped the daemon)'));
}
