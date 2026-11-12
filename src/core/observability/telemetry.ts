/**
 * Anonymous bug telemetry (#366): result codes, timings and clawdcursor's own stack frames, to find and fix bugs.
 *
 * On by default. Off with `clawdcursor optout`, the agent's system {action:"telemetry_optout"}, CLAWD_TELEMETRY=0,
 * DO_NOT_TRACK=1, in CI and in test runs. `clawdcursor telemetry` prints the status and every field sent.
 *
 * No call site sends anything: ONE mapper (toEvent) reads the day log's own lines (logger.ts emit) — mcp.start, tool.done,
 * mcp.exit, crash, unhandledRejection — and keeps only allowlisted fields whose values are numbers or from a closed list.
 * Everything else is dropped. Never sent: error text, typed text, clipboard, screen or OCR text, window titles, app names,
 * URLs, element names, paths outside the package, user names, emails, IP addresses. telemetry-worker/ checks it all again.
 *
 * This module must not import the logger (the logger imports it).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, getPackageRoot } from '../../paths';
import { VERSION } from '../../surface/version';
import { isBrowserProcess } from '../../platform/browser-config';
import { WEBVIEW2_APPS_PATTERN } from '../app-categories';
import { HOSTS, OUTCOMES, FAILED, ERROR_CLASSES, HELPERS, PS_BRIDGE_STEP, EXIT_REASONS, ARCHS } from './telemetry-lists';

/** Where events go: the one place to change it. A host on the project's own domain (telemetry-worker/wrangler.toml routes it). */
export const TELEMETRY_URL = 'https://telemetry.clawdcursor.com/v1/events';
export const STATE_FILE = path.join(DATA_DIR, 'telemetry.json');
/** Events queued when the process exits, sent by the next start's flush (an exit never waits on the network). */
export const SPOOL_FILE = path.join(DATA_DIR, 'telemetry-spool.jsonl');

const SLOW_CALL_MS = 10_000;
const MAX_EVENTS = 200;          // per process
const FLUSH_MS = 5_000;
const BATCH = 50;                // the Worker's limits
const MAX_BODY = 30 * 1024;      // under the Worker's 32 KB
const MAX_FRAMES = 10;

/** The fields each event may carry, besides the ones every event has. Printed by `clawdcursor telemetry`. */
export const COMMON_FIELDS = ['event', 'id', 'v', 'os'] as const;
export const SENT_FIELDS: Record<string, readonly string[]> = {
  start: ['osVer', 'arch', 'node', 'host', 'surface'],
  crash: ['kind', 'cls', 'code', 'frames'],
  exit: ['reason', 'tool', 'action', 'ms'],
  call_failed: ['tool', 'action', 'code', 'outcome', 'ms', 'app'],
  slow_call: ['tool', 'action', 'ms', 'steps'],
};

export type TelemetryEvent = Record<string, string | number | string[] | Array<Record<string, string | number>>>;

// ── State: ~/.clawdcursor/telemetry.json ──

interface State { enabled: boolean; id: string; noticeShown: boolean }
let freshId: string | null = null;

/** Each field on its own: `{"enabled":false}` alone is off. Missing or unreadable: on. No valid id: a new random one
 *  (kept for this process until the file is written). */
export function readState(file = STATE_FILE): State {
  let s: { enabled?: unknown; id?: unknown; noticeShown?: unknown } | null = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing or unreadable */ }
  const id = typeof s?.id === 'string' && /^[0-9a-f-]{36}$/.test(s.id) ? s.id : (freshId ??= randomUUID());
  return { enabled: s?.enabled !== false, id, noticeShown: s?.noticeShown === true };
}

/** Written to a temp file and renamed over: another process never reads a half-written file (and takes it for "on"). */
function writeState(patch: Partial<State>, file = STATE_FILE): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...readState(file), ...patch }, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { fs.rmSync(tmp, { force: true }); return false; }
}

/** `clawdcursor optout` / `optin` and the agent's telemetry_optout. False when the file could not be written. */
export function setTelemetryEnabled(enabled: boolean, file = STATE_FILE): boolean {
  if (!enabled) { queue.length = 0; fs.rmSync(SPOOL_FILE, { force: true }); }   // nothing already queued goes out either
  return writeState({ enabled }, file);
}

/** Why telemetry is off, or null when it is on. The environment wins over the file. */
export function offReason(env: NodeJS.ProcessEnv = process.env, file = STATE_FILE): string | null {
  if (/^(0|off|false|no)$/i.test(env.CLAWD_TELEMETRY ?? '')) return 'CLAWD_TELEMETRY';
  if (/^(1|true|yes)$/i.test(env.DO_NOT_TRACK ?? '')) return 'DO_NOT_TRACK';
  if (env.CI && !/^(0|false)$/i.test(env.CI)) return 'CI';
  if (env.VITEST || env.NODE_ENV === 'test') return 'test run';
  if (!readState(file).enabled) return 'clawdcursor optout';
  return null;
}

