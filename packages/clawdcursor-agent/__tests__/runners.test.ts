import { describe, it, expect } from 'vitest';
import { claudeMcpConfig, claudeTaskCommand, codexTaskCommand, mcpEntry, SYSTEM_PROMPT } from '../src/runners';
import { resolveRunner } from '../src/task';
import type { CliStatus } from '../src/detect';
import { parseClaudeAuth, parseCodexLogin } from '../src/detect';

const entry = mcpEntry({ node: '/usr/bin/node', coreEntry: '/opt/clawdcursor/dist/surface/cli.js', runId: '2026-11-15T07-00-43-532Z' });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('the MCP server the agent gets', () => {
  it('is the running core itself, on the compact surface, told its run id', () => {
    expect(entry).toEqual({ command: '/usr/bin/node', args: ['/opt/clawdcursor/dist/surface/cli.js', 'mcp', '--compact'],
      env: { CLAWDCURSOR_RUN_ID: '2026-11-15T07-00-43-532Z' } });
    expect(mcpEntry({ node: 'n', coreEntry: 'c', runId: 'r', granular: true }).args).toEqual(['c', 'mcp']);
  });
  it('is the only server in Claude Code\'s --mcp-config', () => {
    const cfg = JSON.parse(claudeMcpConfig(entry));
    expect(Object.keys(cfg.mcpServers)).toEqual(['clawdcursor']);
    expect(cfg.mcpServers.clawdcursor).toEqual({ type: 'stdio', ...entry });
  });
});

