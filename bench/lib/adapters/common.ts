/** What every agent adapter shares: the job, the result, running a CLI and reading its output line by line. */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findShim, which } from '../proc';
import { runCli, SERVER_NAME, type CliCommand } from '../../../packages/clawdcursor-agent/src/hosts';

export { which, runCli, SERVER_NAME, type CliCommand };

/** The binaries named with --claude-bin / --codex-bin, by program name ("claude", "codex"). */
const binOverrides = new Map<string, string>();

/**
 * Use this binary for `name` instead of looking on PATH. Only a native executable is accepted: on Windows a path that
 * ends in .exe (a .cmd or .bat shim would need a shell, and nothing here runs through one); an existing file anywhere.
 */
export function setAgentBin(name: string, file: string, platform: string = process.platform): void {
  const abs = path.resolve(file);
  if (platform === 'win32' ? !/\.exe$/i.test(abs) : /\.(cmd|bat|ps1|sh)$/i.test(abs)) {
    throw new Error(`${file} is not a native binary: pass the path of ${name}${platform === 'win32' ? '.exe' : ''} itself, not a launcher script`);
  }
  let isFile = false;
  try { isFile = fs.statSync(abs).isFile(); } catch { /* not there */ }
  if (!isFile) throw new Error(`${file} is not a file`);
  binOverrides.set(name, abs);
}
export function clearAgentBins(): void { binOverrides.clear(); }

/**
 * The native binary of an agent host: the one named with its --*-bin flag, else `name` on PATH (a real executable),
 * else what `fallback` finds. When there is none, `why` says so; an npm .cmd shim on PATH is named, not run.
 */
export function locateAgent(name: string, flag: string, o: { fallback?: () => string | null; env?: NodeJS.ProcessEnv; platform?: string } = {}): { exe: string } | { why: string } {
  const override = binOverrides.get(name);
  if (override) return { exe: override };
  const exe = which(name, o.env, o.platform) ?? o.fallback?.() ?? null;
  if (exe) return { exe };
  const shim = findShim(name, o.env, o.platform);
  return { why: shim
    ? `found only an npm .cmd shim at ${shim}; the benchmark needs the native binary (${name}.exe): install it from the vendor, or pass ${flag}`
    : 'not installed' };
}
import type { Usage } from '../../../packages/clawdcursor-agent/src/trace';
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

export interface AgentResult {
  finalText: string; exitCode: number | null;
  /** The host could not connect to the isolated clawdcursor (connect, initialize or tools/list failed): why. */
  serverUnreachable?: string;
  /** What the host reported using, when it does. */
  usage?: Usage;
}

export interface Adapter {
  id: string;
  /** Models to run when none is named. */
  defaultModels: string[];
  /** False when tool results reach the model without images: tasks that need a screenshot are not run (n/a). */
  seesImages: boolean;
  /** A version or detail line when this agent host is installed, else null. */
  detect(): Promise<string | null>;
  /** Why detect() found nothing usable, when there is more to say than "not installed" (only a .cmd shim, a bad --*-bin). */
  why?(): string | null;
  run(job: AgentJob): Promise<AgentResult>;
  /**
   * Start the agent host once with a trivial prompt and no tools. Null when it answered; else why it cannot run
   * (not signed in, did not start). `workDir` is an empty directory outside the owner's home.
   */
  preflight(model: string, workDir: string, signal: AbortSignal): Promise<string | null>;
}

export const PREFLIGHT_PROMPT = 'Reply with the single word OK.';

/**
 * What a failed preflight means, for the person running the benchmark. `said` is whatever the host printed.
 * `login` is the command that signs it in.
 */
export function preflightFailure(id: string, login: string, exitCode: number | null, said: string): string {
  const text = said.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (/authenticat|oauth|log ?in|sign ?in|unauthori[sz]ed|\b401\b|api key|credential/i.test(text)) {
    return `${id} is not signed in: run \`${login}\` and log in. (${text})`;
  }
  return `${id} did not answer a trivial prompt (exit code ${exitCode}): ${text || 'no output'}`;
}

/** Run a host's preflight command and collect what it printed (stdout and stderr). */
export async function runPreflight(c: CliCommand, workDir: string, signal: AbortSignal): Promise<{ exitCode: number | null; out: string; err: string }> {
  let out = '', err = '';
  const exitCode = await runCli(c, { cwd: workDir, signal, onLine: l => { out += `${l}\n`; }, onErr: t => { err += t; } })
    .catch((e: Error) => { err += e.message; return 1; });
  return { exitCode, out, err };
}

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
