import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TraceEvent } from '../src/trace';

const sdk = vi.hoisted(() => ({ requests: [] as any[], replies: [] as any[] }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async listTools() { return { tools: [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }] }; }
    getInstructions() { return 'server rules'; }
    async callTool() { return { content: [{ type: 'text', text: 'done' }] }; }
    async close() {}
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { beta = { messages: { create: async (p: any) => { sdk.requests.push(JSON.parse(JSON.stringify(p))); return sdk.replies.shift(); } } }; },
}));

import { ANTHROPIC_DEFAULT_MODEL, runApi } from '../src/api';
import { runTask } from '../src/task';
import { readRun } from '../src/runlog';

const entry = { command: 'x', args: [], env: {} };
const usage = (n: number) => ({ input_tokens: n, output_tokens: 2 * n, cache_read_input_tokens: 3 * n, cache_creation_input_tokens: 4 * n });

describe('the Anthropic API runner', () => {
  beforeEach(() => { sdk.requests = []; sdk.replies = []; });

  it('defaults to Haiku 5.5', () => { expect(ANTHROPIC_DEFAULT_MODEL).toBe('claude-haiku-5-5'); });

  it('puts cache_control on the system prompt, the last tool and the newest message each turn, and reports usage per response', async () => {
    sdk.replies = [
      { stop_reason: 'tool_use', usage: usage(1), content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { stop_reason: 'end_turn', usage: usage(2), content: [{ type: 'text', text: 'PASS: ok' }] },
    ];
    const events: TraceEvent[] = [];
    const r = await runApi({ kind: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'k', entry, task: 'do it', emit: e => events.push(e), signal: new AbortController().signal });
    expect(r.text).toBe('PASS: ok');
    expect(events.filter(e => e.kind === 'usage')).toEqual([
      { kind: 'usage', in: 1, out: 2, cacheRead: 3, cacheWrite: 4 }, { kind: 'usage', in: 2, out: 4, cacheRead: 6, cacheWrite: 8 }]);

    const [first, second] = sdk.requests;
    const eph = { type: 'ephemeral' };
    for (const req of [first, second]) {
      expect(req.system).toEqual([expect.objectContaining({ type: 'text', cache_control: eph })]);
      expect(req.tools.map((t: any) => t.cache_control)).toEqual([undefined, eph]);   // the last tool only
    }
    // turn 1: the task, as a block carrying the breakpoint
    expect(first.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'do it', cache_control: eph }] }]);
    // turn 2: only the newest message (the tool results) carries one; the earlier ones do not
    expect(second.messages).toHaveLength(3);
    expect(JSON.stringify(second.messages.slice(0, 2))).not.toContain('cache_control');
    expect(second.messages[2].content.at(-1).cache_control).toEqual(eph);
    expect(JSON.stringify(second).match(/cache_control/g)).toHaveLength(3);   // system, last tool, newest message
  });
});

describe('the OpenAI-compatible runner', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reports usage from each response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'PASS' } }],
      usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 60 } } })));
    const events: TraceEvent[] = [];
    await runApi({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1', entry, task: 't', emit: e => events.push(e), signal: new AbortController().signal });
    expect(events.filter(e => e.kind === 'usage')).toEqual([{ kind: 'usage', in: 40, out: 9, cacheRead: 60 }]);
  });
});

describe('runTask: totals', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-')); process.env.ANTHROPIC_API_KEY = 'k'; sdk.requests = []; });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const run = async (replies: any[]) => {
    sdk.replies = replies;
    const lines: string[] = [];
    const res = await runTask({ task: 't', with: 'anthropic' }, { coreVersion: '0', coreEntry: 'x', node: 'node', dataDir: dir }, { out: l => lines.push(l), color: false });
    return { lines, end: readRun(res.runFile!).find(r => r.type === 'end')! };
  };

  it('sums the usage of the run into the end record and prints one line', async () => {
    const { lines, end } = await run([
      { stop_reason: 'tool_use', usage: usage(1), content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { stop_reason: 'end_turn', usage: usage(2), content: [{ type: 'text', text: 'PASS: ok' }] },
    ]);
    expect(end.usage).toEqual({ in: 3, out: 6, cacheRead: 9, cacheWrite: 12 });
    const at = lines.findIndex(l => l.startsWith('run log '));
    expect(lines[at + 1]).toBe('tokens: 3 in · 6 out · 9 cached');
  });

  it('prints no tokens line and writes no usage when none was seen', async () => {
    const { lines, end } = await run([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'FAIL: no' }] }]);
    expect(end.usage).toBeUndefined();
    expect(lines.some(l => l.startsWith('tokens:'))).toBe(false);
  });
});
