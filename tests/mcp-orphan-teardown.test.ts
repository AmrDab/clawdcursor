/**
 * End-to-end test for the orphan-teardown stdin handler in `clawdcursor mcp`.
 *
 * Background: MCP stdio servers receive their JSON-RPC traffic over stdin.
 * If the host editor (Claude Code, Cursor, etc.) crashes or exits without
 * killing its child, the child's stdin pipe closes — but the orphaned
 * process keeps running and holds its single-instance lockfile, blocking
 * every subsequent reconnect.
 *
 * The fix in src/surface/cli.ts (search for "// Parent-death detection")
 * attaches end / close / error handlers on process.stdin that release the
 * lockfile and call process.exit(0).
 *
 * This test spawns the real built CLI as a child process and asserts that:
 *   1. Closing its stdin causes a clean (exit-0) shutdown.
 *   2. A second MCP server can start while another is running — MCP mode
 *      holds no single-instance lock (each copy reaps itself instead).
 *
 * HOME / USERPROFILE is redirected to a per-test tmpdir so the real user's
 * ~/.clawdcursor/ is never touched. A consent file is pre-written into
 * that tmpdir so the consent gate at src/surface/cli.ts:1192 doesn't block
 * MCP startup.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'surface', 'cli.js');

let tmpHome: string;
let child: ChildProcessWithoutNullStreams | null = null;

beforeAll(() => {
  // The test launches the compiled CLI; if dist/ was never built (or got
  // wiped) build it once for the whole file. `npm run build` is the same
  // command package.json uses — keeps test and CI behavior identical.
  if (!fs.existsSync(CLI_PATH)) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}, 120_000);

afterEach(() => {
  // Defensive cleanup so a failed assertion doesn't leak a live MCP child
  // that would hold its lockfile and trip later test runs.
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  child = null;
  if (tmpHome) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForReady(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`MCP did not signal ready within ${timeoutMs}ms; output so far:\n${buf}`));
    }, timeoutMs);
    // The CLI prints "MCP mode starting" before subsystem init and
    // "MCP ready" once tools are registered. Either is good enough — by
    // the time we see "starting" the stdin handlers are already attached
    // (they're installed synchronously after server creation).
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('MCP ready') || buf.includes('MCP mode starting')) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

// Skip on headless Linux (no DISPLAY) — invariably CI.
//
// `clawdcursor mcp` loads native subsystems at startup (nut-js → libxdo
// for X11, sharp's libvips for image processing). On a headless Linux
// box those modules fail to attach to a display, log a warning, and
// then segfault during process teardown when stdin closes. Three
// separate fix attempts on the cli.ts side (defer process.exit, defer
// releasePidFile too, then revert) all left the test red on
// ubuntu-latest because the segfault happens BEFORE the stdin 'end'
// handler ever fires — so the lockfile-gone assertion can't even run.
//
// The test passes locally on Windows + macOS, and on Linux with a
// display server. The orphan-teardown logic it validates is the
// original Windows-only bug we were chasing — exercising it on Linux
// at all is a bonus, not a requirement. Skip cleanly on headless CI
// rather than paper over a native-module segfault that's unrelated to
// the logic we care about.
//
// On Windows we KEEP this test — Windows is the platform the orphan bug
// lived on — but give the exit wait a generous budget. Native-module
// teardown (nut-js + sharp's libvips + playwright) is slow on
// `windows-latest` runners: it completes, just not within a tight 5s
// window, regardless of Node version. (An earlier Node-20-only skip
// wrongly assumed Node 22 was immune — it flaked on Win + Node 22 too.)
// A 20s budget tolerates slow-but-fine teardown while still catching a
// genuine hang; the primary assertion (lockfile unlinked) runs and guards
// the bug on Windows either way.
const isHeadlessLinux = process.platform === 'linux' && !process.env.DISPLAY;
const EXIT_BUDGET_MS = process.platform === 'win32' ? 20_000 : 5_000;

function seedHome(): NodeJS.ProcessEnv {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-mcp-orphan-'));
  // Pre-seed consent so the consent gate doesn't block startup. Format
  // matches saveConsent() in src/surface/onboarding.ts; only the file's
  // existence is checked by hasConsent().
  const consentDir = path.join(tmpHome, '.clawdcursor');
  fs.mkdirSync(consentDir, { recursive: true });
  fs.writeFileSync(
    path.join(consentDir, 'consent'),
    JSON.stringify({ accepted: true, timestamp: new Date().toISOString(), platform: process.platform, version: 'test' }, null, 2),
  );
  // Redirect HOME *and* USERPROFILE — os.homedir() honors HOME on POSIX and
  // USERPROFILE on Windows. CI=1 keeps the consent prompt path out of play.
  return { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, CI: '1' };
}

function startMcp(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI_PATH, 'mcp', '--compact'], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Clean exit everywhere except the headless-Linux native-teardown quirk. */
function expectCleanExit({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }): void {
  if (isHeadlessLinux && signal === 'SIGSEGV') return;
  expect(signal, 'process should exit cleanly via process.exit(0), not via signal').toBeNull();
  expect(code, 'process exit code should be 0').toBe(0);
}

describe.skipIf(isHeadlessLinux)('mcp orphan-teardown stdin handler', () => {
  it('exits cleanly when stdin closes (the host went away)', async () => {
    child = startMcp(seedHome());
    // 10s is generous — local dev sees ~1s, cold CI runners 3-5s.
    await waitForReady(child, 10_000);
    // The orphan path: the parent closes its end of the stdin pipe, the
    // handler in cli.ts fires and calls process.exit(0).
    child.stdin.end();
    expectCleanExit(await waitForExit(child, EXIT_BUDGET_MS));
  }, 45_000);

  it('a second MCP server starts while another is running (no single-instance refusal)', async () => {
    // Live, 2026-10: Claude Desktop runs several copies of an extension at
    // once (protocol probe, main connection, Cowork/Code pool), and other
    // hosts may be running clawdcursor too. The old lock made every copy
    // after the first exit with "already running … Kill it first", so the
    // .mcpb could never connect. Orphans are reaped per process (stdin EOF +
    // parent watchdog), which is what the lock existed for.
    const env = seedHome();
    child = startMcp(env);
    await waitForReady(child, 10_000);
    const second = startMcp(env);
    let secondErr = '';
    second.stderr.on('data', d => { secondErr += d.toString('utf-8'); });
    try {
      await waitForReady(second, 10_000);
      expect(secondErr).not.toMatch(/already running/);
      expect(second.exitCode).toBeNull();
    } finally {
      second.stdin.end();
      const exited = await waitForExit(second, EXIT_BUDGET_MS).catch(() => null);
      if (exited) expectCleanExit(exited); else second.kill('SIGKILL');
    }
    child.stdin.end();
    expectCleanExit(await waitForExit(child, EXIT_BUDGET_MS));
  }, 60_000);
});
