/**
 * Claude Code as the agent host:
 *   claude -p --model <sonnet|haiku> --mcp-config <file> --strict-mcp-config --allowedTools "mcp__clawdcursor__*" ...
 * with the prompt on stdin. Only the isolated server is connected, and only its tools are allowed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PREFLIGHT_PROMPT, locateAgent, preflightFailure, runCli, runPreflight, sigOf, SERVER_NAME, type Adapter, type AgentJob, type CliCommand } from './common';
import { tryRun } from '../proc';
import type { CallSig } from '../types';

/** The --mcp-config file: the isolated server over HTTP, with its bearer token. */
export function claudeMcpConfig(mcpUrl: string, token: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

/**
 * A benchmark started from inside a Claude Code session (CLAUDECODE is set) inherits that session's own CLAUDE* and
 * ANTHROPIC* variables (its base URL, entrypoint, host auth). The agent would then sign in as that session, not with the
 * owner's own `claude` login: "Credit balance is too low" or "OAuth session expired" although `claude` works in a shell.
 */
export function hostSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.CLAUDECODE) return [];
  return Object.keys(env).filter(k => /^(CLAUDE|ANTHROPIC)|^USE_(LOCAL|STAGING)_OAUTH$/.test(k));
}

export function claudeCommand(o: { exe: string; model: string; mcpConfigPath: string; prompt: string }): CliCommand {
  return {
    unsetEnv: hostSessionEnv(),
    cmd: o.exe,
    args: [
      '-p',
      '--model', o.model,
      '--mcp-config', o.mcpConfigPath,
      '--strict-mcp-config',                               // no other MCP server: not the owner's clawdcursor, not their plugins'
      '--setting-sources', 'project',                      // not the owner's user settings: no hooks, plugins or CLAUDE.md of theirs (the cwd is an empty directory)
      '--allowedTools', `mcp__${SERVER_NAME}__*`,
      '--tools', '',                                       // no built-in tool (Bash, Read, ...): the desktop is reached through clawdcursor only
      '--disable-slash-commands',                          // no skill from the owner's home: the server under test brings its own guidance
      '--no-session-persistence',
      '--output-format', 'stream-json', '--verbose',       // one JSON line per message: tool calls with their arguments, then the result
    ],
    stdin: o.prompt,
  };
}

/** The preflight: print mode, no MCP server, no tool, none of the owner's settings; one JSON result. The prompt goes on stdin. */
export function claudePreflightCommand(o: { exe: string; model: string }): CliCommand {
  return {
    unsetEnv: hostSessionEnv(),
    cmd: o.exe,
    args: ['-p', '--model', o.model, '--strict-mcp-config', '--setting-sources', 'project', '--tools', '', '--disable-slash-commands',
      '--no-session-persistence', '--output-format', 'json'],
    stdin: PREFLIGHT_PROMPT,
  };
}

/** The preflight's one JSON line: did it answer, and what it said. */
export function parseClaudePreflight(out: string): { ok: boolean; said: string } {
  for (const line of out.split('\n').reverse()) {
    try {
      const r = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown };
      if (r?.type === 'result') return { ok: r.is_error !== true && typeof r.result === 'string', said: String(r.result ?? '') };
    } catch { /* not the result line */ }
  }
  return { ok: false, said: out };
}

/** One line of --output-format stream-json: the tool calls the model made in it, and the final reply if it is the result line. */
export function parseClaudeLine(line: string): { sigs: CallSig[]; finalText?: string; serverUnreachable?: string } {
  let msg: { type?: string; subtype?: string; result?: unknown; mcp_servers?: Array<{ name?: string; status?: string }>;
    message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } };
  try { msg = JSON.parse(line); } catch { return { sigs: [] }; }
  // The first line of a session lists the MCP servers and whether each connected. Anything but "connected" for the one
  // server this run has means the agent has no clawdcursor tools: the server's failure, not the agent's.
  if (msg?.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.mcp_servers)) {
    const server = msg.mcp_servers.find(s => s?.name === SERVER_NAME);
    if (!server) return { sigs: [], serverUnreachable: 'Claude Code started without the clawdcursor MCP server' };
    if (server.status !== 'connected') return { sigs: [], serverUnreachable: `Claude Code reports the clawdcursor MCP server as "${server.status ?? 'unknown'}"` };
    return { sigs: [] };
  }
  if (msg?.type === 'result') return { sigs: [], finalText: typeof msg.result === 'string' ? msg.result : '' };
  if (msg?.type !== 'assistant' || !Array.isArray(msg.message?.content)) return { sigs: [] };
  return { sigs: msg.message.content.filter(b => b?.type === 'tool_use' && typeof b.name === 'string').map(b => sigOf(b.name!, b.input)) };
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  defaultModels: ['sonnet', 'haiku'],
  seesImages: true,
  async detect() {
    const found = locateAgent('claude', '--claude-bin');
    if ('why' in found) return null;
    const v = (await tryRun(found.exe, ['--version']))?.trim();
    return v ? `${v} (${found.exe})` : null;
  },
  why() {
    const found = locateAgent('claude', '--claude-bin');
    return 'why' in found ? found.why : null;
  },
  async preflight(model, workDir, signal) {
    const found = locateAgent('claude', '--claude-bin');
    if ('why' in found) return `claude-code: ${found.why}`;
    const { exitCode, out, err } = await runPreflight(claudePreflightCommand({ exe: found.exe, model }), workDir, signal);
    const r = parseClaudePreflight(out);
    return exitCode === 0 && r.ok ? null : preflightFailure('claude-code', 'claude', exitCode, r.said || err);
  },
  async run(job: AgentJob) {
    const found = locateAgent('claude', '--claude-bin');
    if ('why' in found) throw new Error(`claude: ${found.why}`);
    const exe = found.exe;
    const mcpConfigPath = path.join(job.workDir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, claudeMcpConfig(job.mcpUrl, job.token), { flag: 'wx', mode: 0o600 });
    let finalText = '';
    let serverUnreachable: string | undefined;
    const exitCode = await runCli(claudeCommand({ exe, model: job.model, mcpConfigPath, prompt: job.prompt }), {
      cwd: job.workDir, signal: job.signal, logFile: job.logFile,
      onLine: line => {
        const p = parseClaudeLine(line);
        p.sigs.forEach(job.onSig);
        if (p.finalText !== undefined) finalText = p.finalText;
        if (p.serverUnreachable) serverUnreachable = p.serverUnreachable;
      },
    });
    return { finalText, exitCode, ...(serverUnreachable ? { serverUnreachable } : {}) };
  },
};
