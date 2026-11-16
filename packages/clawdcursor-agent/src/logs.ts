/**
 * `clawdcursor logs`: the day log (~/.clawdcursor/logs/clawdcursor-YYYYMMDD.log, one {ts, level, msg, pid, meta} line
 * per event), shown readably: tool calls with outcome, result code and where their time went, and the control events
 * (stop, resume, pause, a guard's refusal, a server starting or exiting). `--run` shows a `clawdcursor task` run with
 * its clawdcursor session on one timeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findRun, findSession, readRun, sessionEndedAt, sessionsDir, type SessionInfo } from './runlog';
import { claudeEvents, codexEvents, elapsed, paint, renderEvent, type Paint, type TraceEvent } from './trace';
import type { CoreContext } from './task';

export interface LogsOptions { follow?: boolean; session?: string; tool?: string; errors?: boolean; since?: string; run?: string }
export interface LogRecord { ts: string; level: string; msg: string; pid?: number; meta?: Record<string, any> }

/** The events shown; the rest (safety.decision on every call, step.slow, which tool.done repeats) are left out. */
export function shown(r: LogRecord): boolean {
  return r.msg === 'tool.done' || r.msg.startsWith('control.') || r.msg.startsWith('pause.') || r.msg === 'safety.refused'
    || r.msg === 'mcp.start' || r.msg === 'mcp.exit' || r.msg === 'session.end' || r.msg === 'crash' || r.msg === 'unhandledRejection';
}

/** "30s", "10m", "2h", "1d" -> the time that long before `now` (ms). */
export function parseSince(s: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s.trim());
  if (!m) throw new Error(`--since takes a duration such as 30s, 10m, 2h or 1d (got "${s}")`);
  return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
}

export interface Filter {
  tool?: string;
  errors?: boolean;
  sinceMs?: number;
  /** One server's session: its pid, and the time it ran (a record without a pid, from before 2.1, is matched on time alone). */
  session?: { pid: number | null; fromMs: number; toMs: number };
}

/** The session's server logged mcp.start before its first call made the session file: reach back that far. */
const START_SLACK_MS = 10 * 60_000;

export function sessionFilter(s: SessionInfo): Filter['session'] {
  const from = s.started ? Date.parse(s.started) : 0;
  return { pid: s.pid, fromMs: from, toMs: s.ended ? Date.parse(s.ended) + 5000 : Infinity };
}

export function matches(r: LogRecord, f: Filter): boolean {
  if (!shown(r)) return false;
  const t = Date.parse(r.ts);
  if (f.sinceMs !== undefined && !(t >= f.sinceMs)) return false;
  if (f.session) {
    const s = f.session;
    // Whose record: the server it is about (mcp.start / mcp.exit name it: an unclean exit is written by the NEXT
    // server), else the process that wrote it.
    const about = r.msg === 'mcp.start' || r.msg === 'mcp.exit' ? r.meta?.pid : undefined;
    const owner = typeof about === 'number' ? about : r.pid;
    if (owner !== undefined && s.pid !== null) {
      if (owner !== s.pid || t < s.fromMs - START_SLACK_MS || t > s.toMs) return false;
    } else if (t < s.fromMs || t > s.toMs) return false;
  }
  if (f.tool) {
    const tool = r.meta?.tool, action = r.meta?.action;
    if (typeof tool !== 'string') return false;
    if (tool !== f.tool && `${tool}.${action}` !== f.tool && action !== f.tool) return false;
  }
  if (f.errors) {
    const bad = r.level === 'warn' || r.level === 'error' || (r.msg === 'tool.done' && r.meta?.outcome !== 'ok' && r.meta?.outcome !== 'partial');
    if (!bad) return false;
  }
  return true;
}

/**
 * A `clawdcursor task` run's own server, gone when its run ended: the run's agent CLI stops it, Codex (and Claude Code on
 * macOS) without leaving it time to log a clean exit, so the next server logs "killed or crashed" (every run in `logs
 * --errors`, Mac check 2026-11-16). It is that only when its session names the run (CLAWDCURSOR_RUN_ID: only the task
 * runner sets it), the run's log has its end, and the server recorded every call the agent made: a server that died
 * mid-run left a call unanswered and is still reported. A hard kill after its last answer, before the agent stopped it,
 * looks the same; the run needed it no more, and an exception there is logged as `crash` anyway.
 */
