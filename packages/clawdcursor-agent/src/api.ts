/**
 * The optional API runners: a small tool-calling loop over clawdcursor's own MCP server (stdio, through the MCP SDK
 * client), for `--with anthropic` (Anthropic API key) and `--with openai-compatible` (any /chat/completions endpoint:
 * OpenAI, Ollama, LM Studio, OpenRouter). The subscription runners (claude, codex) do not use this file.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { McpEntry } from './runners';
import { SYSTEM_PROMPT } from './runners';
import { callOf, resultOf, type TraceEvent } from './trace';

export const MAX_TURNS = 50;
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
/** Models that take server-side fallbacks on a refusal (the API routes the request to another model by itself). */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface ApiJob {
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  entry: McpEntry;
  task: string;
  emit(ev: TraceEvent): void;
  signal: AbortSignal;
}

interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
interface McpContent { type: string; text?: string; data?: string; mimeType?: string }

/** Start clawdcursor's MCP server and connect to it. */
async function connect(entry: McpEntry) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...env, ...entry.env }, stderr: 'ignore' });
  const client = new Client({ name: 'clawdcursor-task', version: '1' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools: tools as McpTool[], instructions: client.getInstructions() ?? '' };
}

/** Run the loop; resolves with the final message text (or an error event and an empty text). */
export async function runApi(job: ApiJob): Promise<{ text: string; error?: string }> {
  const { client, tools, instructions } = await connect(job.entry);
  const system = instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT;
  job.emit({ kind: 'start', model: job.model, server: 'connected', tools: tools.length });
  const call = async (name: string, args: Record<string, unknown>, id: string) => {
    job.emit(callOf(name, args, id));
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { signal: job.signal, timeout: 900_000 });
      const content = (r.content ?? []) as McpContent[];
      job.emit(resultOf(content, r.isError !== true, id));
      return { content, isError: r.isError === true };
    } catch (e) {
      const text = (e as Error).message;
      job.emit({ kind: 'result', id, ok: false, text });
      return { content: [{ type: 'text', text }] as McpContent[], isError: true };
    }
  };
  try {
    return job.kind === 'anthropic' ? await anthropicLoop(job, system, tools, call) : await openaiLoop(job, system, tools, call);
  } finally {
    await client.close().catch(() => { /* the server is gone already */ });
  }
}

type Call = (name: string, args: Record<string, unknown>, id: string) => Promise<{ content: McpContent[]; isError: boolean }>;

async function anthropicLoop(job: ApiJob, system: string, tools: McpTool[], call: Call): Promise<{ text: string; error?: string }> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const api = new AnthropicClient({ apiKey: job.apiKey });
  const defs = tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: job.task }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await api.beta.messages.create({
      model: job.model, max_tokens: 16000, system, tools: defs, messages,
      ...(FALLBACK_MODELS.has(job.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal: job.signal });
    if (r.stop_reason === 'refusal') return { text: '', error: 'the model declined the request (stop_reason: refusal)' };
    messages.push({ role: 'assistant', content: r.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = r.content.filter(b => b.type === 'text').map(b => (b as Anthropic.Beta.BetaTextBlock).text).join('\n');
    if (text.trim()) job.emit({ kind: 'text', text });
    const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!uses.length) return { text };
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const out = await call(u.name, (u.input ?? {}) as Record<string, unknown>, u.id);
      const content = out.content.flatMap((c): Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> =>
        c.type === 'text' ? [{ type: 'text', text: c.text ?? '' }]
          : c.type === 'image' && c.data ? [{ type: 'image', source: { type: 'base64', media_type: (c.mimeType ?? 'image/png') as 'image/png', data: c.data } }]
            : []);
      results.push({ type: 'tool_result', tool_use_id: u.id, is_error: out.isError, content });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: '', error: `stopped after ${MAX_TURNS} turns` };
}

interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string }

/** /chat/completions with tools. Tool messages carry text only; a result's images follow in one user message. */
async function openaiLoop(job: ApiJob, system: string, tools: McpTool[], call: Call): Promise<{ text: string; error?: string }> {
  const url = `${(job.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const defs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } }));
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: job.task }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(url, {
      method: 'POST', signal: job.signal,
      headers: { 'Content-Type': 'application/json', ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}) },
      body: JSON.stringify({ model: job.model, messages, tools: defs }),
    });
    if (!res.ok) return { text: '', error: `${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const msg = ((await res.json()) as { choices?: Array<{ message?: ChatMessage }> }).choices?.[0]?.message;
    if (!msg) return { text: '', error: `${url} returned no message` };
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text.trim()) job.emit({ kind: 'text', text });
    if (!msg.tool_calls?.length) return { text };
    const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* the model sent bad JSON: call with none */ }
      const out = await call(tc.function.name, args, tc.id);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || '(no text)' });
      for (const c of out.content) if (c.type === 'image' && c.data) images.push({ type: 'image_url', image_url: { url: `data:${c.mimeType ?? 'image/png'};base64,${c.data}` } });
    }
    if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'The images from those tool results:' }, ...images] });
  }
  return { text: '', error: `stopped after ${MAX_TURNS} turns` };
}
