/**
 * Every copy of clawdcursor on this machine, with its version.
 *
 * Updating with the installer (`npm i -g clawdcursor`) replaces the global
 * copy only. The Claude Desktop extension bundles its own copy, the Claude
 * Code plugin pins a version that npx fetches into its cache, and a second
 * Node install has its own global folder. `clawdcursor doctor` lists them so
 * a stale one (e.g. an old Desktop extension still clicking with an old bug)
 * is visible instead of a mystery.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type CopyKind = 'global' | 'desktop-extension' | 'claude-code-plugin' | 'npx-cache';

export interface InstalledCopy {
  kind: CopyKind;
  version: string;
  path: string;
}

/** Where to look. Injected so tests can point at a fake home. */
export interface CopyRoots {
  platform: NodeJS.Platform;
  home: string;
  /** npm's global prefix (null: unknown). */
  globalPrefix: string | null;
  /** npm's cache folder (holds the npx copies). */
  npmCache: string;
  /** Claude Desktop's folders of installed extensions (the Windows Store build keeps its own). */
  desktopExtensions: string[];
}

const readJson = (file: string): any => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
};
const listDirs = (dir: string): string[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); } catch { return []; }
};

export function defaultRoots(): CopyRoots {
  const platform = process.platform;
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  let globalPrefix: string | null = process.env.npm_config_prefix ?? null;
  if (!globalPrefix) {
    try {
      globalPrefix = execFileSync(platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], shell: platform === 'win32',
      }).trim() || null;
    } catch {
      globalPrefix = platform === 'win32' ? path.join(appData, 'npm') : null;
    }
  }
  const npmCache = process.env.npm_config_cache
    ?? (platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'npm-cache') : path.join(home, '.npm'));
  const desktopExtensions = platform === 'win32'
    ? [
      path.join(appData, 'Claude', 'Claude Extensions'),
      // Microsoft Store (MSIX) build: its AppData writes are redirected here.
      ...listDirs(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Packages'))
        .filter(d => /^Claude_/i.test(path.basename(d)))
        .map(d => path.join(d, 'LocalCache', 'Roaming', 'Claude', 'Claude Extensions')),
    ]
    : platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions')]
      : [path.join(home, '.config', 'Claude', 'Claude Extensions')];
  return { platform, home, globalPrefix, npmCache, desktopExtensions };
}

export function findInstalledCopies(roots: CopyRoots = defaultRoots()): InstalledCopy[] {
  const copies: InstalledCopy[] = [];

  // Global npm install (what the website installer updates).
  if (roots.globalPrefix) {
    const dir = roots.platform === 'win32'
      ? path.join(roots.globalPrefix, 'node_modules', 'clawdcursor')
      : path.join(roots.globalPrefix, 'lib', 'node_modules', 'clawdcursor');
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg?.version) copies.push({ kind: 'global', version: pkg.version, path: dir });
  }

  // Claude Desktop extensions (.mcpb) — each bundles its own copy.
  for (const dir of roots.desktopExtensions.flatMap(listDirs)) {
    if (!/clawdcursor/i.test(path.basename(dir))) continue;
    const manifest = readJson(path.join(dir, 'manifest.json'));
    if (manifest?.version) copies.push({ kind: 'desktop-extension', version: manifest.version, path: dir });
  }

  // Claude Code plugin — the version its npx launcher is pinned to.
  const plugins = readJson(path.join(roots.home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  for (const [id, installs] of Object.entries(plugins)) {
    if (!id.startsWith('clawdcursor@') || !Array.isArray(installs)) continue;
    for (const install of installs as Array<{ installPath?: string }>) {
      if (!install.installPath) continue;
      const manifest = readJson(path.join(install.installPath, '.claude-plugin', 'plugin.json'));
      if (manifest?.version) copies.push({ kind: 'claude-code-plugin', version: manifest.version, path: install.installPath });
    }
  }

  // npx's cache: whatever versions the plugin (or `npx clawdcursor`) has fetched.
  for (const dir of listDirs(path.join(roots.npmCache, '_npx'))) {
    const pkgDir = path.join(dir, 'node_modules', 'clawdcursor');
    const pkg = readJson(path.join(pkgDir, 'package.json'));
    if (pkg?.version) copies.push({ kind: 'npx-cache', version: pkg.version, path: pkgDir });
  }

  return copies;
}

/** Semver-ish compare: >0 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const LABEL: Record<CopyKind, string> = {
  'global': 'global install (npm)',
  'desktop-extension': 'Claude Desktop extension',
  'claude-code-plugin': 'Claude Code plugin',
  'npx-cache': 'npx cache',
};

const RELEASES = 'https://github.com/AmrDab/clawdcursor/releases/latest';

/** What to do about a stale copy, in one line. */
function fixFor(kind: CopyKind, platform: NodeJS.Platform): string {
  switch (kind) {
    case 'global': return platform === 'win32'
      ? 'run: irm https://clawdcursor.com/install.ps1 | iex'
      : 'run: curl -fsSL https://clawdcursor.com/install.sh | bash';
    case 'desktop-extension': return `install clawdcursor-${platform}.mcpb from ${RELEASES}`;
    case 'claude-code-plugin': return 'in Claude Code: /plugin marketplace update clawdcursor';
    default: return '';
  }
}

/**
 * Human-readable report. `latest` (from the release check) is the version every
 * copy should be on; without it, the newest copy found is the reference.
 * npx-cache entries are listed for information only — old ones are harmless.
 */
export function describeCopies(copies: InstalledCopy[], opts: { latest?: string; running?: string; platform?: NodeJS.Platform } = {}):
  { lines: string[]; stale: InstalledCopy[] } {
  const platform = opts.platform ?? process.platform;
  const versions = copies.map(c => c.version).concat(opts.latest ? [opts.latest] : []);
  const newest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), '0.0.0');
  const lines: string[] = [];
  const stale: InstalledCopy[] = [];
  for (const c of copies.filter(c => c.kind !== 'npx-cache')) {
    const old = compareVersions(c.version, newest) < 0;
    if (old) stale.push(c);
    const running = opts.running && path.resolve(opts.running) === path.resolve(c.path) ? ' (this one)' : '';
    lines.push(`v${c.version}  ${LABEL[c.kind]}${running}${old ? `  ⚠ older than v${newest} — ${fixFor(c.kind, platform)}` : ''}`);
  }
  const npx = [...new Set(copies.filter(c => c.kind === 'npx-cache').map(c => c.version))].sort((a, b) => compareVersions(b, a));
  if (npx.length) lines.push(`npx cache holds: ${npx.map(v => `v${v}`).join(', ')} (used by the plugin / npx; old ones are harmless)`);
  if (!lines.length) lines.push('no installed copies found (running from source?)');
  return { lines, stale };
}
