/**
 * What the agent does, as a few kinds of event, from Claude Code's stream-json lines, Codex's --json lines or the API
 * loop; and how each is shown in the terminal. The same parsers re-read a run log for `clawdcursor logs --run`.
 */
import { SERVER_NAME } from './hosts';

export type TraceEvent =
  | { kind: 'start'; model?: string; server?: string; tools?: number }
  | { kind: 'text'; text: string }
  | { kind: 'call'; id?: string; tool: string; action?: string; args: string }
  | { kind: 'result'; id?: string; ok: boolean; text: string; images?: number }
  | { kind: 'final'; text: string; error?: boolean }
  | { kind: 'error'; text: string }
  | ({ kind: 'usage' } & Usage);

/** Tokens a run used: `in` is the input that was not read from the cache; `usd` only when the runner reports a cost. */
export interface Usage { in: number; out: number; cacheRead?: number; cacheWrite?: number; usd?: number }

type Json = Record<string, any>;

function parse(line: string): Json | null {
  try { const o = JSON.parse(line); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** mcp__clawdcursor__system -> system */
export function toolName(name: string): string {
  return name.replace(new RegExp(`^mcp__${SERVER_NAME}__`), '');
}

/** A call's arguments in one short line; `action` is shown on its own. */
export function callOf(name: string, input: unknown, id?: string): TraceEvent {
  const args = input && typeof input === 'object' ? { ...(input as Json) } : {};
  const action = typeof args.action === 'string' ? args.action : undefined;
  delete args.action;
  const rest = Object.keys(args).length ? JSON.stringify(args) : '';
  return { kind: 'call', id, tool: toolName(name), ...(action ? { action } : {}), args: rest };
}

/** An MCP tool result's content blocks -> its text and how many images it had. */
export function resultOf(content: unknown, ok: boolean, id?: string): TraceEvent {
  const blocks: Json[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n');
  const images = blocks.filter(b => b?.type === 'image').length;
  return { kind: 'result', id, ok, text, ...(images ? { images } : {}) };
}

const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Usage from a runner's own counts (a count it did not give is left out); null when it gave none. */
export function usageOf(c: { in?: unknown; out?: unknown; cacheRead?: unknown; cacheWrite?: unknown; usd?: unknown }): TraceEvent | null {
  const inn = num(c.in), out = num(c.out), cacheRead = num(c.cacheRead), cacheWrite = num(c.cacheWrite), usd = num(c.usd);
  if (inn === undefined && out === undefined && cacheRead === undefined && cacheWrite === undefined) return null;
  return { kind: 'usage', in: inn ?? 0, out: out ?? 0, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), ...(usd !== undefined ? { usd } : {}) };
}

/** Anthropic's `usage` object (messages API, and the `usage` of Claude Code's result line). */
export function anthropicUsage(u: unknown, usd?: unknown): TraceEvent | null {
  if (!u || typeof u !== 'object') return null;
  const x = u as Json;
  return usageOf({ in: x.input_tokens, out: x.output_tokens, cacheRead: x.cache_read_input_tokens, cacheWrite: x.cache_creation_input_tokens, usd });
}

/** An OpenAI-compatible `usage` object: prompt_tokens counts the cached ones too, so they are taken out of `in`. */
export function openaiUsage(u: unknown): TraceEvent | null {
  if (!u || typeof u !== 'object') return null;
  const x = u as Json;
  const cached = num(x.prompt_tokens_details?.cached_tokens) ?? 0;
  const prompt = num(x.prompt_tokens);
  return usageOf({ in: prompt === undefined ? undefined : Math.max(0, prompt - cached), out: x.completion_tokens, cacheRead: cached });
}

/** One line of `claude -p --output-format stream-json --verbose`. */
export function claudeEvents(line: string): TraceEvent[] {
  const m = parse(line);
  if (!m) return [];
  if (m.type === 'system' && m.subtype === 'init') {
    const server = Array.isArray(m.mcp_servers) ? m.mcp_servers.find((s: Json) => s?.name === SERVER_NAME) : undefined;
    const tools = Array.isArray(m.tools) ? m.tools.filter((t: unknown) => typeof t === 'string' && t.startsWith(`mcp__${SERVER_NAME}__`)).length : undefined;
    return [{ kind: 'start', model: m.model, server: server ? String(server.status ?? 'unknown') : 'not configured', tools }];
  }
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    return m.message.content.flatMap((b: Json): TraceEvent[] => {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return [{ kind: 'text', text: b.text }];
      if (b?.type === 'tool_use' && typeof b.name === 'string') return [callOf(b.name, b.input, b.id)];
      return [];
    });
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    return m.message.content.filter((b: Json) => b?.type === 'tool_result').map((b: Json) => resultOf(b.content, b.is_error !== true, b.tool_use_id));
  }
  if (m.type === 'result') {
    const text = typeof m.result === 'string' ? m.result : '';
    // The result line's usage and total_cost_usd cover the whole run; the per-message usage is not summed (it would count twice).
    const usage = anthropicUsage(m.usage, m.total_cost_usd);
    return [...(usage ? [usage] : []),
      { kind: 'final', text, ...(m.is_error === true || (m.subtype && m.subtype !== 'success') ? { error: true } : {}) }];
  }
  return [];
}

/**
 * One line of `codex exec --json`. A tool call is an mcp_tool_call item: reported when it starts and again when it
 * completes (with its result). The final message is the last agent_message (the caller reads --output-last-message).
 */
export function codexEvents(line: string): TraceEvent[] {
  const ev = parse(line);
  if (!ev) return [];
  const item = ev.item as Json | undefined;
  if (ev.type === 'error') return [{ kind: 'error', text: String(ev.message ?? 'error') }];
  // TODO(unverified): the shape is read from one recorded run log (usage on turn.completed, input_tokens including cached_input_tokens); Codex's docs were not checked.
  if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage as Json;
    const input = num(u.input_tokens), cached = num(u.cached_input_tokens);
    const usage = usageOf({ in: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)), out: u.output_tokens, cacheRead: cached, cacheWrite: u.cache_write_input_tokens });
    return usage ? [usage] : [];
  }
  if (ev.type === 'turn.failed') return [{ kind: 'error', text: String(ev.error?.message ?? 'the turn failed') }];
  if (!item || typeof item !== 'object') return [];
  if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
    if (ev.type === 'item.started') {
      let args = item.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the text */ } }
      return [callOf(item.tool, args, item.id)];
    }
    if (ev.type === 'item.completed') {
      const failed = item.status === 'failed' || !!item.error || item.result?.isError === true || item.result?.is_error === true;
      if (item.error && !item.result) return [{ kind: 'result', id: item.id, ok: false, text: String(item.error.message ?? item.error) }];
      return [resultOf(item.result?.content ?? item.result?.Ok?.content ?? '', !failed, item.id)];
    }
    return [];
  }
  if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') return [{ kind: 'text', text: item.text }];
  if (item.type === 'error' && typeof item.message === 'string') return [{ kind: 'error', text: item.message }];
  return [];
}

