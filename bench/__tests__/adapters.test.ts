import { describe, it, expect } from 'vitest';
import { claudeCommand, claudeMcpConfig, claudePreflightCommand, parseClaudeLine, parseClaudePreflight } from '../lib/adapters/claude-code';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PREFLIGHT_PROMPT, clearAgentBins, locateAgent, preflightFailure, setAgentBin, sigOf, type Adapter } from '../lib/adapters/common';
import { parseArgs } from '../run';
import { ADAPTERS, parseModels, preflightAll } from '../lib/adapters';
import { CODEX_DEFAULT, TOKEN_ENV, codexCommand, codexPreflightCommand, codexServerFailure, parseCodexLine } from '../lib/adapters/codex';
import { ollama } from '../lib/adapters/ollama';
import { probeMcp } from '../lib/isolated';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { MAX_TURNS, RESULT_CHARS, argsOf, chatRequest, resultText, runLoop, toOllamaTools, type OllamaMessage } from '../lib/adapters/ollama';

describe('call signatures', () => {
  it('are the same for the same tool and arguments, whatever the key order or the host prefix', () => {
    const a = sigOf('mcp__clawdcursor__accessibility', { action: 'invoke', name: 'New' });
    const b = sigOf('accessibility', { name: 'New', action: 'invoke' });
    expect(a).toEqual(b);
    expect(a.tool).toBe('accessibility');
    expect(a.sig).toMatch(/^[0-9a-f]{16}$/);
  });
  it('differ when an argument differs, and never hold the arguments', () => {
    const a = sigOf('accessibility', { action: 'set_value', name: 'Email', value: 'grace@example.com' });
    const b = sigOf('accessibility', { action: 'set_value', name: 'Name', value: 'Grace Hopper' });
    expect(a.sig).not.toBe(b.sig);
    expect(JSON.stringify(a)).not.toContain('grace');
  });
});

describe('claude-code', () => {
  const cmd = claudeCommand({ exe: '/bin/claude', model: 'haiku', mcpConfigPath: '/tmp/run/mcp.json', prompt: 'Do the task.' });

  it('runs print mode with the model, with the prompt on stdin', () => {
    expect(cmd.cmd).toBe('/bin/claude');
    expect(cmd.args[0]).toBe('-p');
    expect(cmd.args.slice(1, 3)).toEqual(['--model', 'haiku']);
    expect(cmd.stdin).toBe('Do the task.');
    expect(cmd.args).not.toContain('Do the task.');
  });

  it('connects only the isolated server and allows only its tools', () => {
    const a = cmd.args;
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/tmp/run/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__clawdcursor__*');
    expect(a[a.indexOf('--tools') + 1]).toBe('');   // no built-in tool
    expect(a).not.toContain('--dangerously-skip-permissions');
  });

  it('loads none of the owner\'s settings: no user hooks, plugins or CLAUDE.md', () => {
    expect(cmd.args[cmd.args.indexOf('--setting-sources') + 1]).toBe('project');
  });

  it('asks for one JSON line per message', () => {
    expect(cmd.args[cmd.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(cmd.args).toContain('--verbose');
  });

  it('points the MCP config at the isolated server, with its token', () => {
    expect(JSON.parse(claudeMcpConfig('http://127.0.0.1:4567/mcp', 'tok'))).toEqual({
      mcpServers: { clawdcursor: { type: 'http', url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer tok' } } } });
  });

  it('reads tool calls and the final reply from the stream', () => {
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Reading the page.' },
      { type: 'tool_use', id: 't1', name: 'mcp__clawdcursor__accessibility', input: { action: 'read_tree' } },
      { type: 'tool_use', id: 't2', name: 'mcp__clawdcursor__computer', input: { action: 'click', x: 1, y: 2 } },
    ] } });
    expect(parseClaudeLine(assistant).sigs).toEqual([sigOf('accessibility', { action: 'read_tree' }), sigOf('computer', { action: 'click', x: 1, y: 2 })]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.\nBENCH_RESULT: DONE' })))
      .toEqual({ sigs: [], finalText: 'Done.\nBENCH_RESULT: DONE' });
    expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toEqual({ sigs: [], finalText: '' });
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }))).toEqual({ sigs: [] });
    expect(parseClaudeLine('not json')).toEqual({ sigs: [] });
  });
});

