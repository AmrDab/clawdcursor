/**
 * Finding and running an agent CLI (Claude Code, Codex) with clawdcursor as its only tool. Shared by `clawdcursor task`
 * and the benchmark (bench/), which imports this file from source.
 *
 * Every process is started by argument array, never through a shell, and only processes started here are stopped.
 */
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const isWin = process.platform === 'win32';

/** The MCP server's name in every host: tools are mcp__clawdcursor__<tool> in Claude Code. */
export const SERVER_NAME = 'clawdcursor';

/** Windows system programs by absolute path: never whatever `taskkill` is first on PATH. */
export function system32(...rel: string[]): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...rel);
}

/**
 * A program on PATH. On Windows only a real executable (.exe): a .cmd or .bat shim would have to be run through the
 * shell, and nothing here is.
 */
export function which(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** An npm launcher script for `name` on PATH (name.cmd / name.bat), on Windows. It is only reported, never run. */
export function findShim(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    for (const ext of ['.cmd', '.bat']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** The newest binary the Codex desktop app installed, when codex is not on PATH. */
export function codexAppBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!bin) return null;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(bin); } catch { return null; }
  const found = dirs.flatMap(d => {
    const exe = path.join(bin, d, 'codex.exe');
    try { return [{ exe, at: fs.statSync(exe).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.at - a.at);
  return found[0]?.exe ?? null;
}

/**
 * Started from inside a Claude Code session (CLAUDECODE is set), a child inherits that session's own CLAUDE* and
 * ANTHROPIC* variables (its base URL, entrypoint, host auth). The child would then sign in as that session, not with the
 * owner's own `claude` login: "Credit balance is too low" or "OAuth session expired" although `claude` works in a shell.
 */
export function hostSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.CLAUDECODE) return [];
  return Object.keys(env).filter(k => /^(CLAUDE|ANTHROPIC)|^USE_(LOCAL|STAGING)_OAUTH$/.test(k));
}

/**
 * The flags that leave Claude Code with clawdcursor as its only way to act: no other MCP server (not the owner's, not
 * their plugins'), no built-in tool (Bash, Read, ...), no skill or slash command from the owner's home, nothing saved.
 */
export const CLAUDE_ISOLATION = ['--strict-mcp-config', '--tools', '', '--disable-slash-commands', '--no-session-persistence'];

/**
 * The same for `codex exec`: not the owner's config.toml (so none of their MCP servers), no rules, no plugins (they bring
 * their own MCP servers), no shell tool, no AGENTS.md, nothing saved, a read-only sandbox.
 */
export const CODEX_ISOLATION = ['--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
  '--disable', 'plugins', '--disable', 'shell_tool', '-c', 'project_doc_max_bytes=0'];

/** Codex parses each -c value as TOML: a string must be quoted. JSON strings and arrays of them are valid TOML. */
export const toml = (v: string | string[]) => JSON.stringify(v);

/** Start a child in its own process group (not on Windows), so the whole tree can be stopped. Never through a shell. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { windowsHide: true, detached: !isWin, ...opts, shell: false });
}

/** Stop a process we started, and its children. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) execFileSync(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** `unsetEnv`: variables of this process the agent must not inherit. */
export interface CliCommand { cmd: string; args: string[]; env?: Record<string, string>; unsetEnv?: string[]; stdin?: string }

/**
 * Run a CLI agent: stdout goes to `onLine` line by line, `stdin` (if any) is written and closed. Stops the process tree
 * on abort. `onChild` gets the process once it is started.
 */
export function runCli(c: CliCommand, o: { cwd: string; signal: AbortSignal; onLine(line: string): void; onErr?(text: string): void; logFile?: string;
  onChild?(child: ChildProcess): void }): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...c.env };
    for (const k of c.unsetEnv ?? []) delete env[k];
    const child = start(c.cmd, c.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    o.onChild?.(child);
    const log = o.logFile ? fs.createWriteStream(o.logFile, { flags: 'wx', mode: 0o600 }) : null;
    const onAbort = () => killTree(child.pid);
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    let rest = '';
    child.stdout!.on('data', (d: Buffer) => {
      log?.write(d);
      const lines = (rest + d.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) o.onLine(l);
    });
    child.stderr!.on('data', (d: Buffer) => { log?.write(d); o.onErr?.(d.toString('utf8')); });
    child.once('error', err => { o.signal.removeEventListener('abort', onAbort); log?.end(); reject(err); });
    child.once('close', code => {
      o.signal.removeEventListener('abort', onAbort);
      if (rest.trim()) o.onLine(rest);
      log?.end();
      resolve(code);
    });
    child.stdin!.on('error', () => { /* the agent exited before reading */ });
    child.stdin!.end(c.stdin ?? '');
  });
}
