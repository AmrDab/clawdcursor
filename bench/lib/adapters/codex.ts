/**
 * Codex CLI as the agent host:
 *   codex exec --json --ignore-user-config ... -c mcp_servers.clawdcursor.url="<isolated>/mcp" ... -
 * with the prompt on stdin. The owner's config.toml (and so their MCP servers) is not loaded, plugins and the shell
 * tool are off: the isolated clawdcursor is the only way to act. The bearer token travels in an environment variable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { locateAgent, runCli, sigOf, SERVER_NAME, type Adapter, type AgentJob, type CliCommand } from './common';
import { tryRun } from '../proc';
import type { CallSig } from '../types';

export const TOKEN_ENV = 'BENCH_CLAWDCURSOR_TOKEN';
/** Model name that means "whatever Codex is configured to use": no -m flag. */
export const CODEX_DEFAULT = 'default';

/** Codex parses each -c value as TOML: a string must be quoted. */
const toml = (s: string) => JSON.stringify(s);

export function codexCommand(o: { exe: string; model: string; mcpUrl: string; token: string; workDir: string; lastMessagePath: string; prompt: string }): CliCommand {
  const server = `mcp_servers.${SERVER_NAME}`;
  return {
    cmd: o.exe,
    args: [
      'exec',
      '--json',                           // one JSON event per line: tool calls with their arguments
      '--ignore-user-config',             // not the owner's config.toml: none of their MCP servers
      '--ignore-rules',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--disable', 'plugins',             // plugins bring their own MCP servers (a computer-use one among them)
      '--disable', 'shell_tool',          // the desktop is reached through clawdcursor only
      '-c', `${server}.url=${toml(o.mcpUrl)}`,
      '-c', `${server}.bearer_token_env_var=${toml(TOKEN_ENV)}`,
      '-c', `${server}.default_tools_approval_mode=${toml('approve')}`,   // nobody is there to approve each call
      '-c', `approval_policy=${toml('never')}`,
      '-c', 'project_doc_max_bytes=0',    // no AGENTS.md from the working directory or above it
      ...(o.model && o.model !== CODEX_DEFAULT ? ['--model', o.model] : []),
      '--cd', o.workDir,
      '--output-last-message', o.lastMessagePath,
      '-',                                // the prompt comes on stdin
    ],
    env: { [TOKEN_ENV]: o.token },
    stdin: o.prompt,
  };
}

/**
 * One line of `codex exec --json`. A tool call is an item of type mcp_tool_call: it is reported when it starts and
 * again when it completes, so `id` lets the caller count it once.
 */
export function parseCodexLine(line: string): { sig?: CallSig; id?: string; finalText?: string } {
  let ev: { type?: string; item?: { id?: string; type?: string; server?: string; tool?: string; arguments?: unknown; text?: string } };
  try { ev = JSON.parse(line); } catch { return {}; }
  const item = ev?.item;
  if (!item || typeof item !== 'object') return {};
  if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the text */ } }
    return { sig: sigOf(item.tool, args), id: item.id };
  }
  if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') return { finalText: item.text };
  return {};
}

/** The newest binary the Codex desktop app installed, when codex is not on PATH. */
export function codexAppBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!bin) return null;
  // One stat per candidate: the newest codex.exe that is there.
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(bin); } catch { return null; }
  const found = dirs.flatMap(d => {
    const exe = path.join(bin, d, 'codex.exe');
    try { return [{ exe, at: fs.statSync(exe).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.at - a.at);
  return found[0]?.exe ?? null;
}

export const codex: Adapter = {
  id: 'codex',
  defaultModels: [CODEX_DEFAULT],
  seesImages: true,
  async detect() {
    const found = locateAgent('codex', '--codex-bin', { fallback: codexAppBinary });
    if ('why' in found) return null;
    const v = (await tryRun(found.exe, ['--version']))?.trim();
    return v ? `${v} (${found.exe})` : null;
  },
  why() {
    const found = locateAgent('codex', '--codex-bin', { fallback: codexAppBinary });
    return 'why' in found ? found.why : null;
  },
  async run(job: AgentJob) {
    const found = locateAgent('codex', '--codex-bin', { fallback: codexAppBinary });
    if ('why' in found) throw new Error(`codex: ${found.why}`);
    const exe = found.exe;
    const lastMessagePath = path.join(job.workDir, 'last-message.txt');
    let finalText = '';
    const seen = new Set<string>();
    const exitCode = await runCli(codexCommand({ exe, model: job.model, mcpUrl: job.mcpUrl, token: job.token, workDir: job.workDir, lastMessagePath, prompt: job.prompt }), {
      cwd: job.workDir, signal: job.signal, logFile: job.logFile,
      onLine: line => {
        const p = parseCodexLine(line);
        if (p.sig && !(p.id && seen.has(p.id))) { if (p.id) seen.add(p.id); job.onSig(p.sig); }
        if (p.finalText !== undefined) finalText = p.finalText;
      },
    });
    try { finalText = fs.readFileSync(lastMessagePath, 'utf8') || finalText; } catch { /* no last message: the stream's is used */ }
    return { finalText, exitCode };
  },
};
