import { describe, it, expect } from 'vitest';
import { reasonOf } from '../src/task';
import { claudeEvents, codexEvents, type TraceEvent } from '../src/trace';

const base = { interrupted: false, claimed: null, verdict: null, runner: 'claude', finalText: '', finalError: false, lastError: '', toolCalls: 0,
  serverState: 'connected', exitCode: 1, stderrTail: '', ranCli: true } as const;

/** What runTask's show() keeps from a run's events. */
function kept(evs: TraceEvent[]) {
  const r = { serverState: undefined as string | undefined, finalText: '', finalError: false, lastError: '', toolCalls: 0 };
  for (const ev of evs) {
    if (ev.kind === 'start') r.serverState = ev.server;
    if (ev.kind === 'final') { r.finalText = ev.text; r.finalError = ev.error === true; }
    if (ev.kind === 'error') r.lastError = ev.text;
    if (ev.kind === 'call') r.toolCalls++;
  }
  return r;
}

describe('reasonOf: why a run has no PASS/FAIL', () => {
  it('a PASS from an agent whose server was still starting, with no tool call, is not a PASS', () => {
    // claude -p 2.1.322 against a stdio server that took 40 s to start (2026-11-15), reduced: init "pending", no tools,
    // no tool_use, and a made-up PASS. The Mac run of `clawdcursor task` the same day looked the same.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'clawdcursor', status: 'pending', source: 'dynamic' }] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PASS: Called the clawdcursor ping tool once; it returned pong.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PASS: Called the clawdcursor ping tool once; it returned pong.' }),
    ];
    const k = kept(lines.flatMap(claudeEvents));
    expect(k).toMatchObject({ serverState: 'pending', toolCalls: 0, finalError: false });
    expect(reasonOf({ ...base, ...k, claimed: 'PASS', verdict: null }))
      .toBe('the agent said PASS without calling a clawdcursor tool: the clawdcursor MCP server was still starting (pending)');
    expect(reasonOf({ ...base, claimed: 'PASS', verdict: null })).toBe('the agent said PASS without calling a clawdcursor tool');
  });

  it('an expired Claude Code sign-in (server still pending) says the 401 and how to sign in, not that the server failed', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'clawdcursor', status: 'pending' }] }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }),
    ];
    const reason = reasonOf({ ...base, ...kept(lines.flatMap(claudeEvents)) });
    expect(reason).toBe('claude ended with an error: Failed to authenticate. API Error: 401 OAuth access token is invalid. (sign in again: run `claude`, then /login)');
  });

  it('a Claude Code that is not signed in, or was handed a bad key, says how to sign in', () => {
    for (const result of ['Invalid API key · Fix external API key', 'Not logged in · Please run /login']) {
      const lines = [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result })];
      expect(reasonOf({ ...base, ...kept(lines.flatMap(claudeEvents)) })).toBe(`claude ended with an error: ${result} (sign in again: run \`claude\`, then /login)`);
    }
  });

  it('a codex failure (an error event, no last message) says the error, with its sign-in hint for a 401', () => {
    const k = kept([JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } })].flatMap(codexEvents));
    expect(reasonOf({ ...base, runner: 'codex', serverState: undefined, ...k }))
      .toBe('codex ended with an error: unexpected status 401 Unauthorized (sign in again: `codex login`)');
  });

  it('an API runner whose call threw says the error, without a CLI sign-in hint', () => {
    expect(reasonOf({ ...base, runner: 'anthropic', serverState: undefined, ranCli: false, lastError: '401 {"type":"authentication_error"}' }))
      .toBe('anthropic ended with an error: 401 {"type":"authentication_error"}');
  });

  it('the sign-in hint looks only at the error line it shows', () => {
    expect(reasonOf({ ...base, finalError: true, finalText: 'Tried the 401 page.\nRate limited' })).toBe('claude ended with an error: Rate limited');
  });

  it('a server that really failed is still blamed, even when the agent gave a verdict', () => {
    expect(reasonOf({ ...base, serverState: 'failed' })).toBe('the clawdcursor MCP server did not connect (failed)');
    expect(reasonOf({ ...base, serverState: 'failed', claimed: 'FAIL', verdict: 'FAIL', finalText: 'FAIL: no tools' }))
      .toBe('the clawdcursor MCP server did not connect (failed)');
  });

  it('a PASS with tool calls has no reason, even if init said pending; a silent exit reports its code and stderr', () => {
    expect(reasonOf({ ...base, serverState: 'pending', toolCalls: 3, claimed: 'PASS', verdict: 'PASS', finalText: 'PASS: done' })).toBeUndefined();
    expect(reasonOf({ ...base, serverState: 'pending', toolCalls: 1, exitCode: 2, stderrTail: 'boom\n' })).toBe('claude exited with code 2: boom');
    expect(reasonOf({ ...base, serverState: 'pending', exitCode: 2 }))
      .toBe('claude exited with code 2: the clawdcursor MCP server was still starting (pending)');
  });

  it('Ctrl-C wins; a reply with no verdict line says so', () => {
    expect(reasonOf({ ...base, interrupted: true, serverState: 'failed' })).toBe('stopped with Ctrl-C');
    expect(reasonOf({ ...base, toolCalls: 2, finalText: 'I opened TextEdit.' })).toBe('the agent gave no PASS/FAIL line');
    expect(reasonOf({ ...base, serverState: 'pending', finalText: 'I opened TextEdit.' }))
      .toBe('the agent called no clawdcursor tool: the clawdcursor MCP server was still starting (pending)');
  });
});
