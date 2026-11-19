/**
 * Refresh the guide pack as a whole. One GET of one fixed URL, at most once a week, in the background after the server
 * starts. Nothing in the request names an app: no server learns which apps a user works in. A failure keeps what is there.
 * Off with CLAWD_NO_GUIDE_REFRESH=1 (and in CI, test runs and fenced benchmark runs, like telemetry).
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../observability/logger';
import { guidePaths, validatePack, resetGuideCache, PACK_MAX_BYTES } from './store';

export const PACK_URL = 'https://clawdcursor.com/app-guides/pack.json';
export const REFRESH_EVERY_MS = 7 * 24 * 3600 * 1000;
const TIMEOUT_MS = 10_000;

export type RefreshResult = 'off' | 'recent' | 'updated' | 'kept';
export interface RefreshOptions { fetchImpl?: typeof fetch; now?: number; env?: NodeJS.ProcessEnv }

export function refreshOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWD_NO_GUIDE_REFRESH === '1' || !!(env.CI && !/^(0|false)$/i.test(env.CI)) || !!env.VITEST || env.NODE_ENV === 'test' || !!env.CLAWD_FENCE_PIDS;
}

/** The body as text, or null when it is longer than the cap (read in pieces: a huge answer is never held whole). */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PACK_MAX_BYTES) return null;
  if (!res.body) { const t = await res.text(); return t.length > PACK_MAX_BYTES ? null : t; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PACK_MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function refreshGuidePack(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const env = opts.env ?? process.env;
  if (refreshOff(env)) return 'off';
  const now = opts.now ?? Date.now();
  const { cacheFile } = guidePaths();
  const stamp = path.join(path.dirname(cacheFile), 'last-check');
  try {
    if (now - Number(fs.readFileSync(stamp, 'utf8')) < REFRESH_EVERY_MS) return 'recent';
  } catch { /* never checked */ }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(stamp, String(now));   // an attempt counts: a failing network is not retried at every start
    const res = await (opts.fetchImpl ?? fetch)(PACK_URL, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readCapped(res);
    if (text === null) throw new Error('pack is over the size cap');
    const guides = validatePack(JSON.parse(text), 'refresh');
    if (!guides || !Object.keys(guides).length) throw new Error('pack has no valid guide');
    // The cache holds only what passed: what is written is re-read through the same lint at every load.
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, generatedAt: new Date(now).toISOString(), guides }));
    fs.renameSync(tmp, cacheFile);
    resetGuideCache();
    logger.info('guide.refresh', { guides: Object.keys(guides).length });
    return 'updated';
  } catch (e) {
    logger.info('guide.refresh_failed', { why: (e as Error).message.slice(0, 80) });
    return 'kept';
  }
}

let started = false;
/** Called once the MCP server is up: a few seconds later, so it never competes with the first calls. Never throws, never blocks exit. */
export function startGuideRefresh(delayMs = 5000): void {
  if (started || refreshOff()) return;
  started = true;
  const t = setTimeout(() => { void refreshGuidePack(); }, delayMs);
  t.unref();
}