// ── The mapper: day-log line → event, or nothing ──

/** Tool and action names this server registered (mcp-server.ts): a closed list from code. Anything else is "other". */
const knownNames = new Set<string>();
export function allowNames(names: Iterable<string>): void { for (const n of names) knownNames.add(n); }

let host = 'unknown';
/** The MCP client's name, from its initialize request, reduced to the allowlist. Fills the start event if it is still queued. */
export function setHost(clientName: string | undefined): void {
  if (!clientName) return;
  const n = clientName.toLowerCase();
  host = HOSTS.find(([re]) => re.test(n))?.[1] ?? 'other';
  for (const e of queue) if (e.event === 'start') e.host = host;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(0, Math.round(v)), 2 ** 31 - 1) : undefined);
const name = (v: unknown): string | undefined => (typeof v !== 'string' || !v ? undefined : knownNames.has(v) ? v : 'other');
const codeOf = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);
/** Only the fields that have a value. */
const pick = (o: Record<string, unknown>): TelemetryEvent =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as TelemetryEvent;

function appKind(app: unknown): string {
  if (typeof app !== 'string' || !app) return 'unknown';
  if (isBrowserProcess(app)) return 'browser';
  return WEBVIEW2_APPS_PATTERN.test(app) ? 'electron' : 'native';
}

function osMajor(): number {
  const r = os.release();   // win32 "10.0.26100", darwin "24.1.0" (Darwin major), linux "6.8.0-45-generic"
  if (process.platform === 'win32') return Number(r.split('.')[2]) >= 22000 ? 11 : 10;
  return parseInt(r, 10) || 0;
}

/** Package-relative paths: the root as it is, and with the home folder as `~` (the crash log's stacks are home-stripped). */
function packageRoots(): string[] {
  const root = getPackageRoot().replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  return [...new Set([root, root.split(home).join('~')])];
}