describe('choosing models', () => {
  it('reads adapter:model pairs; the model may itself contain a colon', () => {
    const fake = [{ ...ADAPTERS[0], id: 'claude-code' }, { ...ADAPTERS[0], id: 'ollama', defaultModels: ['qwen2.5:7b'] }];
    expect(parseModels('claude-code:sonnet, ollama:qwen2.5:7b', fake).map(r => r.label)).toEqual(['claude-code:sonnet', 'ollama:qwen2.5:7b']);
    expect(parseModels('ollama', fake).map(r => r.model)).toEqual(['qwen2.5:7b']);
    expect(parseModels('claude-code', fake).map(r => r.model)).toEqual(['sonnet', 'haiku']);
  });
  it('rejects an unknown agent', () => {
    expect(() => parseModels('gemini:pro')).toThrow(/unknown agent "gemini"/);
  });
});

describe('codex', () => {
  const cmd = codexCommand({ exe: '/bin/codex', model: CODEX_DEFAULT, mcpUrl: 'http://127.0.0.1:4567/mcp', token: 'secret-123', workDir: '/tmp/run',
    lastMessagePath: '/tmp/run/last-message.txt', prompt: 'Do the task.' });
  const flag = (name: string) => cmd.args[cmd.args.indexOf(name) + 1];
  const configs = cmd.args.filter((_, i) => cmd.args[i - 1] === '-c');

  it('runs exec with JSON events and the prompt on stdin', () => {
    expect(cmd.args[0]).toBe('exec');
    expect(cmd.args).toContain('--json');
    expect(cmd.args[cmd.args.length - 1]).toBe('-');
    expect(cmd.stdin).toBe('Do the task.');
    expect(flag('--cd')).toBe('/tmp/run');
    expect(flag('--output-last-message')).toBe('/tmp/run/last-message.txt');
  });

  it('configures only the isolated server, as TOML strings', () => {
    expect(configs).toContain('mcp_servers.clawdcursor.url="http://127.0.0.1:4567/mcp"');
    expect(configs).toContain(`mcp_servers.clawdcursor.bearer_token_env_var="${TOKEN_ENV}"`);
    expect(configs).toContain('mcp_servers.clawdcursor.default_tools_approval_mode="approve"');
    expect(configs).toContain('approval_policy="never"');
    expect(configs).toContain('project_doc_max_bytes=0');   // no AGENTS.md
  });

  it('keeps the token out of the command line: it travels in the environment', () => {
    expect(cmd.args.join(' ')).not.toContain('secret-123');
    expect(cmd.env).toEqual({ [TOKEN_ENV]: 'secret-123' });
  });

  it('loads nothing of the owner: no config.toml, no plugins, no shell, no sandbox bypass', () => {
    expect(cmd.args).toContain('--ignore-user-config');
    const disabled = cmd.args.filter((_, i) => cmd.args[i - 1] === '--disable');
    expect(disabled).toEqual(['plugins', 'shell_tool']);
    expect(flag('--sandbox')).toBe('read-only');
    expect(cmd.args.join(' ')).not.toContain('dangerously');
  });

  it('names the model only when one is asked for', () => {
    expect(cmd.args).not.toContain('--model');
    const named = codexCommand({ exe: 'codex', model: 'gpt-5.5', mcpUrl: 'u', token: 't', workDir: 'w', lastMessagePath: 'l', prompt: 'p' });
    expect(named.args[named.args.indexOf('--model') + 1]).toBe('gpt-5.5');
  });

  it('reads tool calls (once per item) and the final message from the events', () => {
    const started = JSON.stringify({ type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'clawdcursor', tool: 'accessibility', arguments: { action: 'read_tree' } } });
    const p = parseCodexLine(started);
    expect(p).toEqual({ sig: sigOf('accessibility', { action: 'read_tree' }), id: 'item_3' });
    // The same item again when it completes, with its arguments as JSON text: the same signature and id.
    const done = JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', tool: 'accessibility', arguments: '{"action":"read_tree"}' } });
    expect(parseCodexLine(done)).toEqual(p);
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: 'BENCH_RESULT: DONE' } })))
      .toEqual({ finalText: 'BENCH_RESULT: DONE' });
    expect(parseCodexLine(JSON.stringify({ type: 'turn.completed', usage: {} }))).toEqual({});
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'ls' } }))).toEqual({});
    expect(parseCodexLine('garbage')).toEqual({});
  });
});

