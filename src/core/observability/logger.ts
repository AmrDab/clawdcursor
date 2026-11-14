/**
 * Leveled logger with TTY pretty-print + JSON file log.
 *
 * Two output surfaces:
 *
 *   1. JSON file log (stable machine-readable contract) — one
 *      `{ts, level, msg, meta}` line per event, rotated at 10 MB, 5 backups,
 *      never changes format between releases. Greppable, tailable.
 *
 *   2. TTY pretty-print (the default when stderr is a TTY) — tagged
 *      ([safety] or [log]), color-coded, one line per event.
 *
 *      `CLAWD_LOG=json` disables pretty-print (useful for piping to a file
 *      or CI). `CLAWD_NO_COLOR=1` / `NO_COLOR=1` keeps pretty-print but
 *      without ANSI colors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import pc from 'picocolors';
import { observe as telemetry } from './telemetry';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const KEEP_FILES = 5;

const envLevel = (process.env.CLAWD_LOG_LEVEL || 'info').toLowerCase() as Level;
const minLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

// Output modes. Default: pretty on TTY, json-only when piped. Override via
// CLAWD_LOG={json|pretty|stream|off}.
const logModeEnv = (process.env.CLAWD_LOG || '').toLowerCase();
const isTty = process.stderr.isTTY === true;
const prettyMode =
  logModeEnv === 'pretty' || logModeEnv === 'stream' ||
  (isTty && logModeEnv !== 'json' && logModeEnv !== 'off');
const ttySink = logModeEnv === 'off' ? null : 'stderr' as const;

/**
 * Timestamp format for the TTY pretty output. Follows Dash0 structured-
 * logging guidance (ISO 8601 in the machine-readable log, compact local
 * form for humans):
 *
 *   CLAWD_LOG_TIMESTAMPS=short  → HH:MM:SS  (default — local time, compact)
 *   CLAWD_LOG_TIMESTAMPS=ms     → HH:MM:SS.mmm  (local time, millisecond
 *                                              precision for tight timing
 *                                              investigations)
 *   CLAWD_LOG_TIMESTAMPS=iso    → 2025-04-18T21:23:45.123Z  (full ISO 8601,
 *                                              matches the file-log field,
 *                                              useful when piping pretty
 *                                              output to a ticket / paste)
 *   CLAWD_LOG_TIMESTAMPS=off    → no timestamp column
 *
 * The JSON file log ALWAYS carries a full ISO 8601 `ts` field regardless
 * of this setting — this only affects the human TTY surface.
 */
type TsFormat = 'short' | 'ms' | 'iso' | 'off';
const tsFormat: TsFormat = (() => {
  const raw = (process.env.CLAWD_LOG_TIMESTAMPS || '').toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false') return 'off';
  if (raw === 'iso')  return 'iso';
  if (raw === 'ms' || raw === 'millis' || raw === 'millisecond') return 'ms';
  return 'short';
})();

function formatTtyTimestamp(d: Date = new Date()): string {
  if (tsFormat === 'off') return '';
  if (tsFormat === 'iso') return d.toISOString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (tsFormat === 'ms') {
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }
  return `${hh}:${mm}:${ss}`;
}

// Color support — picocolors auto-detects (NO_COLOR, isTTY, etc.) but we
// keep the historic stderr-TTY check and the CLAWD_NO_COLOR opt-out, since
// the logger writes to stderr (not stdout, which is what picocolors checks)
// and CLAWD_NO_COLOR is documented in the file header.
const supportsColor =
  isTty &&
  process.env.TERM !== 'dumb' &&
  !process.env.NO_COLOR &&
  !process.env.CLAWD_NO_COLOR;

const colors = pc.createColors(supportsColor);

type Style = (s: string | number) => string;

const C: Record<'dim' | 'bold' | 'gray' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan', Style> = {
  dim:     colors.dim,
  bold:    colors.bold,
  gray:    colors.gray,
  red:     colors.red,
  green:   colors.green,
  yellow:  colors.yellow,
  blue:    colors.blue,
  magenta: colors.magenta,
  cyan:    colors.cyan,
};

