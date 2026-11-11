/**
 * A local model through Ollama: a small function-calling loop over the isolated server's MCP tools.
 *
 * There is no agent host here, so this file is one: it lists the tools, sends them to /api/chat, runs the calls the
 * model asks for and feeds the results back until the model answers in text.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sigOf, type Adapter, type AgentJob, type AgentResult } from './common';
import type { CallSig } from '../types';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const MAX_TURNS = 60;
/** A tool result longer than this is cut: a small model's context is small. */
export const RESULT_CHARS = 6000;

export interface McpTool { name: string; description?: string; inputSchema: unknown }
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}
export interface OllamaTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export const SYSTEM = 'You control a desktop through tools. Call one tool at a time, read its result, and go on until the task is done. '
  + 'Read the accessibility tree before you act, and act on elements by name. When you are finished, answer in plain text.';

export function toOllamaTools(tools: McpTool[]): OllamaTool[] {
  return tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } }));
}

/** The /api/chat request: no streaming, temperature 0 for the least variation between runs. */
export function chatRequest(model: string, messages: OllamaMessage[], tools: OllamaTool[]): { url: string; body: Record<string, unknown> } {
  return { url: `${OLLAMA_URL}/api/chat`, body: { model, messages, tools, stream: false, options: { temperature: 0, num_ctx: 16384 } } };
}

/** An MCP tool result as text for the model. Images are left out: the result says so. */
export function resultText(result: { content?: unknown; isError?: unknown }): string {
  const blocks = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  const text = blocks.map(b => b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[an image was returned; it is not shown to this model]' : '').join('\n');
  const cut = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[cut: ${text.length - RESULT_CHARS} more characters]` : text;
  return result.isError ? `ERROR: ${cut}` : cut;
}

/** Tool arguments arrive as an object, or as JSON text from some models. */
export function argsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') { try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

export interface LoopDeps {
  chat(messages: OllamaMessage[]): Promise<OllamaMessage>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content?: unknown; isError?: unknown }>;
  onSig(s: CallSig): void;
  signal: AbortSignal;
}

/** The loop itself, with the model and the tools injected (the unit tests run it with fakes). */
export async function runLoop(prompt: string, toolNames: string[], d: LoopDeps): Promise<string> {
  const messages: OllamaMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  for (let turn = 0; turn < MAX_TURNS && !d.signal.aborted; turn++) {
    const reply = await d.chat(messages);
    messages.push(reply);
    const calls = reply.tool_calls ?? [];
    if (!calls.length) return reply.content ?? '';
    for (const c of calls) {
      if (d.signal.aborted) return '';
      const name = c.function.name;
      const args = argsOf(c.function.arguments);
      d.onSig(sigOf(name, args));
      let content: string;
      if (!toolNames.includes(name)) content = `ERROR: there is no tool named "${name}". The tools are: ${toolNames.join(', ')}.`;
      else {
        try { content = resultText(await d.callTool(name, args)); }
        catch (e) { content = `ERROR: ${(e as Error).message}`; }
      }
      messages.push({ role: 'tool', tool_name: name, content });
    }
  }
  return '';
}

async function installedModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const tags = await res.json() as { models?: Array<{ name: string; capabilities?: string[] }> };
  // Older servers do not list capabilities: every model is offered then.
  return (tags.models ?? []).filter(m => !m.capabilities || m.capabilities.includes('tools')).map(m => m.name);
}

export const ollama: Adapter = {
  id: 'ollama',
  defaultModels: ['qwen2.5:7b'],
  seesImages: false,   // resultText() leaves images out
  async detect() {
    try {
      const models = await installedModels();
      if (!models.length) return null;
      // The default is the model the plan names when it is there, else the first one that can call tools.
      this.defaultModels = [models.includes('qwen2.5:7b') ? 'qwen2.5:7b' : models[0]];
      return `local server at ${OLLAMA_URL}, tool-calling models: ${models.join(', ')}`;
    } catch { return null; }
  },
  async run(job: AgentJob): Promise<AgentResult> {
    const client = new Client({ name: 'clawdcursor-bench-ollama', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(job.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${job.token}` } } }));
    try {
      const mcpTools = (await client.listTools()).tools as McpTool[];
      const tools = toOllamaTools(mcpTools);
      const finalText = await runLoop(job.prompt, mcpTools.map(t => t.name), {
        signal: job.signal, onSig: job.onSig,
        chat: async messages => {
          const { url, body } = chatRequest(job.model, messages, tools);
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: job.signal });
          if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return (await res.json() as { message: OllamaMessage }).message;
        },
        callTool: (name, args) => client.callTool({ name, arguments: args }, undefined, { signal: job.signal }) as Promise<{ content?: unknown; isError?: unknown }>,
      });
      return { finalText, exitCode: 0 };
    } catch (e) {
      if (job.signal.aborted) return { finalText: '', exitCode: null };   // the watchdog stopped it
      throw e;
    } finally {
      await client.close().catch(() => { /* the server is gone */ });
    }
  },
};