/** A stack reduced to clawdcursor's own frames as "dist/x/y.js:LINE". Frames outside the package (Node, dependencies) are dropped. */
export function reduceStack(stack: unknown, roots = packageRoots()): string[] {
  const out: string[] = [];
  for (const line of String(stack ?? '').split('\n')) {
    const m = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1].replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/');
    const root = roots.find(r => file.startsWith(r + '/'));
    if (!root) continue;
    const rel = file.slice(root.length + 1);
    if (rel.includes('node_modules/') || !/^[\w.-]{1,40}(\/[\w.-]{1,60}){0,6}\.(js|ts|cjs|mjs)$/.test(rel)) continue;
    out.push(`${rel}:${m[2]}`);
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/** The allowlisting mapper. A day-log line in, an event or null out. */
export function toEvent(msg: string, meta: Record<string, unknown> | undefined): TelemetryEvent | null {
  const m = meta ?? {};
  const base = { event: '', v: VERSION, os: ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'other' };
  switch (msg) {
    case 'mcp.start':
      return pick({ ...base, event: 'start', osVer: osMajor(), arch: ARCHS.includes(process.arch) ? process.arch : 'other',
        node: Number(process.versions.node.split('.')[0]), host, surface: m.surface === 'compact' ? 'compact' : 'granular' });
    case 'crash':
    case 'unhandledRejection':
      return pick({ ...base, event: 'crash', kind: msg === 'crash' ? 'uncaught' : 'rejection',
        cls: typeof m.name === 'string' && ERROR_CLASSES.includes(m.name) ? m.name : 'other',
        code: codeOf(m.code, /^(E[A-Z0-9]{1,20}|ERR_[A-Z0-9_]{1,40})$/), frames: reduceStack(m.stack) });
    case 'mcp.exit': {
      // A clean exit with nothing running is not a bug: only an exit that cut a call off, or one found unclean at the next start.
      // Found at the next start, only the last call that FINISHED is known, not the one cut off: the reason goes alone.
      if (!m.cutOff && !m.detectedAt) return null;
      const reason = String(m.reason ?? '');
      const cut = (m.cutOff ?? {}) as Record<string, unknown>;
      return pick({ ...base, event: 'exit', reason: EXIT_REASONS.find(([re]) => re.test(reason))?.[1] ?? 'other',
        tool: name(cut.tool), action: name(cut.action), ms: num(cut.ranMs) });
    }
    case 'tool.done': {
      const outcome = typeof m.outcome === 'string' && OUTCOMES.includes(m.outcome) ? m.outcome : 'error';
      const ms = num(m.ms) ?? 0;
      const call = { tool: name(m.tool) ?? 'other', action: name(m.action), ms };
      if (FAILED.includes(outcome)) {
        return pick({ ...base, event: 'call_failed', ...call, code: codeOf(m.code, /^[A-Z][A-Z_]{1,23}$/), outcome, app: appKind(m.app) });
      }
      if (ms > SLOW_CALL_MS) {
        const steps = Object.entries((m.steps ?? {}) as Record<string, { n?: unknown; ms?: unknown }>)
          .map(([step, t]) => ({ name: PS_BRIDGE_STEP.test(step) || HELPERS.includes(step) ? step : 'other', ms: num(t?.ms) ?? 0, n: num(t?.n) ?? 0 }))
          .filter(s => s.ms >= 1000).sort((a, b) => b.ms - a.ms).slice(0, 10);
        return pick({ ...base, event: 'slow_call', ...call, steps });
      }
      return null;
    }
    default:
      return null;
  }
}

// ── Queue and sender ──

export type Sender = (url: string, body: string) => Promise<void>;
const fetchSender: Sender = async (url, body) => {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
};
let sender: Sender = fetchSender;
/** Tests pass their own sender (null = the real one). */
export function __setSenderForTests(s: Sender | null): void { sender = s ?? fetchSender; }

const queue: TelemetryEvent[] = [];
let taken = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Called by logger.ts for every day-log line. Never throws, never waits. */
export function observe(msg: string, meta: Record<string, unknown> | undefined): void {
  try {
    const event = toEvent(msg, meta);
    if (!event || taken >= MAX_EVENTS || offReason() !== null) return;
    taken++;
    const state = readState();
    if (!state.noticeShown) {
      // stderr: stdout is the MCP channel.
      process.stderr.write('[clawdcursor] Sends anonymous error reports (error codes and clawdcursor\'s own file:line, never screen content) to help fix bugs. Turn off: clawdcursor optout\n');
      writeState({ noticeShown: true, id: state.id });
    }
    queue.push(event);
    if (!timer) { timer = setTimeout(() => { void flush(); }, FLUSH_MS); timer.unref(); }
  } catch { /* telemetry must never break anything */ }
}

/** Send what is queued, in batches the Worker accepts. Never throws. */
export async function flush(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const events = [...takeSpool(), ...queue.splice(0)];
  if (!events.length || offReason() !== null) return;
  const id = readState().id;
  let batch: string[] = [];
  let size = 2;
  const send = async () => { if (batch.length) await sender(TELEMETRY_URL, `[${batch.join(',')}]`).catch(() => {}); batch = []; size = 2; };
  for (const e of events) {
    const json = JSON.stringify({ ...e, id });
    if (batch.length >= BATCH || size + json.length + 1 > MAX_BODY) await send();
    batch.push(json);
    size += json.length + 1;
  }
  await send();
}

/** At any exit, a crash included: keep what is queued for the next start. Synchronous, so the process exits at once. */
export function spoolBeforeExit(file = SPOOL_FILE): void {
  try {
    clearTimeout(timer);
    const events = queue.splice(0);
    if (events.length && offReason() === null) fs.appendFileSync(file, events.map(e => JSON.stringify(e) + '\n').join(''));
  } catch { /* telemetry must never break an exit */ }
}

/** What earlier processes spooled. Renamed first, so two starting servers never both send it. */
function takeSpool(file = SPOOL_FILE): TelemetryEvent[] {
  const mine = `${file}.${process.pid}`;
  try { fs.renameSync(file, mine); } catch { return []; }
  try {
    return fs.readFileSync(mine, 'utf8').split('\n').filter(Boolean).slice(0, MAX_EVENTS).map(l => JSON.parse(l) as TelemetryEvent);
  } catch { return []; } finally { fs.rmSync(mine, { force: true }); }
}

/** What `clawdcursor telemetry` prints. */
export function telemetryStatusText(): string {
  const off = offReason();
  return [
    `Anonymous error reports: ${off ? `off (${off})` : 'on'}`,
    `Sent to ${TELEMETRY_URL} (a Cloudflare Worker: no IP address stored, kept 90 days).`,
    '',
    `Every event: ${COMMON_FIELDS.join(', ')} (id is random, made on this machine; v is the clawdcursor version)`,
    ...Object.entries(SENT_FIELDS).map(([e, f]) => `  ${e.padEnd(12)} ${f.join(', ')}`),
    'Every value is a number or one of a fixed list; tool and action are clawdcursor\'s own names; frames are clawdcursor\'s own file:line.',
    '',
    'Never sent: error text, typed text, clipboard, screen or OCR text, window titles, app names, URLs, element names,',
    'file paths outside clawdcursor, user names, emails, IP addresses.',
    '',
    'Turn off: clawdcursor optout (or CLAWD_TELEMETRY=0, DO_NOT_TRACK=1)   Turn on: clawdcursor optin',
  ].join('\n');
}