/** PASS or FAIL from the final message: its last line that starts with one of them (bold, a quote mark and so on allowed). */
export function verdictOf(text: string): 'PASS' | 'FAIL' | null {
  for (const line of text.split('\n').reverse()) {
    const m = /^[\s*_`>#"'-]*(?:verdict:\s*)?(PASS|FAIL)\b/i.exec(line);
    if (m) return m[1].toUpperCase() as 'PASS' | 'FAIL';
  }
  return null;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A result in one line: its first line, plus clawdcursor's closing status line ([confirmed], [failed · CODE ...]) when it has one. */
export function shortResult(text: string, images = 0): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const status = [...lines].reverse().find(l => /^\[(confirmed|unverified|refused|failed)\b/.test(l));
  const first = lines.find(l => l !== status) ?? '';
  const parts = [first && oneLine(first, 90), status && oneLine(status, 70), images ? `[${images} image${images > 1 ? 's' : ''}]` : ''].filter(Boolean);
  return parts.join('  ') || '(empty)';
}

export interface Paint { dim(s: string): string; green(s: string): string; red(s: string): string; cyan(s: string): string; bold(s: string): string }
const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export function paint(on: boolean): Paint {
  const id = (s: string) => s;
  return on ? { dim: ansi(2), green: ansi(32), red: ansi(31), cyan: ansi(36), bold: ansi(1) } : { dim: id, green: id, red: id, cyan: id, bold: id };
}

/** One event as a trace line (null: nothing to show). `who` names the agent in its own messages. */
export function renderEvent(ev: TraceEvent, p: Paint, who = 'agent'): string | null {
  switch (ev.kind) {
    case 'start': {
      const server = ev.server === 'connected' ? p.green('connected') : p.red(ev.server ?? 'not connected');
      return `${p.dim('●')} ${ev.model ?? 'default model'} · clawdcursor ${server}${ev.tools !== undefined ? ` · ${ev.tools} tools` : ''}`;
    }
    case 'text': return `${p.dim(`${who}:`)} ${oneLine(ev.text, 200)}`;
    case 'call': return `${p.cyan('→')} ${p.bold(ev.tool)}${ev.action ? ` ${ev.action}` : ''}${ev.args ? ` ${p.dim(oneLine(ev.args, 100))}` : ''}`;
    case 'result': return `  ${ev.ok ? p.green('← ok') : p.red('← error')}  ${p.dim(shortResult(ev.text, ev.images))}`;
    case 'error': return p.red(`✗ ${oneLine(ev.text, 200)}`);
    case 'final': return null;   // the caller prints the verdict
    case 'usage': return null;   // summed and printed once, at the end
  }
}

/** The sum of usage events. */
export function addUsage(total: Usage | null, ev: Usage): Usage {
  const t = total ?? { in: 0, out: 0 };
  const cacheRead = (t.cacheRead ?? 0) + (ev.cacheRead ?? 0), cacheWrite = (t.cacheWrite ?? 0) + (ev.cacheWrite ?? 0);
  return { in: t.in + ev.in, out: t.out + ev.out, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}),
    ...(t.usd !== undefined || ev.usd !== undefined ? { usd: (t.usd ?? 0) + (ev.usd ?? 0) } : {}) };
}

/** "tokens: 1,234 in · 56 out · 7,890 cached · $0.12" (no $ when unknown). */
export function usageLine(u: Usage): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return `tokens: ${n(u.in)} in · ${n(u.out)} out · ${n(u.cacheRead ?? 0)} cached${u.usd !== undefined ? ` · $${u.usd.toFixed(2)}` : ''}`;
}

/** Seconds since the start, right-aligned: "  3.2s". */
export function elapsed(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`.padStart(7);
}
