#!/usr/bin/env node
/**
 * Build the app-guide pack: one JSON file holding every verified guide that passes the client lint.
 *
 *   node scripts/build-guide-pack.mjs [--src docs/app-guides] [--out docs/app-guides/pack.json]
 *
 * The pack ships inside the npm package (dist/guides/pack.json, built by postbuild) and is mirrored at
 * https://clawdcursor.com/app-guides/pack.json (built by sync-guides.yml), where the client refreshes it as a whole.
 * Only guides that index.json marks `trust: "verified"` go in; a guide that fails the lint is left out and named.
 * The lint is the client's own (src/core/guides/lint.ts, compiled to dist/): build first (`npx tsc`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * { schemaVersion: 2, generatedAt, guides: { app: guide } } from `srcDir` (index.json + <app>.json files).
 * `lint(guide)` returns { ok, errors }. Returns { pack, skipped: [{ app, why }] }.
 */
export function buildGuidePack(srcDir, lint, now = new Date()) {
  const index = JSON.parse(fs.readFileSync(path.join(srcDir, 'index.json'), 'utf8'));
  const guides = {};
  const skipped = [];
  for (const [app, meta] of Object.entries(index.guides ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (meta?.trust !== 'verified') { skipped.push({ app, why: `trust is ${JSON.stringify(meta?.trust)}, not "verified"` }); continue; }
    let guide;
    try { guide = JSON.parse(fs.readFileSync(path.join(srcDir, `${app}.json`), 'utf8')); }
    catch (e) { skipped.push({ app, why: `unreadable: ${e.message}` }); continue; }
    const r = lint(guide);
    if (!r.ok) { skipped.push({ app, why: r.errors.slice(0, 3).join('; ') }); continue; }
    guides[app] = guide;
  }
  return { pack: { schemaVersion: 2, generatedAt: now.toISOString(), guides }, skipped };
}

function main() {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
  const srcDir = path.resolve(root, arg('--src', 'docs/app-guides'));
  const out = path.resolve(root, arg('--out', 'docs/app-guides/pack.json'));
  const { lintGuide } = createRequire(import.meta.url)(path.join(root, 'dist', 'core', 'guides', 'lint.js'));
  const { pack, skipped } = buildGuidePack(srcDir, g => lintGuide(g));
  for (const s of skipped) console.warn(`guide pack: left out ${s.app}: ${s.why}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(pack));
  console.log(`guide pack: ${Object.keys(pack.guides).length} guides -> ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
