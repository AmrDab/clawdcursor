/**
 * The command lines `clawdcursor task` runs. The agent CLI gets exactly one MCP server, this clawdcursor (the same
 * entry point and Node that run `clawdcursor task`, so the version matches), and none of its own built-in tools.
 */
import { CLAUDE_ISOLATION, CODEX_ISOLATION, SERVER_NAME, hostSessionEnv, toml, type CliCommand } from './hosts';

/** How the agent starts clawdcursor's stdio MCP server. `runId` reaches the server, which writes it in its session header. */
export interface McpEntry { command: string; args: string[]; env: Record<string, string> }

export function mcpEntry(o: { node: string; coreEntry: string; runId: string; granular?: boolean }): McpEntry {
  return { command: o.node, args: [o.coreEntry, 'mcp', ...(o.granular ? [] : ['--compact'])], env: { CLAWDCURSOR_RUN_ID: o.runId } };
}

export const SYSTEM_PROMPT = [
  'You are testing clawdcursor, a desktop-automation MCP server.',
  `Its tools (mcp__${SERVER_NAME}__*) are the only tools you have: do the user's task on this computer's desktop with them.`,
  'Keep your messages short.',
  'When the task is done, or you cannot go on, end your final message with one line:',
  '"PASS: <what you did>" when the task is done, or "FAIL: <why not>" when it is not.',
].join(' ');

/** Claude Code's --mcp-config file: clawdcursor over stdio, nothing else. */
export function claudeMcpConfig(entry: McpEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: entry.command, args: entry.args, env: entry.env } } }, null, 2);
}

/** One user message for --input-format stream-json. */
export function streamJsonUser(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/**
 * claude -p, streaming JSON both ways, with clawdcursor as its only MCP server and only tools, none of the owner's
 * settings, and the task on stdin. `model` unset = the owner's default model.
 */
export function claudeTaskCommand(o: { exe: string; model?: string; mcpConfigPath: string; task: string }): CliCommand {
  return {
    unsetEnv: hostSessionEnv(),
    cmd: o.exe,
    args: [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', o.mcpConfigPath,
      ...CLAUDE_ISOLATION,                       // only that server; no built-in tool; no skill or slash command; nothing saved
      '--setting-sources', '',                   // none of the owner's settings files: no hooks, plugins, permissions or CLAUDE.md
      '--allowedTools', `mcp__${SERVER_NAME}__*`,
      '--permission-mode', 'dontAsk',            // nobody is there to approve: anything not allowed above is denied, not asked
      '--append-system-prompt', SYSTEM_PROMPT,
      ...(o.model ? ['--model', o.model] : []),
    ],
    stdin: streamJsonUser(o.task),
  };
}

/**
 * codex exec --json with clawdcursor as its only MCP server: none of the owner's config.toml, plugins, shell tool or
 * AGENTS.md. Codex has no system prompt flag here, so the instructions lead the prompt on stdin. `model` unset = Codex's default.
 */
export function codexTaskCommand(o: { exe: string; model?: string; entry: McpEntry; workDir: string; lastMessagePath: string; task: string }): CliCommand {
  const s = `mcp_servers.${SERVER_NAME}`;
  return {
    cmd: o.exe,
    args: [
      'exec', '--json',
      ...CODEX_ISOLATION,
      '-c', `${s}.command=${toml(o.entry.command)}`,
      '-c', `${s}.args=${toml(o.entry.args)}`,
      ...Object.entries(o.entry.env).flatMap(([k, v]) => ['-c', `${s}.env.${k}=${toml(v)}`]),
      '-c', `${s}.startup_timeout_sec=60`,       // a cold start on Windows can take longer than the 10 s default
      '-c', `${s}.tool_timeout_sec=900`,         // pause_for_user waits for the person at the screen
      '-c', `${s}.default_tools_approval_mode=${toml('approve')}`,   // nobody is there to approve each call
      '-c', `approval_policy=${toml('never')}`,
      ...(o.model ? ['--model', o.model] : []),
      '--cd', o.workDir,
      '--output-last-message', o.lastMessagePath,
      '-',                                       // the prompt comes on stdin
    ],
    stdin: `${SYSTEM_PROMPT}\n\nTask: ${o.task}\n`,
  };
}

/** Show a command line the way a person would type it (for the run log and the docs; it is never run through a shell). */
export function displayCommand(c: CliCommand): string {
  const q = (a: string) => (a === '' ? '""' : /[\s"'$`\\|&;<>()*?[\]{}]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
  return [c.cmd, ...c.args].map(q).join(' ');
}
