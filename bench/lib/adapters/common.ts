/** What every agent adapter shares: the job, the result, running a CLI and reading its output line by line. */
import { createHash } from 'crypto';
import * as fs from 'fs';
import { killTree, start, which } from '../proc';

export { which };
import type { CallSig } from '../types';

export interface AgentJob {
  prompt: string;
  model: string;
  /** The isolated server's MCP endpoint and its bearer token. */
  mcpUrl: string;
  token: string;
  /**
   * An empty directory OUTSIDE the owner's home: the agent's working directory and its config file. Nothing of the
   * owner's (CLAUDE.md, AGENTS.md, project settings) is in it or above it.
   */
  workDir: string;
  /** Where the agent's output is kept (the results directory). */
  logFile: string;
  /** Each tool call the model makes, as it makes it. */
  onSig(s: CallSig): void;
  /** Aborted by the watchdog: the adapter stops the agent at once. */
  signal: AbortSignal;
}

export interface AgentResult { finalText: string; exitCode: number | null }

export interface Adapter {
  id: string;
  /** Models to run when none is named. */
  defaultModels: string[];
  /** False when tool results reach the model without images: tasks that need a screenshot are not run (n/a). */
  seesImages: boolean;
  /** A version or detail line when this agent host is installed, else null. */
  detect(): Promise<string | null>;
  run(job: AgentJob): Promise<AgentResult>;
}

export interface CliCommand { cmd: string; args: string[]; env?: Record<string, string>; stdin?: string }

/** The MCP server's name in every host: tools are mcp__clawdcursor__<tool> in Claude Code. */
export const SERVER_NAME = 'clawdcursor';

/** Stable JSON: keys sorted, so the same arguments give the same signature. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** A call's signature: the tool and a hash of its arguments. The arguments themselves are not kept. */
export function sigOf(tool: string, args: unknown): CallSig {
  const name = tool.replace(/^mcp__clawdcursor__/, '').replace(/^clawdcursor[./_]+/, '');
  return { tool: name, sig: createHash('sha1').update(`${name}\n${stable(args ?? {})}`).digest('hex').slice(0, 16) };
}

/** Run a CLI agent: stdout goes to `onLine` line by line, the prompt (if any) to stdin. Stops the process tree on abort. */
export function runCli(c: CliCommand, o: { cwd: string; signal: AbortSignal; onLine(line: string): void; logFile?: string }): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // The executable itself with its arguments as an array: no shell, so nothing in a path or the environment is parsed
    // as a command. (A .cmd shim cannot be run this way: `which` only returns real executables.)
    const child = start(c.cmd, c.args, { cwd: o.cwd, env: { ...process.env, ...c.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const log = o.logFile ? fs.createWriteStream(o.logFile, { flags: 'wx', mode: 0o600 }) : null;
    const onAbort = () => killTree(child.pid);
    o.signal.addEventListener('abort', onAbort, { once: true });
    let rest = '';
    child.stdout!.on('data', (d: Buffer) => {
      log?.write(d);
      const lines = (rest + d.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) o.onLine(l);
    });
    child.stderr!.on('data', (d: Buffer) => { log?.write(d); });
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
