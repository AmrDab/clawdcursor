/**
 * `clawdcursor agent`'s live log: one line per action from every clawdcursor on this computer (the stdio servers
 * Claude and other hosts start, `clawdcursor task` runs, the daemon itself), read from the shared day log
 * (~/.clawdcursor/logs/clawdcursor-YYYYMMDD.log) as it is written, until Ctrl+C.
 *
 * Only names, codes, outcomes and times are printed. Typed text, clipboard and screen text never reach the day log
 * (session-log.ts), and every printed field is checked for its shape here, so a line that carries one prints nothing of it.
 */
import * as fs from 'fs';
import * as path from 'path';
import pc from 'picocolors';
import { dayLogName, getLogDir, keepOffTerminal } from '../core/observability/logger';

type Colors = ReturnType<typeof pc.createColors>;

export interface DayLogRecord { ts?: unknown; level?: unknown; msg?: unknown; pid?: unknown; meta?: unknown }

/** The day log's events this view prints; the rest (step.slow, safety.*, debug) are left out. */
export const LIVE_EVENTS = ['tool.done', 'mcp.start', 'mcp.exit', 'pause.start', 'pause.end', 'control.stop', 'control.resume'];

// A tool, action, surface or `by` name: one word from code. A result code: AN_UPPER_CASE_CODE.
const NAME = /^[A-Za-z][\w.-]{0,47}$/;
const CODE = /^[A-Z][A-Z_]{1,31}$/;
const VERSION = /^\d+\.\d+\.\d+[\w.+-]{0,24}$/;
const shaped = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);
/** An exit reason: fixed text from code, or a system error's message. One line, no escape sequences, kept short. */
const reasonText = (v: unknown): string => {
  // eslint-disable-next-line no-control-regex -- a terminal escape or a newline must not come through
  const s = typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim() : '';
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

const OUTCOMES: Record<string, { word: string; color: 'green' | 'yellow' | 'red' }> = {
  ok: { word: 'ok', color: 'green' },
  refused: { word: 'refused', color: 'yellow' },
  consent_required: { word: 'refused', color: 'yellow' },
  empty: { word: 'empty', color: 'yellow' },
  partial: { word: 'partial', color: 'yellow' },
  timeout: { word: 'failed', color: 'red' },
  error: { word: 'failed', color: 'red' },
};

const ms = (n: unknown): string => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0;
  return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
};

const clock = (ts: unknown): string => {
  const d = new Date(typeof ts === 'string' ? ts : NaN);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
};

/**
 * One day-log record as one line, or null for an event this view leaves out. `ownPid` is the daemon's: its lines say
 * "agent". Any other server says "mcp <pid>": the pid in the event when it names one (an exit the next server found),
 * else the writer's (2.0.0 writers have only the one in the event).
 */
export function formatLiveLine(r: DayLogRecord, ownPid: number, c: Colors = pc): string | null {
  const m = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>;
  const pidOf = Number.isInteger(m.pid) ? m.pid as number : Number.isInteger(r.pid) ? r.pid as number : undefined;
  const source = pidOf === ownPid ? 'agent' : pidOf !== undefined ? `mcp ${pidOf}` : 'mcp';
  let body: string;
  switch (r.msg) {
    case 'tool.done': {
      const o = OUTCOMES[String(m.outcome)] ?? OUTCOMES.error;
      const code = shaped(m.code, CODE) ?? (m.outcome === 'consent_required' ? 'CONSENT_REQUIRED' : undefined);
      const name = [shaped(m.tool, NAME) ?? '?', shaped(m.action, NAME)].filter(Boolean).join(' ');
      body = `${c.bold(name)}  ${c[o.color](o.word)}${code ? ` · ${code}` : ''}  ${c.dim(ms(m.ms))}`;
      break;
    }
    case 'mcp.start': {
      const detail = [shaped(m.surface, NAME), shaped(m.version, VERSION) && `v${m.version}`].filter(Boolean).join(', ');
      body = c.cyan(`connected${detail ? ` (${detail})` : ''}`);
      break;
    }
    case 'mcp.exit': {
      const why = reasonText(m.reason);
      body = r.level === 'warn' ? c.yellow(`left${why ? ` (${why})` : ''}`) : `left${why ? ` (${why})` : ''}`;
      break;
    }
    case 'pause.start': body = c.yellow('waiting for you'); break;
    case 'pause.end': body = `pause answered: ${shaped(m.outcome, NAME) ?? '?'}`; break;
    case 'control.stop': body = c.red(`stopped${shaped(m.by, NAME) ? ` (by ${m.by})` : ''}`); break;
    case 'control.resume': body = c.green(`resumed${shaped(m.by, NAME) ? ` (by ${m.by})` : ''}`); break;
    default: return null;
  }
  return `${c.dim(clock(r.ts))}  ${c.cyan(source.padEnd(9))}  ${body}`;
}

