/**
 * An ISOLATED clawdcursor daemon for the benchmark: its own temp home (so its own ~/.clawdcursor: consent, token,
 * config, logs, pidfile, browser profile), its own port and its own session-log directory. The owner's install, daemon
 * and data are never read or written.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { freePort, killTree, start, waitFor, which } from './proc';

/**
 * Where a global `npm install -g clawdcursor` puts the package, without asking npm (no shell, no child process): next to
 * the `clawdcursor` launcher on PATH, in npm's global folder on Windows, or under the lib folder of this Node.
 */
export function globalPackageRoots(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, execPath: string = process.execPath): string[] {
  const roots: string[] = [];
  const launcher = which('clawdcursor', env, platform);
  if (launcher) {
    roots.push(path.join(path.dirname(launcher), 'node_modules', 'clawdcursor'));              // Windows: <prefix>\clawdcursor.cmd
    roots.push(path.join(path.dirname(launcher), '..', 'lib', 'node_modules', 'clawdcursor')); // macOS / Linux: <prefix>/bin/clawdcursor
  }
  if (platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'npm', 'node_modules', 'clawdcursor'));
  roots.push(path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'clawdcursor'));
  roots.push(path.join(path.dirname(execPath), 'node_modules', 'clawdcursor'));
  return [...new Set(roots.map(r => path.resolve(r)))];
}

/** The text of a file, or null when it is not there: one read, no "does it exist" first. */
function readIfThere(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null; throw e; }
}

/** dist/surface/cli.js of a repo build (`--build <dir>`), or of the global install. */
export async function resolveCli(buildDir?: string): Promise<{ cli: string; version: string; source: string }> {
  const roots = buildDir ? [path.resolve(buildDir)] : globalPackageRoots();
  for (const root of roots) {
    const pkg = readIfThere(path.join(root, 'package.json'));
    const cli = path.join(root, 'dist', 'surface', 'cli.js');
    if (pkg === null || readIfThere(cli) === null) continue;
    return { cli, version: JSON.parse(pkg).version as string, source: buildDir ? `build ${root}` : `global install ${root}` };
  }
  throw new Error(buildDir ? `${path.join(roots[0], 'dist', 'surface', 'cli.js')} is missing: run "npm run build" in ${roots[0]}`
    : 'no global clawdcursor found: install it or pass --build <dir>');
}

/** The daemon's command line: the compact surface (the six tools agents use) on its own port, consent accepted in the temp home. */
export function serverCommand(cli: string, port: number): { cmd: string; args: string[] } {
  return { cmd: process.execPath, args: [cli, 'agent', '--compact', '--port', String(port), '--accept'] };
}

/**
 * The daemon's environment. HOME / USERPROFILE move ~/.clawdcursor into the temp home. The agent browser port
 * (CLAWD_AGENT_CDP_PORT) is the fixture browser's: the `browser` tool attaches there first, so it never reaches for a
 * browser the owner put on the default debug port.
 */
export function isolatedEnv(base: NodeJS.ProcessEnv, o: { home: string; sessionDir: string; cdpPort: number; fencePids?: number[] }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Nothing of the owner's clawdcursor setup leaks in.
  for (const [k, v] of Object.entries(base)) if (!/^(CLAWD|CLAWDCURSOR|OPENCLAW)_/i.test(k)) env[k] = v;
  return { ...env, HOME: o.home, USERPROFILE: o.home, CLAWDCURSOR_SESSION_DIR: o.sessionDir, CLAWD_AGENT_CDP_PORT: String(o.cdpPort),
    // The fence (src/core/fence.ts): the daemon refuses, before acting or reading, anything outside these processes and
    // their children. An empty list still sets it: then everything is outside.
    ...(o.fencePids ? { CLAWD_FENCE_PIDS: o.fencePids.join(',') || 'none' } : {}) };
}

/** The daemon listens on the loopback interface only, and nothing here talks to any other host. */
const LOOPBACK = '127.0.0.1';

export interface IsolatedServer {
  port: number; pid: number; token: string; mcpUrl: string; sessionDir: string;
  stop(): Promise<void>;
  /** At once, with no request to the daemon: for Ctrl+C and crashes. */
  kill(): void;
}

export async function startIsolated(o: { cli: string; home: string; sessionDir: string; cdpPort: number; logFile: string; fencePids?: number[] }): Promise<IsolatedServer> {
  fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(o.sessionDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const { cmd, args } = serverCommand(o.cli, port);
  const log = fs.openSync(o.logFile, 'wx', 0o600);   // a new file in this run's own directory
  const child: ChildProcess = start(cmd, args, { env: isolatedEnv(process.env, o), cwd: o.home, stdio: ['ignore', log, log] });
  let exited: number | null | undefined;
  child.once('exit', code => { exited = code; });
  const base = `http://${LOOPBACK}:${port}`;
  const tokenFile = path.join(o.home, '.clawdcursor', 'token');
  try {
    await waitFor(async () => {
      if (exited !== undefined) throw new Error(`the daemon exited with code ${exited}: see ${o.logFile}`);
      return (await fetch(`${base}/health`)).ok && readIfThere(tokenFile) !== null;
    }, 45_000, `the isolated clawdcursor on port ${port} (log: ${o.logFile})`);
  } catch (e) {
    killTree(child.pid);
    fs.closeSync(log);
    throw e;
  }
  const token = (readIfThere(tokenFile) ?? '').trim();
  return {
    port, pid: child.pid ?? 0, token, mcpUrl: `${base}/mcp`, sessionDir: o.sessionDir,
    stop: async () => {
      // A signal, not a request: macOS and Linux let the daemon close its session logs on SIGTERM; Windows has no such
      // signal, and nothing is lost there (every call is in the session log the moment it returns).
      if (process.platform !== 'win32' && child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
      else killTree(child.pid);
      try { await waitFor(() => exited !== undefined, 5000, 'the daemon to exit'); } catch { killTree(child.pid); }
      try { fs.closeSync(log); } catch { /* closed by kill() */ }
    },
    kill: () => { killTree(child.pid); try { fs.closeSync(log); } catch { /* already closed */ } },
  };
}
