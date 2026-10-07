#!/usr/bin/env node
/**
 * Bundle the CLI into one file: dist/surface/cli.js (in place, after tsc).
 *
 * Why: an MCP host gives a server ~30 s to answer `initialize`. Unbundled, a
 * start loads ~840 small files (zod, ajv, semver, the MCP SDK, express…); on
 * a cold Windows disk with Defender scanning each one that took 15–25 s, and
 * Claude Code dropped the server. One bundled file makes the cold start
 * mostly a single read.
 *
 * Kept EXTERNAL (loaded from node_modules as before):
 *   - native addons: @nut-tree-fork/* (libnut), sharp (libvips)
 *   - packages that locate their own files/binaries at runtime: playwright,
 *     playwright-core, clipboardy (fallback exes)
 *   - ws's optional native accelerators
 * Lazy `await import()` sites stay lazy — esbuild keeps them as deferred
 * module initialisers, so platform code still loads only on the OS that
 * needs it.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Bundle from the TypeScript source, not tsc's output: tsc turns
// `import('@modelcontextprotocol/sdk/…' as string)` (written that way to dodge
// node10 type resolution) into a require of a computed string that a bundler
// can't follow, which left the SDK — and zod/ajv under it — unbundled.
const src = path.join(root, 'src', 'surface', 'cli.ts');
const entry = path.join(root, 'dist', 'surface', 'cli.js');

const tmp = path.join(root, 'dist', 'surface', 'cli.bundle.tmp.js');
const result = await build({
  entryPoints: [src],
  tsconfig: path.join(root, 'tsconfig.json'),
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  legalComments: 'none',
  external: [
    '@nut-tree-fork/*', 'sharp', 'playwright', 'playwright-core', 'clipboardy',
    'bufferutil', 'utf-8-validate',
  ],
});
if (result.errors.length) process.exit(1);

// Keep the shebang exactly once (tsc's output carries it; esbuild preserves it).
let code = fs.readFileSync(tmp, 'utf8');
if (!code.startsWith('#!')) code = '#!/usr/bin/env node\n' + code;
fs.writeFileSync(entry, code);
fs.rmSync(tmp, { force: true });
console.log(`bundle-cli: dist/surface/cli.js — ${(code.length / 1024).toFixed(0)} KB, one file`);