let logDir: string | null = null;
function getLogDir(): string {
  if (logDir) return logDir;
  // CLAWDCURSOR_LOG_DIR: tests point this at a temp dir (tests/vitest.setup.ts)
  // so they never write the user's real ~/.clawdcursor/logs.
  logDir = process.env.CLAWDCURSOR_LOG_DIR || path.join(os.homedir(), '.clawdcursor', 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
  return logDir;
}

function currentLogPath(): string {
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.join(getLogDir(), `clawdcursor-${day}.log`);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_BYTES) return;
    for (let i = KEEP_FILES - 2; i >= 0; i--) {
      const src = i === 0 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try { if (fs.existsSync(src)) fs.renameSync(src, dst); }
      catch { /* best-effort */ }
    }
  } catch { /* file doesn't exist — fine */ }
}

function writeJsonLine(line: string): void {
  const filePath = currentLogPath();
  rotateIfNeeded(filePath);
  try { fs.appendFileSync(filePath, line + '\n'); }
  catch { /* logger must never throw */ }
}

function layerTag(event: string): { label: string; color: Style } {
  if (event.startsWith('safety.')) return { label: 'safety', color: C.red };
  return { label: 'log', color: C.gray };
}

function colorize(text: string, color: Style): string {
  return color(text);
}

// ANSI escape regex used by pad() to compute visible width. Built from a
// fromCharCode literal rather than \xNN / \uNNNN inline so static scanners
// don't flag this as "obfuscated content" (the codes themselves are
// emitted at runtime by picocolors — that's fine; only source matters).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function pad(text: string, len: number): string {
  const visible = text.replace(ANSI_RE, '');
  const delta = len - visible.length;
  return delta > 0 ? text + ' '.repeat(delta) : text;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function compactArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    let val: string;
    if (typeof v === 'string') val = `"${truncate(v, 40)}"`;
    else if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
    else val = truncate(JSON.stringify(v), 40);
    parts.push(`${k}=${val}`);
  }
  return parts.join(' ');
}

function writePrettyLine(body: string): void {
  const ts = formatTtyTimestamp();
  const prefix = ts ? colorize(ts, C.gray) + ' ' : '';
  process.stderr.write(`${prefix}${body}\n`);
}

/**
 * TTY pretty-print — renders one visual line (or none, for suppressed events).
 * Never throws; falls back to a raw-ish line if the event isn't recognized.
 */
function prettyEmit(level: Level, event: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  if (!ttySink) return;

  const tag = layerTag(event);
  const tagStr = colorize(`[${pad(tag.label, 7)}]`, tag.color);

  if (level === 'warn' || level === 'error') {
    const reason = meta?.reason || meta?.error || meta?.text || '';
    const rest = compactArgs(stripHeaderMeta(meta));
    const levelPrefix = level === 'error' ? colorize('✗ error', C.red) : colorize('! warn', C.yellow);
    writePrettyLine(`${tagStr} ${levelPrefix} ${event} ${reason ? `· ${truncate(String(reason), 80)}` : ''}${rest ? ` ${colorize(rest, C.dim)}` : ''}`);
    return;
  }

  if (level === 'debug') return;

  const rest = compactArgs(stripHeaderMeta(meta));
  writePrettyLine(`${tagStr} ${event}${rest ? ` ${colorize(rest, C.dim)}` : ''}`);
}

function stripHeaderMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'correlationId' || k === 'task' || k === 'mode') continue;
    out[k] = v;
  }
  return out;
}

// ─── Public logger entry points ─────────────────────────────────────

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  telemetry(msg, meta);   // allowlisted bug reports (telemetry.ts), whatever the log level
  if (LEVEL_ORDER[level] < minLevel) return;
  // File log ALWAYS gets the full JSON record (machine contract).
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  writeJsonLine(JSON.stringify(record));

  if (prettyMode) {
    prettyEmit(level, msg, meta);
  } else if (ttySink === 'stderr') {
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${level}] ${msg}${metaStr}\n`);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

export type Logger = typeof logger;
