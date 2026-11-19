/**
 * App guides: where they are read from, and which one fits an app or site.
 *
 * The guides are the pack bundled in the npm package (dist/guides/pack.json).
 * Every guide passes the lint (lint.ts), which accepts v2 guides only; one that fails is skipped and logged, never shown.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPackageRoot } from '../../paths';
import { logger } from '../observability/logger';
import { lintGuide, type Guide } from './lint';

export interface LoadedGuide { id: string; guide: Guide }

export const PACK_MAX_BYTES = 2 * 1024 * 1024;

interface Paths { bundledFile: string }
const defaultPaths = (): Paths => ({
  bundledFile: path.join(getPackageRoot(), 'dist', 'guides', 'pack.json'),
});
let paths: Paths | null = null;
export const guidePaths = (): Paths => (paths ??= defaultPaths());
/** Tests point the store at a temp directory (null = the real one). */
export function __setGuidePathsForTests(p: Paths | null): void { paths = p; cache = null; }

let cache: Map<string, LoadedGuide> | null = null;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The guides of a pack that pass the lint. A guide whose own `app` names another app is skipped. */
export function validatePack(raw: unknown, from: string): Record<string, Guide> | null {
  if (!isObj(raw) || raw.schemaVersion !== 2 || !isObj(raw.guides)) return null;
  const out: Record<string, Guide> = {};
  for (const [id, g] of Object.entries(raw.guides)) {
    const bad = !lintGuide(g).ok || (g as Guide).app !== id;
    if (bad) { logger.info('guide.skipped', { from, app: id }); continue; }
    out[id] = g as unknown as Guide;
  }
  return out;
}

function readPack(file: string, from: string): Record<string, Guide> {
  try {
    if (fs.statSync(file).size > PACK_MAX_BYTES) return {};
    return validatePack(JSON.parse(fs.readFileSync(file, 'utf8')), from) ?? {};
  } catch { return {}; }
}

export function loadGuides(): Map<string, LoadedGuide> {
  if (cache) return cache;
  const p = guidePaths();
  const all = new Map<string, LoadedGuide>();
  for (const [id, guide] of Object.entries(readPack(p.bundledFile, 'bundled'))) all.set(id, { id, guide });
  return (cache = all);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.exe$/, '').replace(/^www\./, '').replace(/\/+$/, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Candidate identifiers in free text: the text, its words, and the host of anything that parses as a URL. */
export function termsOf(text: string): string[] {
  const out = new Set<string>();
  const t = text.trim();
  if (t) out.add(t);
  for (const w of t.split(/[\s|,;]+/)) {
    if (!w) continue;
    out.add(w);
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : `https://${w}`);
      if (u.hostname) { out.add(u.hostname); out.add(u.hostname + u.pathname); }
    } catch { /* not a URL */ }
  }
  return [...out];
}

/** How well `term` (a host, or host + path) fits a domain hint (a host, or host + path prefix): 0 = not at all, a longer matching path prefix scores higher. */
function hintScore(term: string, hint: string): number {
  const split = (x: string) => { const [host, ...segs] = norm(x).split('/').filter(Boolean); return { host: host ?? '', segs }; };
  const t = split(term), h = split(hint);
  // "*.atlassian.net" = any subdomain (not the bare domain); otherwise the host must be equal. Then the path prefix, segment-wise.
  const hostOk = h.host.startsWith('*.') ? t.host.endsWith(h.host.slice(1)) && t.host.length > h.host.length - 1 : t.host === h.host;
  return hostOk && h.segs.every((seg, i) => t.segs[i] === seg) ? 1 + h.segs.length : 0;
}

/**
 * The guide for an app or site: `terms` equal its id, its name, a process name, or a domain hint (a subdomain of one
 * counts); `title` (a window title) is the weaker second try: the guide's name as a whole word. A guide written for
 * other OSes only is not an answer here.
 */
export function findGuide(terms: string[], title?: string, platform: string = process.platform): LoadedGuide | undefined {
  const usable = [...loadGuides().values()].filter(l => !l.guide.os || l.guide.os.includes(platform));
  const ts = terms.map(norm).filter(Boolean);
  // Id, name or process name first; then the best domain hint (the longest matching path prefix wins when guides share a host).
  let byTerm = usable.find(({ id, guide }) => ts.some(t => t === id || t === norm(guide.name ?? guide.app) || (guide.processNames ?? []).some(p => norm(p) === t)));
  if (!byTerm) {
    let best = 0;
    for (const l of usable) {
      const score = Math.max(0, ...(l.guide.domainHints ?? []).flatMap(h => ts.map(t => hintScore(t, h))));
      if (score > best) { best = score; byTerm = l; }
    }
  }
  if (byTerm || !title) return byTerm;
  return usable.find(({ guide }) => {
    const n = (guide.name ?? guide.app).trim();
    return n.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu').test(title);
  });
}
