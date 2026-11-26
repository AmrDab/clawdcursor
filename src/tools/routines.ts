/**
 * Routines: a sequence of tool calls that worked once, saved under a name and replayed later in one `batch` call.
 *
 * - Saved by `batch {save_as}`: with `steps`, once they all ran; without, the calls that changed something in this MCP
 *   session since its last save (recorded here, per session).
 * - Stored as JSON in ~/.clawdcursor/routines/<name>.json, on this computer only. They hold what the agent sent (typed
 *   text included), as the session log does not.
 * - Steps are tool calls by name and label, so a routine is not tied to one app or OS. What only holds for one session
 *   (an element_id or snapshot_id, a window handle, a screenshot id) is not saved; a processId becomes the process name.
 * - `{{var}}` in a string argument is filled from `batch {replay, vars}`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { DATA_DIR } from '../paths';
import { compactCall } from './compact-routes';
import { isActingAction } from '../core/result-codes';
import type { PlatformAdapter } from '../platform/types';

export interface RoutineStep { name: string; arguments?: Record<string, unknown> }
export interface Routine { name: string; description: string; savedAt: string; steps: RoutineStep[] }

let testDir: string | null = null;
/** Tests point the store at a temp folder; null puts it back. */
export function __setRoutinesDirForTests(d: string | null): void { testDir = d; }
/** ~/.clawdcursor/routines, or CLAWDCURSOR_ROUTINES_DIR (the schema snapshot points it at nothing). */
export function routinesDir(): string { return testDir ?? process.env.CLAWDCURSOR_ROUTINES_DIR ?? path.join(DATA_DIR, 'routines'); }

/** A routine name: letters, digits, `-` and `_`, 1 to 60 characters. Kept as given, matched without case. */
export const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const MAX_STEPS = 50;
/** Most routines the server instructions list, and the most of a description they show. */
export const LISTED_MAX = 20;
const DESCRIPTION_SHOWN = 120;

const fileOf = (name: string) => path.join(routinesDir(), `${name.toLowerCase()}.json`);

export function saveRoutine(name: string, description: string, steps: RoutineStep[]): string {
  fs.mkdirSync(routinesDir(), { recursive: true });
  const r: Routine = { name, description: description.trim(), savedAt: new Date().toISOString(), steps };
  const file = fileOf(name);
  fs.writeFileSync(file, JSON.stringify(r, null, 2), { mode: 0o600 });
  return file;
}

export function loadRoutine(name: string): Routine | null {
  if (!NAME_RULE.test(name)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(fileOf(name), 'utf8')) as Routine;
    if (!Array.isArray(r.steps)) return null;
    // The name shown is the file's own: a name inside the file that is not that one is not trusted.
    const shown = typeof r.name === 'string' && r.name.toLowerCase() === name.toLowerCase() ? r.name : name.toLowerCase();
    return { ...r, name: shown, description: typeof r.description === 'string' ? r.description : '' };
  } catch { return null; }
}

