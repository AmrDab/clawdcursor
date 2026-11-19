/**
 * Guides an agent saves with the user's OK: build and lint the guide, merge it into ~/.clawdcursor/guides/<app>.json,
 * and make the prefilled "suggest it" link. The asking is the tool's (tools/shortcuts.ts save_guide).
 */

import * as fs from 'fs';
import * as path from 'path';
import { lintGuide, type Guide } from './lint';
import { guidePaths, mergeGuide, resetGuideCache } from './store';

export const SUGGEST_URL = 'https://github.com/AmrDab/clawdcursor-guides/issues/new';
export const SUGGEST_MAX_URL = 6000;
const FIELDS = ['app', 'name', 'kind', 'os', 'domainHints', 'processNames', 'shortcuts', 'consequential', 'tips', 'workflows'] as const;

/** An object or array argument may arrive as its JSON text (the MCP convention in this server). */
const fromJsonText = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

/** The guide an agent described, only the v2 fields it may set, checked with the local caps. */
export function prepareGuide(args: Record<string, unknown>): { guide: Guide } | { error: string } {
  const guide: Record<string, unknown> = {};
  for (const f of FIELDS) if (args[f] !== undefined && args[f] !== null) guide[f] = f === 'app' || f === 'name' || f === 'kind' ? args[f] : fromJsonText(args[f]);
  const r = lintGuide(guide, { local: true });
  if (!r.ok) return { error: `the guide does not pass the lint: ${r.errors.slice(0, 4).join('; ')}` };
  return { guide: guide as unknown as Guide };
}

const fileFor = (app: string) => path.join(guidePaths().localDir, `${app}.json`);

/** Merge into the saved guide of the app (the new shortcut wins over an earlier one). Returns the file, or an error. */
export function saveLocalGuide(guide: Guide): { file: string } | { error: string } {
  const file = fileFor(guide.app);
  let merged = guide;
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8')) as Guide;
    if (lintGuide(old, { local: true }).ok) merged = mergeGuide(old, guide);
  } catch { /* nothing saved yet */ }
  const r = lintGuide(merged, { local: true });
  if (!r.ok) return { error: `saved and new shortcuts together do not fit the local limits: ${r.errors.slice(0, 3).join('; ')}` };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { return { error: `could not write ${file}: ${(e as Error).message}` }; }
  resetGuideCache();
  return { file };
}

/** The prefilled issue form of the guides repo, or null when it would not fit in a link. */
export function suggestUrl(guide: Guide): string | null {
  const url = `${SUGGEST_URL}?${new URLSearchParams({
    template: 'guide-suggestion.yml', title: `Guide suggestion: ${guide.app}`, app: `${guide.name ?? guide.app} (${guide.app})`, guide: JSON.stringify(guide, null, 2),
  }).toString()}`;
  return url.length <= SUGGEST_MAX_URL ? url : null;
}