export interface FollowOptions {
  out: (line: string) => void;
  /** The day logs' folder (CLAWDCURSOR_LOG_DIR, else ~/.clawdcursor/logs). */
  dir?: string;
  ownPid?: number;
  colors?: Colors;
  /** The clock that picks the day's file (tests move it past midnight). */
  now?: () => Date;
  intervalMs?: number;
}

export interface LiveLog { stop(): void }

/**
 * Print what is written to the day log from now on: the file's current end is the start, the next UTC day's file
 * follows it, a rotation (the file shrank) starts over at its top, and a missing file is waited for. A line is printed
 * once it is complete. Each poll reads through one open file descriptor: the size checked is that of the file read.
 */
export function followDayLog(opts: FollowOptions): LiveLog {
  const dir = opts.dir ?? getLogDir();
  const now = opts.now ?? (() => new Date());
  const ownPid = opts.ownPid ?? process.pid;
  const colors = opts.colors ?? pc;
  const fileOf = () => path.join(dir, dayLogName(now()));

  let file = fileOf();
  let offset = 0;
  let rest = Buffer.alloc(0);

  /** Read `file` from `offset` on; with `print` false, only move to its end. */
  const read = (print: boolean): void => {
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return; }   // not written yet
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) { offset = 0; rest = Buffer.alloc(0); }   // rotated: a new file under the same name
      if (!print) { offset = size; return; }
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      // Split on the newline byte: it never occurs inside a UTF-8 character, so a character cut by the read stays whole.
      const all = Buffer.concat([rest, buf.subarray(0, n)]);
      const cut = all.lastIndexOf(0x0a);
      rest = Buffer.from(all.subarray(cut + 1));
      if (cut < 0) return;
      for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec: DayLogRecord;
        try { rec = JSON.parse(line); } catch { continue; }
        const text = rec && typeof rec === 'object' ? formatLiveLine(rec, ownPid, colors) : null;
        if (text) opts.out(text);
      }
    } finally { fs.closeSync(fd); }
  };

  const tick = (): void => {
    try {
      read(true);
      const next = fileOf();
      if (next !== file) { file = next; offset = 0; rest = Buffer.alloc(0); read(true); }   // a new day: its file from the top
    } catch { /* the live log never takes the daemon down; the next poll tries again */ }
  };

  try { read(false); } catch { /* unreadable: start at 0 */ }
  const timer = setInterval(tick, opts.intervalMs ?? 500);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * `clawdcursor agent` in a terminal: a heading, then the live log. A service or a pipe (stdout not a TTY) gets nothing
 * extra. The daemon's own events then come only through the live log, not also as the logger's terminal lines.
 */
export function startAgentLiveLog(stdout: { isTTY?: boolean; write(s: string): unknown } = process.stdout,
  opts: Omit<FollowOptions, 'out'> = {}): LiveLog | null {
  if (stdout.isTTY !== true) return null;
  const colors = opts.colors ?? pc;
  stdout.write(`${colors.dim('Live log of every clawdcursor action on this computer (Ctrl+C to stop):')}\n`);
  keepOffTerminal(LIVE_EVENTS);
  return followDayLog({ ...opts, colors, out: line => stdout.write(`${line}\n`) });
}