/** Saved routines, newest first. A file that is not a routine is skipped. */
export function listRoutines(): Routine[] {
  let names: string[];
  try { names = fs.readdirSync(routinesDir()).filter(f => f.endsWith('.json')); } catch { return []; }
  return names.map(f => loadRoutine(f.slice(0, -5))).filter((r): r is Routine => !!r)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/** One line per saved routine for the server instructions, or '' when there is none. */
export function routinesLine(): string {
  const all = listRoutines();
  if (!all.length) return '';
  // A description is text from a file: one line, cut short, so it cannot pose as more of these instructions.
  const line = (d: string) => { const t = d.replace(/\s+/g, ' ').trim(); return t.length > DESCRIPTION_SHOWN ? `${t.slice(0, DESCRIPTION_SHOWN - 1)}…` : t; };
  const shown = all.slice(0, LISTED_MAX).map(r => `${r.name} (${r.steps.length} steps${varsOf(r.steps).length ? `, vars ${varsOf(r.steps).join(', ')}` : ''}): ${line(r.description) || 'no description'}`);
  return `Saved routines on this computer: ${shown.join('; ')}${all.length > LISTED_MAX ? `; and ${all.length - LISTED_MAX} more` : ''}. `;
}

// ─── {{vars}} ────────────────────────────────────────────────

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The `{{var}}` names a routine's string arguments use, in order of first use. */
export function varsOf(steps: RoutineStep[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { for (const m of v.matchAll(VAR)) if (!out.includes(m[1])) out.push(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  steps.forEach(s => walk(s.arguments));
  return out;
}

/** The steps with every `{{var}}` filled, or the names no value was given for. */
export function fillVars(steps: RoutineStep[], vars: Record<string, unknown>): { steps: RoutineStep[] } | { missing: string[] } {
  const missing = varsOf(steps).filter(v => vars[v] === undefined || vars[v] === null);
  if (missing.length) return { missing };
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(VAR, (_m, k: string) => String(vars[k]));
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { steps: steps.map(s => ({ name: s.name, ...(s.arguments ? { arguments: fill(s.arguments) as Record<string, unknown> } : {}) })) };
}

// ─── Making steps portable ───────────────────────────────────

/** Arguments that only mean something in the session that made them. */
const SESSION_ONLY = ['element_id', 'snapshot_id', 'shot', 'handle', 'windowId', 'windowHandle'];

/**
 * The steps as they can be saved: session-only arguments dropped, a processId turned into its process name (by the
 * windows open now), and a note for each change. A step that targets an element_id only cannot be replayed: refused.
 */
export async function portableSteps(steps: RoutineStep[], platform?: PlatformAdapter): Promise<{ steps: RoutineStep[]; notes: string[]; refused: string[] }> {
  const notes: string[] = [];
  const refused: string[] = [];
  let windows: Awaited<ReturnType<PlatformAdapter['listWindows']>> | null = null;
  const out: RoutineStep[] = [];
  for (const [i, s] of steps.entries()) {
    const args = { ...(s.arguments ?? {}) };
    const n = i + 1;
    if (args.element_id !== undefined && typeof args.name !== 'string' && typeof args.target !== 'string') {
      refused.push(`step ${n} targets element_id ${JSON.stringify(args.element_id)}, which only holds in this session: use its name instead`);
      continue;
    }
    const dropped = SESSION_ONLY.filter(k => args[k] !== undefined);
    for (const k of dropped) delete args[k];
    if (dropped.length) notes.push(`step ${n}: dropped ${dropped.join(', ')} (session-only)`);
    if (typeof args.processId === 'number') {
      windows ??= await platform?.listWindows().catch(() => []) ?? [];
      const w = windows.find(x => x.processId === args.processId);
      const pid = args.processId;
      delete args.processId;
      if (w?.processName && typeof args.processName !== 'string') {
        args.processName = w.processName;
        notes.push(`step ${n}: processId ${pid} saved as processName "${w.processName}"`);
      } else notes.push(`step ${n}: dropped processId ${pid} (session-only)`);
    }
    if (typeof args.x === 'number' || Array.isArray(args.path)) notes.push(`step ${n} acts at x,y: it replays right only while the window is where it was`);
    out.push({ name: s.name, ...(Object.keys(args).length ? { arguments: args } : {}) });
  }
  return { steps: out, notes, refused };
}

// ─── Recording this session's calls ──────────────────────────

/** Calls worth replaying besides the ones that change something: connecting the browser, waiting for an element. */
const ALSO_RECORDED = new Set(['browser:connect', 'accessibility:wait_for']);
/** Calls never recorded: asking the user, saving or replaying routines. */
const NEVER_RECORDED = new Set(['system:pause_for_user']);

export function recordable(tool: string, action: string | undefined): boolean {
  const c = compactCall(tool, action);
  const key = `${c.tool}:${c.action ?? ''}`;
  if (NEVER_RECORDED.has(key)) return false;
  return ALSO_RECORDED.has(key) || isActingAction(c.tool, c.action);
}

const recordings = new Map<string, RoutineStep[]>();

/** Which MCP session a tool call comes from: set around each call (mcp-server.ts), read by `batch save_as`. */
const session = new AsyncLocalStorage<string>();
export function inRoutineSession<R>(id: string, fn: () => R): R { return session.run(id, fn); }
export function currentRoutineSession(): string | undefined { return session.getStore(); }

/**
 * Note a call that succeeded in an MCP session: kept when it is one a routine replays. A batch adds its steps that ran,
 * unless it saved or replayed a routine.
 */
export function noteCall(session: string, tool: string, params: Record<string, unknown>, stepStatus?: string[]): void {
  const rec = recordings.get(session) ?? [];
  const push = (s: RoutineStep) => { rec.push(s); if (rec.length > MAX_STEPS) rec.shift(); };
  if (tool === 'batch') {
    if (params.save_as !== undefined || params.replay !== undefined) return;
    let steps = params.steps;
    if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { return; } }
    if (!Array.isArray(steps)) return;
    steps.forEach((raw, i) => {
      const s = (raw ?? {}) as { name?: unknown; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
      const args = s.arguments ?? s.args ?? {};
      if (typeof s.name !== 'string' || stepStatus?.[i] !== 'ok') return;
      const name = s.name.replace(/^mcp__[\w-]*clawdcursor__(?=[^_])/, '');
      if (recordable(name, typeof args.action === 'string' ? args.action : undefined)) push({ name, arguments: { ...args } });
    });
  } else if (recordable(tool, typeof params.action === 'string' ? params.action : undefined)) {
    push({ name: tool, arguments: { ...params } });
  }
  recordings.set(session, rec);
}

/** This session's recorded calls since its last save, handed over and forgotten. */
export function takeRecording(session: string): RoutineStep[] {
  const rec = recordings.get(session) ?? [];
  recordings.delete(session);
  return rec;
}

/** A session ended: its recording goes with it. */
export function forgetSession(session: string): void { recordings.delete(session); }
