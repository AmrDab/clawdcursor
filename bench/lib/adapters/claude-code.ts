/**
 * Claude Code as the agent host:
 *   claude -p --model <sonnet|haiku> --mcp-config <file> --strict-mcp-config --allowedTools "mcp__clawdcursor__*" ...
 * with the prompt on stdin. Only the isolated server is connected, and only its tools are allowed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runCli, sigOf, which, SERVER_NAME, type Adapter, type AgentJob, type CliCommand } from './common';
import { tryRun } from '../proc';
import type { CallSig } from '../types';

/** The --mcp-config file: the isolated server over HTTP, with its bearer token. */
export function claudeMcpConfig(mcpUrl: string, token: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

export function claudeCommand(o: { exe: string; model: string; mcpConfigPath: string; prompt: string }): CliCommand {
  return {
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

/** One line of --output-format stream-json: the tool calls the model made in it, and the final reply if it is the result line. */
export function parseClaudeLine(line: string): { sigs: CallSig[]; finalText?: string } {
  let msg: { type?: string; result?: unknown; message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } };
  try { msg = JSON.parse(line); } catch { return { sigs: [] }; }
  if (msg?.type === 'result') return { sigs: [], finalText: typeof msg.result === 'string' ? msg.result : '' };
  if (msg?.type !== 'assistant' || !Array.isArray(msg.message?.content)) return { sigs: [] };
  return { sigs: msg.message.content.filter(b => b?.type === 'tool_use' && typeof b.name === 'string').map(b => sigOf(b.name!, b.input)) };
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  defaultModels: ['sonnet', 'haiku'],
  seesImages: true,
  async detect() {
    const exe = which('claude');
    if (!exe) return null;
    const v = (await tryRun(exe, ['--version']))?.trim();
    return v ? `${v} (${exe})` : null;
  },
  async run(job: AgentJob) {
    const exe = which('claude');
    if (!exe) throw new Error('claude is not on PATH');
    const mcpConfigPath = path.join(job.workDir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, claudeMcpConfig(job.mcpUrl, job.token), { flag: 'wx', mode: 0o600 });
    let finalText = '';
    const exitCode = await runCli(claudeCommand({ exe, model: job.model, mcpConfigPath, prompt: job.prompt }), {
      cwd: job.workDir, signal: job.signal, logFile: job.logFile,
      onLine: line => {
        const p = parseClaudeLine(line);
        p.sigs.forEach(job.onSig);
        if (p.finalText !== undefined) finalText = p.finalText;
      },
    });
    return { finalText, exitCode };
  },
};
