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
  | { kind: 'error'; text: string };

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
    return [{ kind: 'final', text, ...(m.is_error === true || (m.subtype && m.subtype !== 'success') ? { error: true } : {}) }];
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
  }
}

/** Seconds since the start, right-aligned: "  3.2s". */
export function elapsed(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`.padStart(7);
}