describe('claude -p', () => {
  const cmd = claudeTaskCommand({ exe: '/bin/claude', mcpConfigPath: '/tmp/run/mcp.json', task: 'Open Notepad and type hello' });
  const a = cmd.args;

  it('signs in with the owner\'s Claude Code login, never an API key from the environment', () => {
    const c = claudeTaskCommand({ exe: 'claude', mcpConfigPath: 'm.json', task: 't' });
    expect(c.unsetEnv).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']));
    expect(new Set(c.unsetEnv).size).toBe(c.unsetEnv!.length);
  });

  it('streams JSON both ways, in print mode', () => {
    expect(a[0]).toBe('-p');
    expect(flag(a, '--input-format')).toBe('stream-json');
    expect(flag(a, '--output-format')).toBe('stream-json');
    expect(a).toContain('--verbose');
  });
  it('connects only clawdcursor (strict MCP config) and allows only its tools', () => {
    expect(flag(a, '--mcp-config')).toBe('/tmp/run/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(flag(a, '--allowedTools')).toBe('mcp__clawdcursor__*');
  });
  it('turns every built-in tool off, and anything not allowed is denied, never asked', () => {
    expect(flag(a, '--tools')).toBe('');
    expect(flag(a, '--permission-mode')).toBe('dontAsk');
    expect(a.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });
  it('loads none of the owner\'s settings, skills or saved sessions', () => {
    expect(flag(a, '--setting-sources')).toBe('');
    expect(a).toContain('--disable-slash-commands');
    expect(a).toContain('--no-session-persistence');
  });
  it('adds the short system prompt that asks for a PASS/FAIL line', () => {
    expect(flag(a, '--append-system-prompt')).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toMatch(/PASS: .*FAIL: /);
  });
  it('waits for the clawdcursor server before the first turn, up to 60 s', () => {
    expect(claudeTaskCommand({ exe: 'claude', mcpConfigPath: 'm.json', task: 't' }).env).toEqual({ MCP_CONNECTION_NONBLOCKING: 'false', MCP_TIMEOUT: '60000' });
  });
  it('sends the task as one stream-json user message on stdin, not on the command line', () => {
    expect(a.join(' ')).not.toContain('Notepad');
    expect(cmd.stdin!.endsWith('\n')).toBe(true);
    expect(JSON.parse(cmd.stdin!)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Open Notepad and type hello' }] } });
  });
  it('names a model only when one is asked for (else the owner\'s default)', () => {
    expect(a).not.toContain('--model');
    expect(flag(claudeTaskCommand({ exe: 'c', model: 'sonnet', mcpConfigPath: 'm', task: 't' }).args, '--model')).toBe('sonnet');
  });
});

describe('codex exec', () => {
  const cmd = codexTaskCommand({ exe: '/bin/codex', entry, workDir: '/tmp/run', lastMessagePath: '/tmp/run/last.txt', task: 'Open Notepad' });
  const a = cmd.args;
  const configs = a.filter((_, i) => a[i - 1] === '-c');

  it('runs exec with JSON events, the prompt on stdin', () => {
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a[a.length - 1]).toBe('-');
    expect(cmd.stdin).toContain('Task: Open Notepad');
    expect(cmd.stdin!.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(flag(a, '--cd')).toBe('/tmp/run');
    expect(flag(a, '--output-last-message')).toBe('/tmp/run/last.txt');
  });
  it('configures clawdcursor over stdio as its only MCP server, in TOML', () => {
    expect(configs).toContain('mcp_servers.clawdcursor.command="/usr/bin/node"');
    expect(configs).toContain('mcp_servers.clawdcursor.args=["/opt/clawdcursor/dist/surface/cli.js","mcp","--compact"]');
    expect(configs).toContain('mcp_servers.clawdcursor.env.CLAWDCURSOR_RUN_ID="2026-11-15T07-00-43-532Z"');
    expect(configs).toContain('mcp_servers.clawdcursor.default_tools_approval_mode="approve"');
    expect(configs).toContain('approval_policy="never"');
    expect(a).toContain('--ignore-user-config');
  });
  it('turns the built-ins off: no plugins, no shell tool, no AGENTS.md, read-only sandbox', () => {
    expect(a.filter((_, i) => a[i - 1] === '--disable')).toEqual(['plugins', 'shell_tool']);
    expect(configs).toContain('project_doc_max_bytes=0');
    expect(flag(a, '--sandbox')).toBe('read-only');
    expect(a.join(' ')).not.toContain('dangerously');
  });
  it('a Windows path survives the TOML quoting', () => {
    const win = codexTaskCommand({ exe: 'codex', entry: mcpEntry({ node: 'C:\\Program Files\\nodejs\\node.exe', coreEntry: 'C:\\x\\cli.js', runId: 'r' }),
      workDir: 'w', lastMessagePath: 'l', task: 't' });
    const c = win.args.filter((_, i) => win.args[i - 1] === '-c');
    expect(c).toContain('mcp_servers.clawdcursor.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });
  it('names a model only when one is asked for', () => {
    expect(a).not.toContain('--model');
    const named = codexTaskCommand({ exe: 'c', model: 'gpt-5.5', entry, workDir: 'w', lastMessagePath: 'l', task: 't' });
    expect(flag(named.args, '--model')).toBe('gpt-5.5');
  });
});

const cli = (id: 'claude' | 'codex', o: Partial<CliStatus> = {}): CliStatus =>
  ({ id, exe: `/bin/${id}`, version: '1', signedIn: true, detail: null, fix: null, ...o });

describe('choosing the runner', () => {
  const none = (id: 'claude' | 'codex') => cli(id, { exe: null, signedIn: null, fix: `${id} is not installed: install it.` });
  it('defaults to Claude Code when it is installed and signed in, then Codex', async () => {
    expect(await resolveRunner(undefined, {}, { claude: async () => cli('claude'), codex: async () => cli('codex') })).toMatchObject({ runner: 'claude' });
    expect(await resolveRunner(undefined, {}, { claude: async () => cli('claude', { signedIn: false }), codex: async () => cli('codex') })).toMatchObject({ runner: 'codex' });
  });
  it('the runner doctor --setup picked comes before the guess; --with before both', async () => {
    const d = { claude: async () => cli('claude'), codex: async () => cli('codex') };
    expect(await resolveRunner(undefined, { runner: 'codex' }, d)).toMatchObject({ runner: 'codex' });
    expect(await resolveRunner('claude', { runner: 'codex' }, d)).toMatchObject({ runner: 'claude' });
    expect(await resolveRunner('anthropic', {}, d)).toEqual({ runner: 'anthropic' });
  });
  it('a CLI that is not signed in gives its one-line next step', async () => {
    const r = await resolveRunner('claude', {}, { claude: async () => cli('claude', { signedIn: false, fix: 'Claude Code is not signed in: run `claude` once and sign in.' }), codex: async () => none('codex') });
    expect(r).toEqual({ error: 'Claude Code is not signed in: run `claude` once and sign in.' });
  });
  it('nothing usable: says how to get one', async () => {
    const r = await resolveRunner(undefined, {}, { claude: async () => none('claude'), codex: async () => none('codex') });
    expect('error' in r && r.error).toMatch(/No signed-in agent CLI found.*codex login.*doctor --setup/);
  });
  it('rejects an unknown runner', async () => {
    expect(await resolveRunner('gemini', {}, { claude: async () => cli('claude'), codex: async () => cli('codex') })).toEqual({ error: expect.stringMatching(/Unknown runner "gemini"/) });
  });
});

describe('sign-in status', () => {
  it('reads claude auth status --json, never the email', () => {
    const r = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiProvider: 'firstParty', email: 'someone@example.com' }));
    expect(r).toEqual({ signedIn: true, detail: 'claude.ai, max subscription' });
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false }))).toEqual({ signedIn: false, detail: null });
    expect(parseClaudeAuth('unknown command')).toEqual({ signedIn: null, detail: null });
  });
  it('reads codex login status', () => {
    expect(parseCodexLogin({ code: 0, out: 'Logged in using ChatGPT\n' })).toEqual({ signedIn: true, detail: 'Logged in using ChatGPT' });
    expect(parseCodexLogin({ code: 1, out: 'Not logged in\n' })).toEqual({ signedIn: false, detail: null });
    expect(parseCodexLogin(null)).toEqual({ signedIn: null, detail: null });
  });
});
