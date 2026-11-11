import { describe, it, expect } from 'vitest';
import { claudeCommand, claudeMcpConfig, parseClaudeLine } from '../lib/adapters/claude-code';
import { sigOf } from '../lib/adapters/common';
import { ADAPTERS, parseModels } from '../lib/adapters';
import { CODEX_DEFAULT, TOKEN_ENV, codexCommand, parseCodexLine } from '../lib/adapters/codex';
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
});
