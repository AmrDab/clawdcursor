/**
 * `clawdcursor update` (#360): bring the npm global install to the latest published version.
 *
 * npm is run as `node <npm-cli.js>` by absolute path, never through a shell or by bare name (#336, #372). It is never run
 * with sudo: when the prefix is not the user's, the command to run is printed instead. A copy that is not an npm global
 * install (npx, a source checkout, a Desktop extension) is not touched: the command for it is printed.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getPackageRoot } from '../paths';
import { VERSION } from './version';
import { compareVersions, describeCopies, findInstalledCopies, globalPrefixOf } from './installed-copies';

export type InstallMethod = 'npm-global' | 'npx' | 'desktop-extension' | 'source' | 'other';

/** How the copy at `packageRoot` was installed, from where it sits. */
export function installMethod(packageRoot: string, platform: NodeJS.Platform = process.platform): InstallMethod {
  if (fs.existsSync(path.join(packageRoot, '.git'))) return 'source';
  const parts = packageRoot.split(/[\\/]/);
  if (parts.includes('_npx')) return 'npx';
  if (parts.includes('Claude Extensions')) return 'desktop-extension';
  return globalPrefixOf(packageRoot, platform) ? 'npm-global' : 'other';
}

/** What to run for a copy this command does not update itself. */
export function howToUpdate(method: Exclude<InstallMethod, 'npm-global'>, platform: NodeJS.Platform = process.platform): string {
  switch (method) {
    case 'npx': return 'npx runs the version it is given: use `npx clawdcursor@latest`. The Claude Code plugin pins its own: in Claude Code, /plugin marketplace update clawdcursor';
    case 'desktop-extension': return `install clawdcursor-${platform}.mcpb from https://github.com/AmrDab/clawdcursor/releases/latest`;
    case 'source': return 'a source checkout: git pull, then npm ci && npm run build';
    case 'other': return 'update it with the tool that installed it (with npm: npm install -g clawdcursor@latest)';
  }
}

/**
 * npm's own entry script: the one npm named when it started us, else the npm installed next to this copy in the same
 * global node_modules (Homebrew, nvm, the official installer), else the one bundled next to this Node.
 */
export function npmCliPath(packageRoot: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  const sibling = path.join(path.dirname(packageRoot), 'npm', 'bin', 'npm-cli.js');
  const bundled = platform === 'win32'
    ? path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(path.dirname(path.dirname(execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [env.npm_execpath, sibling, bundled].find(f => !!f && path.basename(f) === 'npm-cli.js' && fs.existsSync(f)) ?? null;
}

/** It becomes an npm package spec: a plain version only, never a URL, a git ref, an alias or an extra argument. */
export const isPlainVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);

async function latestPublished(): Promise<string> {
  const res = await fetch('https://registry.npmjs.org/clawdcursor/latest', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
  const { version } = await res.json() as { version?: string };
  if (!isPlainVersion(version)) throw new Error('the npm registry named no valid version');
  return version;
}

export async function runUpdate(): Promise<void> {
  const root = getPackageRoot();
  const method = installMethod(root);
  const otherCopies = (latest: string) => {
    for (const line of describeCopies(findInstalledCopies(), { latest, running: root }).lines) console.log(`  ${line}`);
  };

  let latest: string;
  try { latest = await latestPublished(); } catch (err) {
    console.error(`Could not read the latest version from the npm registry: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (method !== 'npm-global') {
    console.log(`This copy (v${VERSION}, ${root}) is not an npm global install, so it is not updated here. Latest: v${latest}.`);
    console.log(`  ${howToUpdate(method)}`);
    process.exitCode = 1;
    return;
  }
  if (compareVersions(VERSION, latest) >= 0) {
    console.log(`clawdcursor is up to date: v${VERSION}.`);
    otherCopies(latest);
    return;
  }

  const prefix = globalPrefixOf(root)!;
  const npm = npmCliPath(root);
  const command = `npm install -g clawdcursor@${latest}`;
  if (!npm) {
    console.error(`npm was not found next to Node (${process.execPath}). Run: ${command}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Updating clawdcursor v${VERSION} → v${latest} (${command})...`);
  const r = spawnSync(process.execPath, [npm, 'install', '-g', '--prefix', prefix, `clawdcursor@${latest}`, '--loglevel', 'error'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error(`\nnpm did not finish (${r.error?.message ?? `exit ${r.status ?? r.signal}`}). Nothing was run with elevated rights.`);
    console.error(process.platform === 'win32'
      ? `  If a file was busy (EBUSY / EPERM), a running clawdcursor holds it: quit the apps that run it (Claude Desktop, Claude Code, Cursor...), then run clawdcursor update again.`
      : `  If npm could not write to ${prefix}, that folder is not yours: run \`sudo ${command}\` yourself, or give npm a folder you own (npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH).`);
    process.exitCode = 1;
    return;
  }

  let now = latest;
  try { now = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version ?? latest; } catch { /* report what was asked for */ }
  console.log(`clawdcursor v${VERSION} → v${now}`);
  console.log('Restart your MCP host (Claude Desktop, Claude Code, Cursor, ...): a clawdcursor server it already started keeps running the old version until then.');
  otherCopies(now);
}