function endedWithRun(r: LogRecord, dataDir: string): string | null {
  if (r.msg !== 'mcp.exit' || r.meta?.detectedAt !== 'next start' || typeof r.meta.pid !== 'number') return null;
  try {
    const s = sessionEndedAt(sessionsDir(dataDir), r.meta.pid, Date.parse(r.ts));
    const file = s?.run ? findRun(dataDir, s.run) : null;
    if (!s?.run || !file) return null;
    const recs = readRun(file);
    if (!recs.some(x => x.type === 'end')) return null;
    const calls = recs.filter(x => x.type === 'event').flatMap(x => runEvents(x.src, x.data)).filter(e => e.kind === 'call').length;
    return calls === s.calls ? s.run : null;
  } catch { return null; }
}

/** A record as shown: the exit of a server that went down with its task run is not a crash (endedWithRun). */
function asShown(r: LogRecord, dataDir: string): LogRecord {
  const run = endedWithRun(r, dataDir);
  return run ? { ...r, level: 'info', meta: { ...r.meta, reason: `ended with its clawdcursor task run ${run} (every call was answered)` } } : r;
}

const ms = (n: unknown) => (typeof n === 'number' ? (n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`) : '');

/** Where a call's time went: "ps-bridge list-windows 10× 1955 ms, powershell 2× 1404 ms" (slowest first). */
export function stepsText(steps: unknown): string {
  if (!steps || typeof steps !== 'object') return '';
  return Object.entries(steps as Record<string, { n?: number; ms?: number }>)
    .sort((a, b) => (b[1]?.ms ?? 0) - (a[1]?.ms ?? 0))
    .map(([name, s]) => `${name} ${s?.n ?? 1}× ${ms(s?.ms ?? 0)}`).join(', ');
}

/** One record as one line, without its time. */
export function formatRecord(r: LogRecord, p: Paint): string {
  const m = r.meta ?? {};
  const name = (tool: unknown, action: unknown) => `${tool ?? '?'}${action ? `.${action}` : ''}`;
  switch (r.msg) {
    case 'tool.done': {
      const ok = m.outcome === 'ok';
      const outcome = ok ? p.green('ok') : m.outcome === 'partial' ? 'partial' : p.red(String(m.outcome ?? 'error'));
      const steps = stepsText(m.steps);
      return [`${p.bold(name(m.tool, m.action))}`, `${outcome}${m.code ? ` ${p.red(m.code)}` : ''}`, ms(m.ms), m.app ? p.dim(String(m.app)) : '',
        steps ? p.dim(`· ${steps}`) : ''].filter(Boolean).join('  ');
    }
    case 'mcp.start':
      return `${p.cyan('● mcp.start')}  v${m.version ?? '?'} · pid ${m.pid ?? r.pid ?? '?'} · ${m.surface ?? '?'}${m.readyMs !== undefined ? ` · ready ${ms(m.readyMs)}` : ''}`;
    case 'mcp.exit': {
      const cut = m.cutOff ? ` · cut off ${name(m.cutOff.tool, m.cutOff.action)} after ${ms(m.cutOff.ranMs)}` : '';
      const last = m.lastFinishedCall ? ` · last call ${name(m.lastFinishedCall.tool, m.lastFinishedCall.action)}` : '';
      return `${r.level === 'warn' ? p.red('○ mcp.exit') : p.cyan('○ mcp.exit')}  pid ${m.pid ?? '?'} · ${m.reason ?? ''}${cut}${last}${m.detectedAt ? ` · seen at the ${m.detectedAt}` : ''}`;
    }
    case 'session.end': return `${p.cyan('○ session.end')}  ${m.reason ?? ''}`;
    case 'control.stop': return `${p.red('■ control.stop')}  by ${m.by ?? '?'}`;
    case 'control.resume': return `${p.green('▶ control.resume')}  by ${m.by ?? '?'}`;
    case 'safety.refused':
      return `${p.red('⊘ safety.refused')}  ${name(m.tool, m.action)} · guard ${m.guard ?? '?'}${m.batchStep !== undefined ? ` · batch step ${m.batchStep}` : ''}`;
    case 'crash': case 'unhandledRejection': return p.red(`✗ ${r.msg}  ${m.name ?? ''}${m.code ? ` ${m.code}` : ''}`);
    default: {
      const rest = Object.entries(m).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ');
      return `${p.cyan(`‖ ${r.msg}`)}${rest ? `  ${rest}` : ''}`;
    }
  }
}

const clock = (ts: string) => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
};
const dayOf = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function parseLines(text: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.msg === 'string' && typeof r.ts === 'string') out.push(r); } catch { /* a torn line */ }
  }
  return out;
}

export function logDir(ctx: CoreContext, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWDCURSOR_LOG_DIR || path.join(ctx.dataDir, 'logs');
}

/** The day files (UTC days, rotated parts first) from `sinceMs`'s day on, oldest first; with no `sinceMs`, the newest day only. */
export function dayFiles(dir: string, sinceMs?: number): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(f => /^clawdcursor-\d{8}\.log(\.\d+)?$/.test(f)); } catch { return []; }
  const days = [...new Set(names.map(f => f.slice(12, 20)))].sort();
  const since = sinceMs !== undefined ? new Date(sinceMs).toISOString().slice(0, 10).replace(/-/g, '') : null;
  const keep = since ? days.filter(d => d >= since) : days.slice(-1);
  return keep.flatMap(d => names.filter(f => f.slice(12, 20) === d)
    .sort((a, b) => (Number(b.split('.log.')[1] ?? -1) - Number(a.split('.log.')[1] ?? -1))))
    .map(f => path.join(dir, f));
}

function printRecords(recs: LogRecord[], p: Paint, out: (l: string) => void, lastDay: { v: string | null }): void {
  for (const r of recs) {
    const day = dayOf(r.ts);
    if (day !== lastDay.v) { out(p.dim(`── ${day} ──`)); lastDay.v = day; }
    out(`${p.dim(clock(r.ts))}  ${formatRecord(r, p)}`);
  }
}

/** Shown when no filter narrows the view: the last this many events. */
export const DEFAULT_TAIL = 50;

export async function runLogs(opts: LogsOptions, ctx: CoreContext, io: { out?(l: string): void; color?: boolean } = {}): Promise<number> {
  const out = io.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const p = paint(io.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR));
  if (opts.run) return showRun(opts.run, ctx, p, out);

  const f: Filter = { tool: opts.tool, errors: opts.errors };
  try { if (opts.since) f.sinceMs = parseSince(opts.since); } catch (e) { out(p.red((e as Error).message)); return 1; }
  if (opts.session) {
    const s = findSession(sessionsDir(ctx.dataDir), opts.session);
    if (!s) { out(p.red(`No clawdcursor session "${opts.session}" in ${sessionsDir(ctx.dataDir)}.`)); return 1; }
    f.session = sessionFilter(s);
    out(p.dim(`session ${s.id} · pid ${s.pid ?? '?'} · ${s.started ?? '?'} → ${s.ended ?? 'still running or killed'}`));
  }
  const dir = logDir(ctx);
  const from = f.sinceMs ?? (f.session ? f.session.fromMs - START_SLACK_MS : undefined);
  const files = dayFiles(dir, from);
  const all = files.flatMap(file => { try { return parseLines(fs.readFileSync(file, 'utf8')); } catch { return []; } })
    .map(r => asShown(r, ctx.dataDir)).filter(r => matches(r, f));
  const narrowed = f.sinceMs !== undefined || f.session !== undefined;
  const lastDay = { v: null as string | null };
  printRecords(narrowed ? all : all.slice(opts.follow ? -10 : -DEFAULT_TAIL), p, out, lastDay);
  if (!opts.follow) {
    if (!all.length) out(p.dim(`(nothing matched in ${files.length ? files.map(x => path.basename(x)).join(', ') : `${dir} — no day log yet`})`));
    return 0;
  }
  return follow(dir, ctx.dataDir, f, p, out, lastDay);
}

/** Print new lines as they are written, across a day change and a rotation, until Ctrl-C. */
function follow(dir: string, dataDir: string, f: Filter, p: Paint, out: (l: string) => void, lastDay: { v: string | null }): Promise<number> {
  const today = () => { const d = new Date(); return path.join(dir, `clawdcursor-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}.log`); };
  let file = today();
  let offset = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
  let rest = '';
  out(p.dim(`following ${file} (Ctrl-C to stop)`));
  return new Promise(() => {
    setInterval(() => {
      const now = today();
      if (now !== file) { file = now; offset = 0; rest = ''; }
      let fd: number;
      try { fd = fs.openSync(file, 'r'); } catch { return; }
      try {
        const size = fs.fstatSync(fd).size;   // the size of the file that is open, not of whatever has the name now
        if (size < offset) { offset = 0; rest = ''; }   // rotated: a new file under the same name
        if (size === offset) return;
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const text = rest + buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        rest = cut < 0 ? text : text.slice(cut + 1);
        printRecords(parseLines(cut < 0 ? '' : text.slice(0, cut)).map(r => asShown(r, dataDir)).filter(r => matches(r, f)), p, out, lastDay);
      } finally { fs.closeSync(fd); }
    }, 500);
  });
}

/** A run's events back as trace events: the CLIs' raw lines go through the same parsers as during the run. */
export function runEvents(src: string, data: unknown): TraceEvent[] {
  if (src === 'api') return data && typeof data === 'object' ? [data as TraceEvent] : [];
  const line = typeof data === 'string' ? data : JSON.stringify(data);
  return src === 'codex' ? codexEvents(line) : claudeEvents(line);
}

/** `logs --run`: the run's trace and its clawdcursor session's log on one timeline. */
function showRun(id: string, ctx: CoreContext, p: Paint, out: (l: string) => void): number {
  const file = findRun(ctx.dataDir, id);
  if (!file) { out(p.red(`No run "${id}" in ${path.join(ctx.dataDir, 'runs')}: \`clawdcursor task\` writes one per run.`)); return 1; }
  const recs = readRun(file);
  const head = recs.find(r => r.type === 'run');
  const end = recs.find(r => r.type === 'end');
  const t0 = Date.parse(head?.t ?? recs[0]?.t ?? new Date().toISOString());
  out(`${p.bold('run')} ${path.basename(file, '.jsonl')} · ${head?.runner ?? '?'}${head?.model ? ` · ${head.model}` : ''} · ${head?.surface ?? ''} tools`);
  if (head?.task) out(p.dim(`task: ${head.task}`));
  if (head?.command) out(p.dim(`command: ${head.command}`));

  const rows: Array<{ t: number; line: string }> = [];
  const who = head?.runner === 'claude' || head?.runner === 'codex' ? head.runner : 'model';
  for (const r of recs) {
    if (r.type === 'event') {
      for (const ev of runEvents(r.src, r.data)) { const line = renderEvent(ev, p, who); if (line) rows.push({ t: Date.parse(r.t), line }); }
    } else if (r.type === 'interrupted') rows.push({ t: Date.parse(r.t), line: p.red('stopping (Ctrl-C)…') });
  }
  const session = end?.session ? findSession(sessionsDir(ctx.dataDir), end.session) : null;
  if (session) {
    const f: Filter = { session: sessionFilter(session) };
    const logs = dayFiles(logDir(ctx), f.session!.fromMs - START_SLACK_MS)
      .flatMap(x => { try { return parseLines(fs.readFileSync(x, 'utf8')); } catch { return []; } })
      .map(r => asShown(r, ctx.dataDir)).filter(r => matches(r, f));
    for (const r of logs) rows.push({ t: Date.parse(r.ts), line: `    ${p.dim('clawdcursor')} ${formatRecord(r, p)}` });
  }
  rows.sort((a, b) => a.t - b.t);
  for (const r of rows) out(`${p.dim(elapsed(r.t - t0))}  ${r.line}`);
  out('');
  const v = end?.verdict;
  out(`${v === 'PASS' ? p.green(p.bold('PASS')) : p.red(p.bold(v ?? 'NO VERDICT'))}${end?.reason ? `  ${end.reason}` : ''} · exit ${end?.exitCode ?? '?'}${end?.ms ? ` · ${(end.ms / 1000).toFixed(1)} s` : ''}`);
  out(p.dim(session ? `clawdcursor session ${session.id} (clawdcursor logs --session ${session.id})` : end?.session ? `clawdcursor session ${end.session} (its file is gone)` : 'no clawdcursor session was recorded for this run'));
  return 0;
}
