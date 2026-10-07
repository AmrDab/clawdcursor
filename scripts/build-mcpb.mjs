#!/usr/bin/env node
/**
 * Build the Claude Desktop extension for THIS OS:
 *   build/mcpb/clawdcursor-<win32|darwin|linux>.mcpb
 *
 * Claude Desktop runs it with its own Node, so users need no terminal, no npm
 * and no JSON editing. One bundle per OS, built natively on that OS (the
 * release workflow runs this on Windows, macOS and Linux runners):
 *   - sharp's native build is per platform (~18 MB each) — a universal bundle
 *     carried six of them (75 MB); each OS bundle carries its x64 + arm64;
 *   - the macOS screen/permission helper (native/ClawdCursor.app) only builds
 *     on a Mac.
 * Consent is asked on the install screen and passed as CLAWDCURSOR_CONSENT.
 *
 * Usage:  npm run build && node scripts/build-mcpb.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'build', 'mcpb');
const stage = path.join(outDir, 'clawdcursor');
const os = process.platform;
// No version in the file name: releases/latest/download/clawdcursor-<os>.mcpb
// stays a stable link (the version lives in the manifest).
const outFile = path.join(outDir, `clawdcursor-${os}.mcpb`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args, cwd) => execFileSync(cmd, args, {
  cwd, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
});
const copy = (rel) => {
  const from = path.join(root, rel);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, rel), { recursive: true });
};

// sharp builds this OS's bundle carries: both CPU architectures.
const SHARP_TARGETS = [`${os}-x64`, `${os}-arm64`];

if (!['win32', 'darwin', 'linux'].includes(os)) {
  console.error(`Unsupported OS: ${os}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'dist', 'surface', 'cli.js'))) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}
if (os === 'darwin' && !fs.existsSync(path.join(root, 'native', 'ClawdCursor.app'))) {
  console.error('native/ClawdCursor.app is missing — build it first: (cd native && ./build.sh)');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. Runtime files only — the same set npm publishes, minus install scripts.
for (const rel of ['dist', 'scripts/mac', 'scripts/linux', 'README.md', 'LICENSE', 'SECURITY.md', 'SKILL.md']) copy(rel);
for (const f of fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.ps1'))) copy(`scripts/${f}`);
copy('native/ClawdCursor.app');

// 2. Production dependencies, no install scripts (the bundle must not build or
//    download anything on the user's machine).
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license,
  ...(pkg.type ? { type: pkg.type } : {}), main: pkg.main, dependencies: pkg.dependencies,
}, null, 2));
run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

// 3. sharp's native build for both of this OS's CPU architectures.
const sharpPkg = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', 'sharp', 'package.json'), 'utf8'));
const extra = Object.entries(sharpPkg.optionalDependencies ?? {})
  .filter(([name]) => SHARP_TARGETS.some(t => name === `@img/sharp-${t}` || name === `@img/sharp-libvips-${t}`))
  .map(([name, version]) => `${name}@${version}`);
run(npm, ['install', '--no-save', '--force', '--ignore-scripts', '--no-audit', '--no-fund', ...extra], stage);
// The WebAssembly fallback is never needed next to a native build.
fs.rmSync(path.join(stage, 'node_modules', '@img', 'sharp-wasm32'), { recursive: true, force: true });

// 4. Icon, rendered from the site favicon.
const sharp = createRequire(path.join(stage, 'package.json'))('sharp');
await sharp(path.join(root, 'docs', 'favicon.svg'), { density: 1536 }).resize(512, 512).png().toFile(path.join(stage, 'icon.png'));

// 5. Manifest (MCPB spec 0.3).
const manifest = {
  manifest_version: '0.3',
  name: 'clawdcursor',
  display_name: 'clawdcursor',
  version: pkg.version,
  description: 'Lets Claude see your screen and use your apps: click, type, read text and drive any program on Windows, macOS or Linux.',
  long_description: [
    'clawdcursor gives Claude hands on your desktop. It reads the screen through the accessibility tree first (fast and exact), falls back to OCR, and uses screenshots only when it must — then clicks, types, manages windows and drives your browser.',
    '',
    '**Safety:** dangerous key combos (lock, log out, force-quit) are always blocked, and destructive actions such as closing windows or pressing Send/Delete/Pay ask for confirmation first. A banner shows while an agent is in control.',
    '',
    '**macOS:** grant Claude **Accessibility** and **Screen Recording** in System Settings → Privacy & Security the first time macOS asks.',
  ].join('\n'),
  author: { name: 'Amr Dabbas', url: 'https://github.com/AmrDab' },
  repository: { type: 'git', url: 'https://github.com/AmrDab/clawdcursor.git' },
  homepage: 'https://clawdcursor.com',
  documentation: 'https://github.com/AmrDab/clawdcursor#readme',
  support: 'https://github.com/AmrDab/clawdcursor/issues',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'dist/surface/cli.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/surface/cli.js', 'mcp', '--compact'],
      env: { CLAWDCURSOR_CONSENT: '${user_config.allow_desktop_control}' },
    },
  },
  tools: [
    { name: 'computer', description: 'Screenshots, mouse and keyboard: click, type, key combos, scroll, drag.' },
    { name: 'accessibility', description: 'Read and act on UI elements by name: find, invoke, set values, toggle, wait for elements.' },
    { name: 'window', description: 'List, focus, move, resize, minimize and maximize windows; open apps, files and URLs.' },
    { name: 'system', description: 'Clipboard, OCR, named shortcuts, system time and opening links.' },
    { name: 'browser', description: 'Drive a browser page through the DevTools Protocol: navigate, read, click, type.' },
    { name: 'batch', description: 'Run several steps in one call, each with optional preconditions.' },
    { name: 'task', description: 'Hand a whole task to clawdcursor\'s own agent (needs it configured separately).' },
  ],
  tools_generated: false,
  keywords: ['desktop', 'automation', 'computer-use', 'accessibility', 'gui', 'browser', 'windows', 'macos', 'linux'],
  license: pkg.license,
  compatibility: {
    platforms: [os],
    runtimes: { node: pkg.engines?.node ?? '>=20.0.0' },
  },
  user_config: {
    allow_desktop_control: {
      type: 'boolean',
      title: 'Allow clawdcursor to control this computer',
      description: 'Required. Lets Claude use your mouse, keyboard and screen through clawdcursor. Dangerous key combos stay blocked and destructive actions still ask first. Until this is on, every tool returns a consent prompt instead of acting.',
      required: true,
      default: false,
    },
  },
};
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 6. Validate + pack with the official tool.
run(npx, ['-y', '@anthropic-ai/mcpb@2', 'pack', stage, outFile], root);
console.log(`\n[mcpb] ${path.relative(root, outFile)} — ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB`);
