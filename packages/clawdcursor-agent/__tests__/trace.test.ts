import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { claudeEvents, codexEvents, paint, renderEvent, shortResult, verdictOf, type TraceEvent } from '../src/trace';
import { withoutImages } from '../src/runlog';

/** Lines recorded from a real `clawdcursor task` run (the system_time test), trimmed to the fields that matter. */
const lines = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean);

describe('Claude Code stream-json -> trace', () => {
  const events = lines('claude-stream.jsonl').flatMap(claudeEvents);

  it('reads the session start, the call, its result and the final message, in order', () => {
    expect(events.map(e => e.kind)).toEqual(['start', 'call', 'result', 'text', 'final']);
    expect(events[0]).toEqual({ kind: 'start', model: 'claude-opus-5-5', server: 'connected', tools: 6 });
    expect(events[1]).toMatchObject({ kind: 'call', tool: 'system', action: 'system_time', args: '' });
    expect(events[2]).toMatchObject({ kind: 'result', ok: true });
    expect((events[2] as Extract<TraceEvent, { kind: 'result' }>).text).toContain('"iso":"2026-11-15T07:00:47.984Z"');
    expect(verdictOf((events[4] as Extract<TraceEvent, { kind: 'final' }>).text)).toBe('PASS');
  });

  it('a server that did not connect shows as such', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'm', tools: [], mcp_servers: [{ name: 'clawdcursor', status: 'failed' }] });
    expect(claudeEvents(init)).toEqual([{ kind: 'start', model: 'm', server: 'failed', tools: 0 }]);
    expect(claudeEvents(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }))[0]).toMatchObject({ server: 'not configured' });
  });

  it('a failed call and an error result', () => {
    expect(claudeEvents(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] } })))
      .toEqual([{ kind: 'result', id: 't', ok: false, text: 'boom' }]);
    expect(claudeEvents(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toEqual([{ kind: 'final', text: '', error: true }]);
    expect(claudeEvents('not json')).toEqual([]);
  });
});

describe('Codex --json -> trace', () => {
  const events = lines('codex-stream.jsonl').flatMap(codexEvents);

  it('reads the messages and the call once with its result', () => {
    expect(events.map(e => e.kind)).toEqual(['text', 'call', 'result', 'text']);
    expect(events[1]).toEqual({ kind: 'call', id: 'item_1', tool: 'system', action: 'system_time', args: '' });
    expect(events[2]).toMatchObject({ kind: 'result', id: 'item_1', ok: true });
    expect(verdictOf((events[3] as Extract<TraceEvent, { kind: 'text' }>).text)).toBe('PASS');
  });

  it('a failed call, a failed turn and an error event', () => {
    const failed = JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'mcp_tool_call', tool: 'computer', arguments: '{"action":"click"}', result: null, error: { message: 'timed out' }, status: 'failed' } });
    expect(codexEvents(failed)).toEqual([{ kind: 'result', id: 'i', ok: false, text: 'timed out' }]);
    expect(codexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } }))).toEqual([{ kind: 'error', text: 'usage limit' }]);
    expect(codexEvents(JSON.stringify({ type: 'error', message: 'stream lost' }))).toEqual([{ kind: 'error', text: 'stream lost' }]);
  });
});

describe('the verdict', () => {
  it('is the last PASS or FAIL line, formatting allowed', () => {
    expect(verdictOf('Done.\nPASS: opened it')).toBe('PASS');
    expect(verdictOf('**FAIL**: the window never opened')).toBe('FAIL');
    expect(verdictOf('> Verdict: pass')).toBe('PASS');
    expect(verdictOf('PASS: step one\nFAIL: then it broke')).toBe('FAIL');
    expect(verdictOf('I could not decide.')).toBeNull();
    expect(verdictOf('PASSWORD field found')).toBeNull();
  });
});

describe('trace lines', () => {
  const p = paint(false);
  it('show the tool, its action, short arguments and a one-line result with clawdcursor\'s status line', () => {
    expect(renderEvent({ kind: 'call', tool: 'accessibility', action: 'invoke', args: '{"name":"Save"}' }, p)).toBe('→ accessibility invoke {"name":"Save"}');
    expect(shortResult('Clicked "Save".\nsome detail\n[confirmed]')).toBe('Clicked "Save".  [confirmed]');
    expect(shortResult('', 1)).toBe('[1 image]');
    expect(renderEvent({ kind: 'result', ok: false, text: 'no element named Save\n[failed · NOT_FOUND · try find]' }, p))
      .toBe('  ← error  no element named Save  [failed · NOT_FOUND · try find]');
    expect(renderEvent({ kind: 'text', text: 'Looking\nfor it' }, p, 'claude')).toBe('claude: Looking for it');
  });
});

describe('the run log', () => {
  it('keeps an image\'s type and size, not its data', () => {
    const data = 'A'.repeat(4000);
    expect(withoutImages({ content: [{ type: 'text', text: 'x' }, { type: 'image', data, mimeType: 'image/png' }, { type: 'image', source: { type: 'base64', data } }] }))
      .toEqual({ content: [{ type: 'text', text: 'x' }, { type: 'image', bytes: 3000 }, { type: 'image', bytes: 3000 }] });
  });
});
