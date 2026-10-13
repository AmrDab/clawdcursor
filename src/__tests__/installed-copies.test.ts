/**
 * `clawdcursor doctor` lists every copy on the machine: the global npm install
 * (what the website installer updates), Claude Desktop extensions, the Claude
 * Code plugin's pinned version, and npx's cache — and flags stale ones. All
 * paths here are a fake home in a temp dir; nothing real is read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findInstalledCopies, describeCopies, type CopyRoots } from '../surface/installed-copies';

let root: string;
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

function roots(platform: NodeJS.Platform): CopyRoots {
  return {
    platform,
    home: path.join(root, 'home'),
    globalPrefix: path.join(root, 'prefix'),
    npmCache: path.join(root, 'npm-cache'),
    desktopExtensions: [path.join(root, 'ext-a'), path.join(root, 'ext-b')],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-copies-'));
});

describe('findInstalledCopies', () => {
  it('finds the global install, Desktop extensions, the plugin pin and npx copies', () => {
    write(path.join(root, 'prefix', 'node_modules', 'clawdcursor', 'package.json'), { version: '2.0.15' });
    write(path.join(root, 'ext-b', 'local.mcpb.someone.clawdcursor', 'manifest.json'), { version: '2.0.11' });
    write(path.join(root, 'ext-b', 'other-extension', 'manifest.json'), { version: '9.9.9' });            // not ours
    const pluginDir = path.join(root, 'home', '.claude', 'plugins', 'cache', 'clawdcursor', 'clawdcursor', '2.0.14');
    write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { version: '2.0.14' });
    write(path.join(root, 'home', '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'clawdcursor@clawdcursor': [{ scope: 'user', installPath: pluginDir }],
        'frontend-design@claude-plugins-official': [{ installPath: path.join(root, 'nope') }],
      },
    });
    write(path.join(root, 'npm-cache', '_npx', 'aaa', 'node_modules', 'clawdcursor', 'package.json'), { version: '2.0.13' });
    write(path.join(root, 'npm-cache', '_npx', 'bbb', 'node_modules', 'left-pad', 'package.json'), { version: '1.0.0' });

    const copies = findInstalledCopies(roots('win32'));
    expect(copies.map(c => `${c.kind}@${c.version}`).sort()).toEqual([
      'claude-code-plugin@2.0.14', 'desktop-extension@2.0.11', 'global@2.0.15', 'npx-cache@2.0.13',
    ]);
  });

  it('uses lib/node_modules for the global copy on macOS / Linux', () => {
    write(path.join(root, 'prefix', 'lib', 'node_modules', 'clawdcursor', 'package.json'), { version: '2.0.15' });
    expect(findInstalledCopies(roots('linux'))).toEqual([
      { kind: 'global', version: '2.0.15', path: path.join(root, 'prefix', 'lib', 'node_modules', 'clawdcursor') },
    ]);
  });

  it('nothing installed → empty, never throws on missing folders', () => {
    expect(findInstalledCopies(roots('darwin'))).toEqual([]);
  });
});

describe('describeCopies', () => {
  const copies = [
    { kind: 'global' as const, version: '2.0.15', path: '/g' },
    { kind: 'desktop-extension' as const, version: '2.0.11', path: '/e' },
    { kind: 'npx-cache' as const, version: '2.0.12', path: '/n1' },
    { kind: 'npx-cache' as const, version: '2.0.13', path: '/n2' },
  ];

  it('flags copies older than the latest release, with the fix; npx cache is info only', () => {
    const { lines, stale } = describeCopies(copies, { latest: '2.0.15', running: '/g', platform: 'win32' });
    expect(stale.map(c => c.kind)).toEqual(['desktop-extension']);
    expect(lines[0]).toBe('v2.0.15  global install (npm) (this one)');
    expect(lines[1]).toMatch(/v2.0.11 {2}Claude Desktop extension {2}⚠ older than v2.0.15 — install clawdcursor-win32\.mcpb/);
    expect(lines[2]).toBe('npx cache holds: v2.0.13, v2.0.12 (used by the plugin / npx; old ones are harmless)');
  });

  it('a newer release flags the global copy too, with the installer command for the OS', () => {
    const { stale, lines } = describeCopies(copies.slice(0, 1), { latest: '2.0.16', platform: 'darwin' });
    expect(stale).toHaveLength(1);
    expect(lines[0]).toMatch(/curl -fsSL https:\/\/clawdcursor\.com\/install\.sh \| bash/);
  });

  it('without a release check the newest copy found is the reference', () => {
    expect(describeCopies(copies, {}).stale.map(c => c.kind)).toEqual(['desktop-extension']);
  });
});
