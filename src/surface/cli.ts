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
  // The crash report (telemetry.ts) is kept for the next start: a broken process exits now, it does not wait on the network.
  try { require('../core/observability/telemetry').spoolBeforeExit(); } catch { /* never block the exit */ }
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
    try { require('../core/observability/telemetry').spoolBeforeExit(); } catch { /* never block the exit */ }
    process.exit(1);
  }
});

import './quiet-warnings';   // first: before any dependency can emit DEP0040
import { Command } from 'commander';
import { VERSION } from './version';
import { authHeaders } from './auth';
import dotenv from 'dotenv';
import pc from 'picocolors';
import { migrateFromLegacyDir, getPackageRoot } from '../paths';
import { stopHostApp } from '../platform/native-helper';
import { stopControl, resumeControl, isStopped } from '../core/control';

dotenv.config({ quiet: true });

// Migrate data from legacy ~/.openclaw/clawdcursor/ to ~/.clawdcursor/
migrateFromLegacyDir();

// ── Emoji gate (shared utility) ──────────────────────────────────────────────
import { e } from './format';

// ── Single-instance pidfile lock ─────────────────────────────────────────────
// Implementation lives in ./pidfile so it can be unit-tested independently.
// The richer JSON lockfile records process start time, which lets the
// liveness check distinguish a real live duplicate from a recycled PID
// (the bug behind "Failed to reconnect to clawdcursor: -32000" on Windows).
import { daemonPortForClient, sweepAllLocks, DAEMON_LOCK } from './pidfile';
import { userArgs, parsePort } from './argv';
import { setTelemetryEnabled, offReason, telemetryStatusText, STATE_FILE as TELEMETRY_FILE } from '../core/observability/telemetry';

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

program
  .name('clawdcursor')
  .description('🐾 Desktop control for AI agents: an MCP tool layer your agent drives')
  .version(VERSION);

// ── The daemon: `clawdcursor agent` serves MCP over HTTP (serve.ts). It runs no model and needs no key; the connecting
// agent (Claude Code, Codex, Cursor, ...) drives the tools. `start` and `serve` are deprecated aliases. `--no-llm` is still
// accepted as a no-op so existing scripts keep working.
interface AgentModeOpts {
  port?: string;
  accept?: boolean;
  /** Commander `--no-vision` → false. */
  vision?: boolean;
  skipConsent?: boolean;
  compact?: boolean;
  /** Commander `--no-banner` → false. Undefined = banner enabled (default). */
  banner?: boolean;
}

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
  const port = portFlag(opts.port);
  const { serveMcp } = await import('./serve');
  await serveMcp({ transport: 'http', compact: opts.compact === true, banner: opts.banner !== false, port,
    vision: opts.vision, accept: opts.accept, skipConsent: opts.skipConsent });
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
      console.log(`${e('⚠️', '[WARN]')}  Graceful stop did not complete — stopping the daemon its lock file names...`);
    }

    // v0.8.3 — also sweep every other clawdcursor-owned pidfile (mcp, serve,
    // start). The old `stop` only targeted port 3847 via `/stop`, which missed
    // `mcp` (stdio, no port) and any zombie `serve` / `start` that had
    // crashed-but-not-released its pidfile.
    // User-reported symptom: "Outlook keeps opening" — a stale serve process
    // was still receiving MCP / REST traffic after the user thought they'd
    // stopped. This sweep ensures `clawdcursor stop` means stop EVERYTHING.
    // A lock is only acted on when it proves its process is the clawdcursor
    // that wrote it (sweepAllLocks → stopLockHolder):
    // stale locks name pids the OS may have handed to an unrelated app, so
    // those are deleted and nothing is signalled.
    const swept = await sweepAllLocks();
    for (const r of swept) {
      if (r.outcome === 'stopped') {
        console.log(`${e('🐾', '>')} Stopped ${r.mode} instance (pid ${r.pid})`);
      } else if (r.outcome === 'failed') {
        // Could not kill — the process may be owned by a different user.
        console.warn(`${e('⚠', '[WARN]')} Could not stop ${r.mode} pid ${r.pid}`);
      } else {
        console.log(`${e('🧹', '>')} Removed a stale ${r.mode} lock file (its process is gone or is no longer clawdcursor; nothing was signalled)`);
      }
    }
    if (!serverStopped && !swept.some(r => r.mode === DAEMON_LOCK && r.outcome === 'stopped')) {
      console.error(`${e('❌', '[ERR]')} Port ${port} still answers, but no lock file proves which process that is — nothing was killed. Stop it yourself (Task Manager / kill) or free the port.`);
    }
    const sweptCount = swept.filter(r => r.outcome === 'stopped').length;
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
    const { runUninstall } = await import('./uninstall');
    await runUninstall();
  });

// ── MCP Mode (for Claude Code, Cursor, Windsurf, Zed, etc.) ──

program
  .command('mcp')
  .description('Run as MCP tool server over stdio (for Claude Code, Cursor, Windsurf, Zed)')
  .option('--compact', 'Expose 6 compound tools instead of the granular surface, where every action is its own tool (recommended for most agents)')
  .option('--no-banner', 'Disable the on-screen "desktop control in progress" banner (also CLAWD_NO_BANNER=1)')
  .action(async (opts: { compact?: boolean; banner?: boolean }) => {
    const { serveMcp } = await import('./serve');
    await serveMcp({ transport: 'stdio', compact: opts.compact === true, banner: opts.banner !== false });
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