describe('ollama', () => {
  const mcpTools = [{ name: 'accessibility', description: 'Read and act on UI elements', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
    { name: 'computer', inputSchema: { type: 'object' } }];

  it('offers the MCP tools as functions with their own schemas', () => {
    expect(toOllamaTools(mcpTools)).toEqual([
      { type: 'function', function: { name: 'accessibility', description: 'Read and act on UI elements', parameters: mcpTools[0].inputSchema } },
      { type: 'function', function: { name: 'computer', description: '', parameters: { type: 'object' } } },
    ]);
  });

  it('asks the local server, without streaming, at temperature 0', () => {
    const { url, body } = chatRequest('qwen2.5:7b', [{ role: 'user', content: 'hi' }], toOllamaTools(mcpTools));
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body).toMatchObject({ model: 'qwen2.5:7b', stream: false, options: { temperature: 0 } });
    expect((body.tools as unknown[]).length).toBe(2);
  });

  it('turns a tool result into text: images left out, errors marked, long text cut', () => {
    expect(resultText({ content: [{ type: 'text', text: 'Pressed "New".' }, { type: 'image', data: 'AAAA' }] }))
      .toBe('Pressed "New".\n[an image was returned; it is not shown to this model]');
    expect(resultText({ content: [{ type: 'text', text: 'no element named "Nwe"' }], isError: true })).toBe('ERROR: no element named "Nwe"');
    const long = resultText({ content: [{ type: 'text', text: 'x'.repeat(RESULT_CHARS + 50) }] });
    expect(long.length).toBeLessThan(RESULT_CHARS + 60);
    expect(long).toMatch(/\[cut: 50 more characters\]$/);
    expect(resultText({})).toBe('');
  });

  it('reads arguments given as an object or as JSON text', () => {
    expect(argsOf({ action: 'invoke' })).toEqual({ action: 'invoke' });
    expect(argsOf('{"action":"invoke"}')).toEqual({ action: 'invoke' });
    expect(argsOf('not json')).toEqual({});
    expect(argsOf(undefined)).toEqual({});
  });

  describe('the loop', () => {
    const say = (content: string): OllamaMessage => ({ role: 'assistant', content });
    const ask = (name: string, args: unknown): OllamaMessage => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
    function deps(replies: OllamaMessage[], signal = new AbortController().signal) {
      const seen: OllamaMessage[][] = [];
      const called: Array<[string, unknown]> = [];
      const sigs: string[] = [];
      return { seen, called, sigs, d: {
        signal, onSig: (s: { tool: string }) => { sigs.push(s.tool); },
        chat: async (m: OllamaMessage[]) => { seen.push([...m]); return replies.shift() ?? say('out of replies'); },
        callTool: async (name: string, args: Record<string, unknown>): Promise<{ content?: unknown; isError?: unknown }> => {
          called.push([name, args]);
          return { content: [{ type: 'text', text: `${name} ok` }] };
        },
      } };
    }

    it('runs the calls the model asks for, feeds the results back, and returns its final text', async () => {
      const t = deps([ask('accessibility', { action: 'read_tree' }), ask('accessibility', '{"action":"invoke","name":"New"}'), say('Done.\nBENCH_RESULT: DONE')]);
      const final = await runLoop('Press New.', ['accessibility', 'computer'], t.d);
      expect(final).toBe('Done.\nBENCH_RESULT: DONE');
      expect(t.called).toEqual([['accessibility', { action: 'read_tree' }], ['accessibility', { action: 'invoke', name: 'New' }]]);
      expect(t.sigs).toEqual(['accessibility', 'accessibility']);
      // The third request carries the whole conversation: system, user, call, result, call, result.
      expect(t.seen[2].map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
      expect(t.seen[2][1].content).toBe('Press New.');
      expect(t.seen[2][3]).toEqual({ role: 'tool', tool_name: 'accessibility', content: 'accessibility ok' });
    });

    it('tells the model when it names a tool that does not exist, without calling anything', async () => {
      const t = deps([ask('click_button', {}), say('Stopped.')]);
      expect(await runLoop('x', ['accessibility'], t.d)).toBe('Stopped.');
      expect(t.called).toEqual([]);
      expect(t.seen[1][3].content).toMatch(/no tool named "click_button".*accessibility/);
    });

    it('reports a failed call to the model and goes on', async () => {
      const t = deps([ask('computer', {}), say('Gave up.')]);
      t.d.callTool = async () => { throw new Error('connection closed'); };
      expect(await runLoop('x', ['computer'], t.d)).toBe('Gave up.');
      expect(t.seen[1][3].content).toBe('ERROR: connection closed');
    });

    it('stops when the watchdog aborts, and after the turn limit', async () => {
      const stopped = new AbortController();
      const t = deps([ask('computer', {}), ask('computer', {})], stopped.signal);
      t.d.callTool = async () => { stopped.abort(); return { content: [] }; };
      expect(await runLoop('x', ['computer'], t.d)).toBe('');
      expect(t.seen).toHaveLength(1);

      const forever = deps(Array.from({ length: MAX_TURNS + 5 }, () => ask('computer', {})));
      expect(await runLoop('x', ['computer'], forever.d)).toBe('');
      expect(forever.called).toHaveLength(MAX_TURNS);
    });
  });
});

describe('the adapters', () => {
  it('are claude-code, codex and ollama', () => {
    expect(ADAPTERS.map(a => a.id)).toEqual(['claude-code', 'codex', 'ollama']);
  });

  it('say whether their model is shown images: the Ollama loop leaves them out', () => {
    expect(ADAPTERS.map(a => a.seesImages)).toEqual([true, true, false]);
  });
});

describe('finding the native binary of an agent host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-agent-bin-test-'));
  const shim = path.join(dir, 'claude.cmd');
  const exe = path.join(dir, 'native', 'claude.exe');
  fs.writeFileSync(shim, '@echo off');
  fs.mkdirSync(path.dirname(exe));
  fs.writeFileSync(exe, '');
  const win = { env: { PATH: dir }, platform: 'win32' };

  it('only an npm .cmd shim on PATH: says so, names it, and says what to do', () => {
    clearAgentBins();
    expect(locateAgent('claude', '--claude-bin', win)).toEqual({ why:
      `found only an npm .cmd shim at ${shim}; the benchmark needs the native binary (claude.exe): install it from the vendor, or pass --claude-bin` });
    expect(locateAgent('codex', '--codex-bin', { ...win, fallback: () => null })).toEqual({ why: 'not installed' });
  });

  it('a real executable on PATH wins over a shim beside it, and a fallback is used when PATH has none', () => {
    clearAgentBins();
    expect(locateAgent('claude', '--claude-bin', { env: { PATH: `${dir};${path.dirname(exe)}` }, platform: 'win32' })).toEqual({ exe });
    expect(locateAgent('codex', '--codex-bin', { ...win, fallback: () => 'C:\\app\\codex.exe' })).toEqual({ exe: 'C:\\app\\codex.exe' });
  });

  it('--claude-bin / --codex-bin name the binary, and it is used before PATH', () => {
    expect(parseArgs(['--claude-bin', exe, '--codex-bin', 'x.exe'])).toMatchObject({ claudeBin: exe, codexBin: 'x.exe' });
    setAgentBin('claude', exe, 'win32');
    expect(locateAgent('claude', '--claude-bin', win)).toEqual({ exe });
    clearAgentBins();
    expect('why' in locateAgent('claude', '--claude-bin', win)).toBe(true);
  });

  it('only a path to an .exe is accepted on Windows: a shim, a script or a missing file is refused', () => {
    expect(() => setAgentBin('claude', shim, 'win32')).toThrow(/not a native binary.*claude\.exe/);
    expect(() => setAgentBin('claude', path.join(dir, 'claude.ps1'), 'win32')).toThrow(/not a native binary/);
    expect(() => setAgentBin('claude', path.join(dir, 'claude'), 'win32')).toThrow(/not a native binary/);
    expect(() => setAgentBin('claude', path.join(dir, 'missing.exe'), 'win32')).toThrow(/is not a file/);
    expect(() => setAgentBin('claude', path.dirname(exe) + '.exe', 'win32')).toThrow(/is not a file/);
    expect(() => setAgentBin('codex', path.join(dir, 'codex.sh'), 'linux')).toThrow(/not a native binary/);
    clearAgentBins();
    expect('why' in locateAgent('claude', '--claude-bin', win)).toBe(true);   // a refused path is not kept
  });

  it('the adapters report the reason, not just "not installed"', () => {
    for (const a of ADAPTERS.filter(x => x.id !== 'ollama')) expect(typeof a.why).toBe('function');
  });
});

