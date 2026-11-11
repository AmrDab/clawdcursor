/**
 * An ISOLATED clawdcursor daemon for the benchmark: its own temp home (so its own ~/.clawdcursor: consent, token,
 * config, logs, pidfile, browser profile), its own port and its own session-log directory. The owner's install, daemon
 * and data are never read or written.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { freePort, killTree, start, tryRun, waitFor } from './proc';

/** dist/surface/cli.js of a repo build (`--build <dir>`), or of the global install. */
export async function resolveCli(buildDir?: string): Promise<{ cli: string; version: string; source: string }> {
  let root: string;
  if (buildDir) root = path.resolve(buildDir);
  else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const globalRoot = (await tryRun(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : npm,
      process.platform === 'win32' ? ['/d', '/s', '/c', `${npm} root -g`] : ['root', '-g']))?.trim();
    if (!globalRoot) throw new Error('npm root -g failed: pass --build <dir> to use a repo build');
    root = path.join(globalRoot, 'clawdcursor');
  }
  const cli = path.join(root, 'dist', 'surface', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error(buildDir ? `${cli} is missing: run "npm run build" in ${root}` : `no global clawdcursor at ${root}: install it or pass --build <dir>`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  return { cli, version, source: buildDir ? `build ${root}` : 'global install' };
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
export function isolatedEnv(base: NodeJS.ProcessEnv, o: { home: string; sessionDir: string; cdpPort: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Nothing of the owner's clawdcursor setup leaks in.
  for (const [k, v] of Object.entries(base)) if (!/^(CLAWD|CLAWDCURSOR|OPENCLAW)_/i.test(k)) env[k] = v;
  return { ...env, HOME: o.home, USERPROFILE: o.home, CLAWDCURSOR_SESSION_DIR: o.sessionDir, CLAWD_AGENT_CDP_PORT: String(o.cdpPort) };
}

export interface IsolatedServer {
  port: number; pid: number; token: string; mcpUrl: string; sessionDir: string;
  stop(): Promise<void>;
}

export async function startIsolated(o: { cli: string; home: string; sessionDir: string; cdpPort: number; logFile: string }): Promise<IsolatedServer> {
  fs.mkdirSync(o.home, { recursive: true });
  fs.mkdirSync(o.sessionDir, { recursive: true });
  const port = await freePort();
  const { cmd, args } = serverCommand(o.cli, port);
  const log = fs.openSync(o.logFile, 'a');
  const child: ChildProcess = start(cmd, args, { env: isolatedEnv(process.env, o), cwd: o.home, stdio: ['ignore', log, log] });
  let exited: number | null | undefined;
  child.once('exit', code => { exited = code; });
  const base = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(o.home, '.clawdcursor', 'token');
  try {
    await waitFor(async () => {
      if (exited !== undefined) throw new Error(`the daemon exited with code ${exited}: see ${o.logFile}`);
      return (await fetch(`${base}/health`)).ok && fs.existsSync(tokenFile);
    }, 45_000, `the isolated clawdcursor on port ${port} (log: ${o.logFile})`);
  } catch (e) {
    killTree(child.pid);
    fs.closeSync(log);
    throw e;
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return {
    port, pid: child.pid ?? 0, token, mcpUrl: `${base}/mcp`, sessionDir: o.sessionDir,
    stop: async () => {
      // Ask it to stop (it closes its session logs), then make sure.
      try { await fetch(`${base}/stop`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); } catch { /* gone */ }
      try { await waitFor(() => exited !== undefined, 5000, 'the daemon to exit'); } catch { killTree(child.pid); }
      fs.closeSync(log);
    },
  };
}
