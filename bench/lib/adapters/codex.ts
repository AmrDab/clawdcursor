/**
 * Codex CLI as the agent host:
 *   codex exec --json --ignore-user-config ... -c mcp_servers.clawdcursor.url="<isolated>/mcp" ... -
 * with the prompt on stdin. The owner's config.toml (and so their MCP servers) is not loaded, plugins and the shell
 * tool are off: the isolated clawdcursor is the only way to act. The bearer token travels in an environment variable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PREFLIGHT_PROMPT, locateAgent, preflightFailure, runCli, runPreflight, sigOf, SERVER_NAME, type Adapter, type AgentJob, type CliCommand } from './common';
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

/** The preflight: exec with no MCP server, no plugins, no shell and none of the owner's config; the prompt on stdin. */
export function codexPreflightCommand(o: { exe: string; model: string; workDir: string; lastMessagePath: string }): CliCommand {
  return {
    cmd: o.exe,
    args: ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      '--disable', 'plugins', '--disable', 'shell_tool', '-c', 'project_doc_max_bytes=0',
      ...(o.model && o.model !== CODEX_DEFAULT ? ['--model', o.model] : []),
      '--cd', o.workDir, '--output-last-message', o.lastMessagePath, '-'],
    stdin: PREFLIGHT_PROMPT,
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

/** Text that says the clawdcursor MCP server could not be started or reached. Only ever applied to startup / error output. */
function unreachableIn(text: string): string | null {
  const line = text.split('\n').find(l => /mcp/i.test(l) && l.includes(SERVER_NAME) && /fail|error|timed? ?out|unable|could not|refused|not connect/i.test(l));
  return line ? `Codex could not reach the clawdcursor MCP server: ${line.replace(/\s+/g, ' ').trim().slice(0, 240)}` : null;
}

/**
 * Did Codex fail to START or CONNECT to the clawdcursor MCP server?
 *
 * `stream` says where the text came from. On stderr every line is Codex's own diagnostics. On stdout (--json) only an
 * error event or an MCP startup event counts. A tool call's own event never does: it names the server and carries the
 * tool's result, and a tool that failed ("element not found", "refused") is an ordinary failure of a server that was
 * reached, not an unreachable one.
 */
export function codexServerFailure(text: string, stream: 'stdout' | 'stderr'): string | null {
  if (stream === 'stderr') return unreachableIn(text);
  for (const line of text.split('\n')) {
    let ev: { type?: unknown; item?: { type?: unknown } };
    try { ev = JSON.parse(line); } catch { continue; }           // not an event: stdout carries events only
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type ?? '');
    const itemType = String(ev.item?.type ?? '');
    if (itemType === 'mcp_tool_call') continue;
    if (type === 'error' || itemType === 'error' || /mcp.*(startup|start|connect|init)/i.test(type)) {
      const found = unreachableIn(line);
      if (found) return found;
    }
  }
  return null;
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
  async preflight(model, workDir, signal) {
    const found = locateAgent('codex', '--codex-bin', { fallback: codexAppBinary });
    if ('why' in found) return `codex: ${found.why}`;
    const lastMessagePath = path.join(workDir, 'preflight-last-message.txt');
    const { exitCode, out, err } = await runPreflight(codexPreflightCommand({ exe: found.exe, model, workDir, lastMessagePath }), workDir, signal);
    let answered = '';
    try { answered = fs.readFileSync(lastMessagePath, 'utf8').trim(); } catch { /* it wrote no answer */ }
    return exitCode === 0 && answered ? null : preflightFailure('codex', 'codex login', exitCode, `${err} ${out}`);
  },
  async run(job: AgentJob) {
    const found = locateAgent('codex', '--codex-bin', { fallback: codexAppBinary });
    if ('why' in found) throw new Error(`codex: ${found.why}`);
    const exe = found.exe;
    const lastMessagePath = path.join(job.workDir, 'last-message.txt');
    let finalText = '';
    let serverUnreachable: string | undefined;
    const seen = new Set<string>();
    const exitCode = await runCli(codexCommand({ exe, model: job.model, mcpUrl: job.mcpUrl, token: job.token, workDir: job.workDir, lastMessagePath, prompt: job.prompt }), {
      cwd: job.workDir, signal: job.signal, logFile: job.logFile,
      onErr: text => { serverUnreachable ??= codexServerFailure(text, 'stderr') ?? undefined; },
      onLine: line => {
        serverUnreachable ??= codexServerFailure(line, 'stdout') ?? undefined;
        const p = parseCodexLine(line);
        if (p.sig && !(p.id && seen.has(p.id))) { if (p.id) seen.add(p.id); job.onSig(p.sig); }
        if (p.finalText !== undefined) finalText = p.finalText;
      },
    });
    try { finalText = fs.readFileSync(lastMessagePath, 'utf8') || finalText; } catch { /* no last message: the stream's is used */ }
    return { finalText, exitCode, ...(serverUnreachable ? { serverUnreachable } : {}) };
  },
};
