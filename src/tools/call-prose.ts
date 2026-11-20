/**
 * Hints name a call as prose, never as call-shaped text.
 *
 * Tool text and result lines write a call as `browser {"action":"page_context"}`. A host does not call a tool named
 * `browser`: it prefixes every tool with its server name, so agents that copied the bare name got "No such tool" and lost a
 * round trip (8 of 16 test runs, audit 2026-11-19). Prose names the tool and the action and leaves the host's spelling to the
 * agent: "the browser tool, action page_context". The tool names follow the surface being served: compact names a compound
 * tool and its action, granular names the one granular tool that action runs.
 *
 * Applied once, to the text that leaves the server (mcp-server.ts), so every hint is covered whoever wrote it.
 */

import { COMPOUND_ROUTE_INDEX, compactCall } from './compact-routes';
import { rewriteOutsideData } from './hint-rewrite';

export type CallSurface = 'compact' | 'granular';

const COMPOUNDS = Object.keys(COMPOUND_ROUTE_INDEX);
const DELEGATES = [...new Set(Object.values(COMPOUND_ROUTE_INDEX).flat().map(r => r.delegate))];
// Longest first, so `mouse_click` is never read as a shorter name that ends it.
const NAMES = [...COMPOUNDS, ...DELEGATES].sort((a, b) => b.length - a.length);

/** `name {"action":"x", ...}`, `name({...})` or `name {"key": ...}`, with the arguments left to the scanner below. */
const CALL_HEAD = new RegExp(`(\`?)(?<![\\w"-])(${NAMES.join('|')})(\\(?)[ \\t]*\\{(?=[ \\t]*"?[A-Za-z_]+"?[ \\t]*:)`, 'g');

/** The end of a value that starts at `i`: the next top-level `,` or `}`. -1 when the text ends first. */
function valueEnd(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      if (i >= s.length) return -1;
    } else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (depth === 0) return c === '}' ? i : -1; depth--; }
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

/** The `key: value` pairs of an argument list that starts after its `{`, and where its `}` is. Null when it is not one. */
function readArgs(s: string, from: number): { args: [string, string][]; end: number } | null {
  const args: [string, string][] = [];
  let i = from;
  for (;;) {
    while (/\s/.test(s[i] ?? '')) i++;
    if (s[i] === '}') return { args, end: i + 1 };
    const key = /^(?:"([A-Za-z_]+)"|([A-Za-z_]+))[ \t]*:\s*/.exec(s.slice(i));
    if (!key) return null;
    i += key[0].length;
    const end = valueEnd(s, i);
    if (end < 0) return null;
    args.push([key[1] ?? key[2], s.slice(i, end).trim()]);
    i = end;
    if (s[i] === ',') i++;
  }
}

function proseCall(name: string, args: [string, string][], surface: CallSurface): string | null {
  const given = args.find(([k]) => k === 'action');
  const action = given ? given[1].replace(/^"|"$/g, '') : undefined;
  const rest = args.filter(([k]) => k !== 'action').map(([k, v]) => `${k} ${v}`);
  let tool: string;
  let act: string | undefined;
  if (COMPOUNDS.includes(name)) {
    if (!action) return null;
    const route = COMPOUND_ROUTE_INDEX[name].find(r => r.action === action);
    if (surface === 'compact') { tool = name; act = action; }
    else if (route) tool = route.delegate;
    else return null;
  } else if (surface === 'compact') {
    const c = compactCall(name);
    if (!c.action) return null;
    tool = c.tool; act = c.action;
  } else tool = name;
  return [`the ${tool} tool${act ? `, action ${act}` : ''}`, ...rest].join(', ');
}

/** Rewrite every call-shaped text in `text` as prose for `surface`. Text that is not a well-formed call stays as it is. */
export function callsAsProse(text: string, surface: CallSurface): string {
  if (!text.includes('{')) return text;
  let out = '';
  let last = 0;
  CALL_HEAD.lastIndex = 0;
  for (let m = CALL_HEAD.exec(text); m; m = CALL_HEAD.exec(text)) {
    const parsed = readArgs(text, m.index + m[0].length);
    if (!parsed) continue;
    let end = parsed.end;
    // `browser({...})` and `` `browser {...}` ``: the brackets and ticks around the call go with it, or not at all.
    if (m[3]) { if (text[end] !== ')') continue; end++; }
    const ticks = !!m[1] && text[end] === '`';
    if (ticks) end++;
    const prose = proseCall(m[2], parsed.args, surface);
    if (!prose) continue;
    out += text.slice(last, m.index) + (m[1] && !ticks ? m[1] : '') + prose;
    last = end;
    CALL_HEAD.lastIndex = end;
  }
  return out + text.slice(last);
}

/** The fields of a JSON result that advise the caller; the rest of a JSON result is data and is never touched. */
const ADVICE_FIELDS = ['next', 'hint', 'toMouseClick'] as const;

/** `callsAsProse` for a result that is prose or a JSON result: prose outside the screen-content blocks, a JSON result's advice fields only. */
export function resultCallsAsProse(text: string, surface: CallSurface): string {
  const t = text.trim();
  if (t.startsWith('{')) {
    let o: Record<string, unknown> | undefined;
    try { o = JSON.parse(t); } catch { /* prose that starts with a brace */ }
    if (o) {
      let changed = false;
      for (const k of ADVICE_FIELDS) {
        const v = o[k];
        if (typeof v !== 'string') continue;
        const p = callsAsProse(v, surface);
        if (p !== v) { o[k] = p; changed = true; }
      }
      if (!changed) return text;
      // Same layout as it came in; an integer past 2^53 would lose digits in a re-serialisation, so replace in the text itself then.
      const indent = t.includes('\n') ? 2 : undefined;
      if (JSON.stringify(JSON.parse(t), null, indent) === t) return JSON.stringify(o, null, indent);
      let outText = text;
      const orig = JSON.parse(t);
      for (const k of ADVICE_FIELDS) {
        if (typeof orig[k] !== 'string' || o[k] === orig[k]) continue;
        outText = outText.replace(JSON.stringify(orig[k]), () => JSON.stringify(o![k]));
      }
      return outText;
    }
  }
  return rewriteOutsideData(text, prose => callsAsProse(prose, surface));
}