describe('the preflight: can each agent run at all, before anything opens on the desktop', () => {
  it('claude-code: a trivial prompt, no MCP server, no tool, none of the owner\'s settings', () => {
    const c = claudePreflightCommand({ exe: '/bin/claude', model: 'sonnet' });
    expect(c.stdin).toBe(PREFLIGHT_PROMPT);
    expect(c.args).toContain('--strict-mcp-config');
    expect(c.args).not.toContain('--mcp-config');
    expect(c.args).not.toContain('--allowedTools');
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(c.args[c.args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('claude-code: reads the one result line', () => {
    expect(parseClaudePreflight('{"type":"result","subtype":"success","is_error":false,"result":"OK"}\n')).toEqual({ ok: true, said: 'OK' });
    expect(parseClaudePreflight('{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}\n'))
      .toEqual({ ok: false, said: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
    expect(parseClaudePreflight('some crash output')).toEqual({ ok: false, said: 'some crash output' });
  });

  it('codex: a trivial prompt, no MCP server, no plugins, no shell', () => {
    const c = codexPreflightCommand({ exe: 'codex', model: CODEX_DEFAULT, workDir: '/w', lastMessagePath: '/w/last.txt' });
    expect(c.stdin).toBe(PREFLIGHT_PROMPT);
    expect(c.args.join(' ')).not.toContain('mcp_servers');
    expect(c.args).toContain('--ignore-user-config');
    expect(c.args.filter((_, i) => c.args[i - 1] === '--disable')).toEqual(['plugins', 'shell_tool']);
    expect(c.env).toBeUndefined();
  });

  it('an expired login is told apart from a host that did not start, with what to do', () => {
    expect(preflightFailure('claude-code', 'claude', 1, 'Failed to authenticate: OAuth session expired and could not be refreshed'))
      .toBe('claude-code is not signed in: run `claude` and log in. (Failed to authenticate: OAuth session expired and could not be refreshed)');
    expect(preflightFailure('codex', 'codex login', 1, 'ERROR: 401 Unauthorized')).toMatch(/^codex is not signed in: run `codex login` and log in\./);
    expect(preflightFailure('codex', 'codex login', 2, 'error: unexpected argument')).toBe('codex did not answer a trivial prompt (exit code 2): error: unexpected argument');
    expect(preflightFailure('claude-code', 'claude', null, '')).toMatch(/no output$/);
  });

  const fake = (id: string, answer: string | null | Error): Adapter => ({ ...ADAPTERS[0], id,
    preflight: async () => { if (answer instanceof Error) throw answer; return answer; } });

  it('every model is checked; the ones that cannot run are listed, each with its reason', async () => {
    const runs = [
      { adapter: fake('claude-code', 'claude-code is not signed in: run `claude` and log in.'), model: 'sonnet', label: 'claude-code:sonnet' },
      { adapter: fake('codex', null), model: 'default', label: 'codex:default' },
      { adapter: fake('ollama', new Error('connect ECONNREFUSED')), model: 'qwen2.5:7b', label: 'ollama:qwen2.5:7b' },
    ];
    const dirs: string[] = [];
    const failures = await preflightAll(runs, label => { dirs.push(label); return os.tmpdir(); }, new AbortController().signal);
    expect(failures).toEqual(['claude-code:sonnet: claude-code is not signed in: run `claude` and log in.', 'ollama:qwen2.5:7b: ollama failed to start: connect ECONNREFUSED']);
    expect(dirs).toEqual(['claude-code:sonnet', 'codex:default', 'ollama:qwen2.5:7b']);
  });

  it('all agents answer: nothing to report', async () => {
    expect(await preflightAll([{ adapter: fake('codex', null), model: 'default', label: 'codex:default' }], () => os.tmpdir(), new AbortController().signal)).toEqual([]);
  });

  it('every adapter has one', () => {
    for (const a of ADAPTERS) expect(typeof a.preflight, a.id).toBe('function');
  });
});

describe('an adapter that cannot reach clawdcursor says so: it is the server\'s failure', () => {
  const init = (servers: unknown) => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: servers });

  it('claude-code: the init line lists the MCP server as anything but connected', () => {
    expect(parseClaudeLine(init([{ name: 'clawdcursor', status: 'connected' }]))).toEqual({ sigs: [] });
    expect(parseClaudeLine(init([{ name: 'clawdcursor', status: 'failed' }]))).toEqual({ sigs: [], serverUnreachable: 'Claude Code reports the clawdcursor MCP server as "failed"' });
    expect(parseClaudeLine(init([{ name: 'clawdcursor', status: 'needs-auth' }])).serverUnreachable).toMatch(/"needs-auth"/);
    expect(parseClaudeLine(init([{ name: 'clawdcursor' }])).serverUnreachable).toMatch(/"unknown"/);
    expect(parseClaudeLine(init([])).serverUnreachable).toBe('Claude Code started without the clawdcursor MCP server');
    expect(parseClaudeLine(init([{ name: 'other', status: 'connected' }])).serverUnreachable).toMatch(/without the clawdcursor MCP server/);
    // An init line with no server list (another version) says nothing either way.
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({ sigs: [] });
  });

  it('codex: an MCP failure that names the server, on stdout or stderr', () => {
    expect(codexServerFailure('ERROR: MCP client for `clawdcursor` failed to start: connection refused')).toMatch(/^Codex could not reach the clawdcursor MCP server: ERROR: MCP client/);
    expect(codexServerFailure('{"type":"error","message":"mcp server clawdcursor timed out during initialize"}')).not.toBeNull();
    expect(codexServerFailure('mcp: clawdcursor ready (6 tools)')).toBeNull();
    expect(codexServerFailure('ERROR: 401 Unauthorized')).toBeNull();                       // the agent's own login
    expect(codexServerFailure('MCP client for `other` failed to start')).toBeNull();
  });

  it('ollama: a failed MCP connection is reported, not thrown (a throw would read as an agent error)', async () => {
    const closed = http.createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise(r => closed.close(r));
    const result = await ollama.run({ prompt: 'x', model: 'qwen2.5:7b', mcpUrl: `http://127.0.0.1:${port}/mcp`, token: 't', workDir: os.tmpdir(), logFile: '',
      onSig: () => {}, signal: new AbortController().signal });
    expect(result.serverUnreachable).toMatch(/^the MCP connection failed: /);
    expect(result.finalText).toBe('');
  });

  describe('the runner\'s own check, for any adapter', () => {
    const serve = async (handler: http.RequestListener) => {
      const server = http.createServer(handler);
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
    };

    it('nothing listening: the handshake failed', async () => {
      const s = await serve(() => {});
      await s.close();
      expect(await probeMcp(s.url, 't', 3000)).toMatch(/^the MCP handshake failed: /);
    });

    it('a server that answers 500 to initialize: the handshake failed', async () => {
      const s = await serve((_req, res) => { res.writeHead(500); res.end('boom'); });
      try { expect(await probeMcp(s.url, 't', 3000)).toMatch(/^the MCP handshake failed: /); } finally { await s.close(); }
    });

    it('a server that initializes but lists no tools: tools/list is missing the six', async () => {
      const s = await serve((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
          if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
          const result = msg.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'broken', version: '0' } }
            : { tools: [{ name: 'accessibility', inputSchema: { type: 'object' } }] };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        });
      });
      try { expect(await probeMcp(s.url, 't', 3000)).toBe('tools/list is missing system, window, browser, computer, batch'); } finally { await s.close(); }
    });
  });
});
