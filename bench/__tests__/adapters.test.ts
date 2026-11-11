import { describe, it, expect } from 'vitest';
import { claudeCommand, claudeMcpConfig, parseClaudeLine } from '../lib/adapters/claude-code';
import { sigOf } from '../lib/adapters/common';
import { ADAPTERS, parseModels } from '../lib/adapters';

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
