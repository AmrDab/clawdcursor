/**
 * ~/.clawdcursor/runs/<timestamp>.jsonl: one file per `clawdcursor task` run, one JSON line per event.
 *   {type:"run", id, t, task, runner, model, command, coreVersion, surface}   first line
 *   {type:"event", t, src:"claude"|"codex"|"api", data}                       every event the agent printed (images left out)
 *   {type:"stderr", t, text}                                                   what it wrote to stderr
 *   {type:"end", t, verdict, exitCode, reason?, usage?, session?, ms}                 last line; `session` is the clawdcursor session id
 * Local only, readable by the owner only, the last 50 runs kept.
 */
import * as fs from 'fs';
import * as path from 'path';

const KEEP = 50;

export function runsDir(dataDir: string): string {
  return path.join(dataDir, 'runs');
}
export function sessionsDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWDCURSOR_SESSION_DIR || path.join(dataDir, 'sessions');
}

/** A run id: the start time, safe as a file name and as an environment value. */
export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Screenshots are large and already on screen: an image block keeps its type and size, not its data. */
export function withoutImages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutImages);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (o.type === 'image') {
    const data = (o.data ?? (o.source as Record<string, unknown> | undefined)?.data) as unknown;
    return { type: 'image', ...(typeof data === 'string' ? { bytes: Math.round(data.length * 0.75) } : {}) };
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, withoutImages(x)]));
}

export interface RunLog { id: string; file: string; write(rec: Record<string, unknown>): void }

export function openRunLog(dataDir: string, id: string): RunLog {
  const dir = runsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const old = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) fs.rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  return {
    id, file,
    write(rec) {
      try { fs.appendFileSync(file, `${JSON.stringify({ ...rec, t: rec.t ?? new Date().toISOString() })}\n`); } catch { /* the run goes on without its log */ }
    },
  };
}

export interface RunRecord { type: string; t: string; [k: string]: any }

export function readRun(file: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line cut off by a kill */ }
  }
  return out;
}

/** A run's file from its id, or "last" for the newest. */
export function findRun(dataDir: string, idOrLast: string): string | null {
  const dir = runsDir(dataDir);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return null; }
  if (idOrLast === 'last') return files.length ? path.join(dir, files[files.length - 1]) : null;
  const want = idOrLast.replace(/\.jsonl$/, '');
  const hit = files.find(f => f === `${want}.jsonl`) ?? files.find(f => f.startsWith(want));
  return hit ? path.join(dir, hit) : null;
}

/** `calls`: the calls the server recorded (one line each, a batch included). */
export interface SessionInfo { id: string; file: string; pid: number | null; started: string | null; ended: string | null; run?: string; calls: number }

function readSessionFile(file: string): SessionInfo | null {
  let lines: string[];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()); } catch { return null; }
  let header: Record<string, any> = {};
  try { header = JSON.parse(lines[0] ?? '{}'); } catch { /* no header */ }
  let ended: string | null = null;
  let sawEnd = false;
  let calls = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.type === 'end' && !sawEnd) { ended = o.t ?? null; sawEnd = true; }
      else if (o.type === undefined && typeof o.tool === 'string') calls++;
    } catch { /* skip */ }
  }
  return { id: path.basename(file, '.jsonl'), file, pid: Number.isInteger(header.pid) ? header.pid : null, started: header.started ?? null, ended,
    ...(typeof header.run === 'string' ? { run: header.run } : {}), calls };
}

function sessionFiles(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(f => f.startsWith('session-') && f.endsWith('.jsonl')).sort().reverse().map(f => path.join(dir, f)); }
  catch { return []; }
}

/** A clawdcursor session from its id (session-...), or "last" for the newest. */
export function findSession(dir: string, idOrLast: string): SessionInfo | null {
  const files = sessionFiles(dir);
  if (idOrLast === 'last') return files[0] ? readSessionFile(files[0]) : null;
  const want = idOrLast.replace(/\.jsonl$/, '');
  const hit = files.find(f => path.basename(f, '.jsonl') === want) ?? files.find(f => path.basename(f).startsWith(want));
  return hit ? readSessionFile(hit) : null;
}

/**
 * The session of the server `pid` whose end line was written about `atMs`: the end the next server writes for one it found
 * gone, at the moment it logs that. A pid is reused, the moment is not.
 */
export function sessionEndedAt(dir: string, pid: number, atMs: number): SessionInfo | null {
  for (const f of sessionFiles(dir)) {
    const s = readSessionFile(f);
    if (s?.pid === pid && s.ended && Math.abs(Date.parse(s.ended) - atMs) < 60_000) return s;
  }
  return null;
}

/** The session the run's clawdcursor server wrote (its header carries the run id). Only files newer than the run are read. */
export function sessionOfRun(dir: string, runId: string, startedMs: number): SessionInfo | null {
  for (const f of sessionFiles(dir)) {
    try { if (fs.statSync(f).mtimeMs < startedMs - 1000) continue; } catch { continue; }
    const s = readSessionFile(f);
    if (s?.run === runId) return s;
  }
  return null;
}
