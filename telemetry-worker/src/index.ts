/**
 * clawdcursor bug telemetry receiver (Cloudflare Worker + D1). A trust boundary: anyone can POST here, so every event is
 * checked field by field against the same lists the client uses (src/core/observability/telemetry-lists.ts). An event with
 * an unknown field, a wrong type or a value outside its list is dropped. The client's IP address and request headers are
 * never read or stored; the only time kept is the server's own receive time. Events older than 90 days are deleted daily.
 */

import { HOSTS, FAILED, ERROR_CLASSES, HELPERS, PS_BRIDGE_STEP, EXIT_REASONS, ARCHS, APP_KINDS, NAME as NAME_RE } from '../../src/core/observability/telemetry-lists';

interface D1Statement { bind(...values: unknown[]): D1Statement; run(): Promise<unknown> }
interface D1Database { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown> }
export interface Env { DB: D1Database }

export const MAX_EVENTS = 50;
export const MAX_BODY = 32 * 1024;
const RETENTION_MS = 90 * 24 * 3600 * 1000;

type Rule = (v: unknown) => boolean;
const oneOf = (...list: string[]): Rule => v => typeof v === 'string' && list.includes(v);
const match = (re: RegExp): Rule => v => typeof v === 'string' && re.test(v);
const int = (max: number): Rule => v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const list = (rule: Rule, max: number): Rule => v => Array.isArray(v) && v.length <= max && v.every(rule);
const record = (fields: Record<string, Rule>): Rule => v =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === Object.keys(fields).length
  && Object.entries(fields).every(([k, r]) => r((v as Record<string, unknown>)[k]));

/** src/core/result-codes.ts ResultCode (a test fails when the two differ). */
export const RESULT_CODES = ['CONSENT_REQUIRED', 'KEYBOARD_OWNED', 'SECURE_INPUT', 'SCREEN_LOCKED', 'CAPTURE_DENIED', 'VISION_DISABLED',
  'OWN_UI', 'PAUSED', 'NOT_CONFIRMED', 'DANGEROUS_KEY', 'STOPPED', 'FOREGROUND_CHANGED', 'FENCED', 'CROSS_ORIGIN_FRAME', 'INVALID_ARGS', 'READBACK_MISMATCH', 'REPEATED',
  'STALE_SCREENSHOT', 'DEVIATION', 'STALE_REF', 'TIMEOUT', 'NOT_FOUND', 'UNSUPPORTED_ACTION', 'ELEMENT_HIDDEN', 'AMBIGUOUS',
  'ACTION_FAILED', 'NOT_CONNECTED', 'UNKNOWN'];

const NUM = int(2 ** 31 - 1);   // the client clamps to this
const NAME = match(NAME_RE);
const own = <T>(o: Record<string, T>, k: string): T | null => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);
const COMMON: Record<string, Rule> = {
  id: match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  v: match(/^\d{1,3}\.\d{1,3}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/),
  os: oneOf('win32', 'darwin', 'linux', 'other'),
};

/** Per event: field → [rule, required]. */
const EVENTS: Record<string, Record<string, [Rule, boolean]>> = {
  start: {
    osVer: [int(1000), true], arch: [oneOf(...ARCHS, 'other'), true], node: [int(1000), true],
    host: [oneOf(...HOSTS.map(([, h]) => h), 'other', 'unknown'), true],
    surface: [oneOf('compact', 'granular'), true],
  },
  crash: {
    kind: [oneOf('uncaught', 'rejection'), true],
    cls: [oneOf(...ERROR_CLASSES, 'other'), true],
    code: [match(/^(E[A-Z0-9]{1,20}|ERR_[A-Z0-9_]{1,40})$/), false],
    frames: [list(match(/^[\w.-]{1,40}(\/[\w.-]{1,60}){0,6}\.(js|ts|cjs|mjs):\d{1,7}$/), 10), true],
  },
  exit: {
    reason: [oneOf(...EXIT_REASONS.map(([, r]) => r), 'other'), true],
    tool: [NAME, false], action: [NAME, false], ms: [NUM, false],
  },
  call_failed: {
    tool: [NAME, true], action: [NAME, false], code: [oneOf(...RESULT_CODES), false],
    outcome: [oneOf(...FAILED), true], ms: [NUM, true], app: [oneOf(...APP_KINDS), true],
  },
  slow_call: {
    tool: [NAME, true], action: [NAME, false], ms: [NUM, true],
    steps: [list(record({ name: v => oneOf(...HELPERS, 'other')(v) || match(PS_BRIDGE_STEP)(v), ms: NUM, n: NUM }), 10), true],
  },
};

export type Event = Record<string, unknown> & { event: string; id: string; v: string; os: string };

/** One event: every field known, of the right type and value, nothing missing that is required. */
export function validEvent(e: unknown): e is Event {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  // Own properties only: "constructor" or "toString" must not find Object.prototype's members and pass as a rule.
  const fields = typeof o.event === 'string' ? own(EVENTS, o.event) : null;
  if (!fields) return false;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'event') continue;
    const rule = own(COMMON, k) ?? own(fields, k)?.[0];
    if (!rule || !rule(v)) return false;
  }
  return Object.keys(COMMON).every(k => k in o) && Object.entries(fields).every(([k, [, required]]) => !required || k in o);
}

/** A request body: the valid events in it, or null when the body itself is wrong (not a JSON array, too big, too many). */
export function validate(body: string): Event[] | null {
  if (new TextEncoder().encode(body).length > MAX_BODY) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length > MAX_EVENTS) return null;
  return parsed.filter(validEvent);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/v1/events') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    // Before reading: a body declared too big is never buffered. The check after the read catches one that is not declared.
    if (Number(request.headers.get('content-length')) > MAX_BODY) return new Response(null, { status: 413 });
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY) return new Response(null, { status: 413 });
    const events = validate(new TextDecoder().decode(raw));
    if (!events) return new Response(null, { status: 400 });
    if (events.length) {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const insert = env.DB.prepare('INSERT INTO events (received_at, day, event, install_id, version, os, tool, action, code, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      await env.DB.batch(events.map(e => {
        const { event, id, v, os, tool, action, code, ...rest } = e;
        return insert.bind(now, day, event, id, v, os, tool ?? null, action ?? null, code ?? null, JSON.stringify(rest));
      }));
    }
    return new Response(null, { status: 204 });
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await env.DB.prepare('DELETE FROM events WHERE received_at < ?').bind(Date.now() - RETENTION_MS).run();
  },
};
