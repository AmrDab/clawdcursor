/**
 * `clawdcursor update` (#360) and the npm prefix it shares with `clawdcursor versions` (#372): both come from where the
 * copy sits on disk, never from running npm through a shell. Fake layouts in a temp dir; nothing is installed or run:
 * spawnSync and the registry are fakes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ root: '' }));
vi.mock('../paths', async (orig) => ({ ...(await orig<typeof import('../paths')>()), getPackageRoot: () => h.root }));
vi.mock('../surface/version', () => ({ VERSION: '1.8.0' }));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawnSync: vi.fn() }));

import { spawnSync } from 'child_process';
import { findGlobalPrefix, globalPrefixOf } from '../surface/installed-copies';
import { installMethod, howToUpdate, npmCliPath, isPlainVersion, runUpdate } from '../surface/update';

let root: string;
const touch = (...rel: string[]) => {
  const f = path.join(root, ...rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
  return f;
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-update-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the npm global prefix of a copy', () => {
  it('Windows: <prefix>/node_modules/clawdcursor with clawdcursor.cmd in the prefix', () => {
    touch('npm', 'clawdcursor.cmd');
    expect(globalPrefixOf(path.join(root, 'npm', 'node_modules', 'clawdcursor'), 'win32')).toBe(path.join(root, 'npm'));
  });

  it('macOS / Linux: <prefix>/lib/node_modules/clawdcursor with bin/clawdcursor', () => {
    touch('usr', 'bin', 'clawdcursor');
    expect(globalPrefixOf(path.join(root, 'usr', 'lib', 'node_modules', 'clawdcursor'), 'linux')).toBe(path.join(root, 'usr'));
  });

  it('a project dependency or the npx cache is not a global install', () => {
    expect(globalPrefixOf(path.join(root, 'project', 'node_modules', 'clawdcursor'), 'win32')).toBeNull();
    expect(globalPrefixOf(path.join(root, '_npx', 'abc', 'node_modules', 'clawdcursor'), 'darwin')).toBeNull();
  });

  it('from another copy, the prefix is found through the clawdcursor launcher on PATH (a prefix from ~/.npmrc, nvm)', () => {
    touch('home', '.npm-global', 'bin', 'clawdcursor');
    touch('home', '.npm-global', 'lib', 'node_modules', 'clawdcursor', 'package.json');
    const env = { PATH: [path.join(root, 'empty'), path.join(root, 'home', '.npm-global', 'bin')].join(':') };
    // On a Windows host the joined PATH holds drive letters, so the POSIX case runs only off Windows.
    if (process.platform !== 'win32') {
      expect(findGlobalPrefix(env, 'linux', path.join(root, 'checkout'), path.join(root, 'usr', 'bin', 'node'), path.join(root, 'home')))
        .toBe(path.join(root, 'home', '.npm-global'));
    }
    touch('nvm', 'v20', 'clawdcursor.cmd');
    touch('nvm', 'v20', 'node_modules', 'clawdcursor', 'package.json');
    expect(findGlobalPrefix({ Path: path.join(root, 'nvm', 'v20'), APPDATA: path.join(root, 'roaming') }, 'win32',
      path.join(root, 'checkout'), path.join(root, 'nvm', 'v20', 'node.exe'), root)).toBe(path.join(root, 'nvm', 'v20'));
    expect(findGlobalPrefix({ APPDATA: path.join(root, 'roaming') }, 'win32', path.join(root, 'checkout'), path.join(root, 'node.exe'), root)).toBeNull();
  });
});

describe('the install method', () => {
  it('is read from where the copy sits', () => {
    touch('npm', 'clawdcursor.cmd');
    expect(installMethod(path.join(root, 'npm', 'node_modules', 'clawdcursor'), 'win32')).toBe('npm-global');
    expect(installMethod(path.join(root, 'npm-cache', '_npx', 'abc', 'node_modules', 'clawdcursor'), 'win32')).toBe('npx');
    expect(installMethod(path.join(root, 'Claude', 'Claude Extensions', 'local.mcpb.clawdcursor'), 'darwin')).toBe('desktop-extension');
    touch('checkout', '.git');
    expect(installMethod(path.join(root, 'checkout'), 'linux')).toBe('source');
    expect(installMethod(path.join(root, 'pnpm', 'global', '5', 'node_modules', 'clawdcursor'), 'linux')).toBe('other');
  });

  it('every other method gets a command to run, and none of them is sudo', () => {
    for (const m of ['npx', 'desktop-extension', 'source', 'other'] as const) {
      expect(howToUpdate(m, 'linux')).not.toMatch(/sudo/);
    }
    expect(howToUpdate('desktop-extension', 'darwin')).toMatch(/clawdcursor-darwin\.mcpb/);
  });
});

describe("npm's entry script", () => {
  const nowhere = () => path.join(root, 'nowhere', 'clawdcursor');

  it('is the one next to Node, run by absolute path (no npm.cmd, no shell)', () => {
    const cli = touch('node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(npmCliPath(nowhere(), {}, path.join(root, 'node', 'node.exe'), 'win32')).toBe(cli);
    const posix = touch('opt', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(npmCliPath(nowhere(), {}, path.join(root, 'opt', 'bin', 'node'), 'linux')).toBe(posix);
  });

  it('Homebrew: node resolves into the Cellar, npm sits next to the global clawdcursor', () => {
    const cli = touch('homebrew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pkg = path.join(root, 'homebrew', 'lib', 'node_modules', 'clawdcursor');
    expect(npmCliPath(pkg, {}, path.join(root, 'homebrew', 'Cellar', 'node', '23.1.0', 'bin', 'node'), 'darwin')).toBe(cli);
  });

  it("prefers the one npm named when it started us, but never npx's", () => {
    const named = touch('other', 'npm-cli.js');
    const npx = touch('other', 'npx-cli.js');
    expect(npmCliPath(nowhere(), { npm_execpath: named }, path.join(root, 'nowhere', 'node'), 'linux')).toBe(named);
    expect(npmCliPath(nowhere(), { npm_execpath: npx }, path.join(root, 'nowhere', 'node'), 'linux')).toBeNull();
  });
});

describe('the version from the registry becomes a package spec only when it is a plain version', () => {
  it.each(['1.9.0', '1.9.0-rc.1'])('accepts %s', v => expect(isPlainVersion(v)).toBe(true));
  it.each(['latest', 'npm:x@1.0.0', 'https://evil.example/x.tgz', '1.0.0 --foo', 'github:a/b', '', undefined, 3])(
    'rejects %s', v => expect(isPlainVersion(v)).toBe(false));
});

describe('runUpdate', () => {
  const spawn = vi.mocked(spawnSync);
  const win = process.platform === 'win32';
  const inPrefix = (...rel: string[]) => (win ? rel : ['lib', ...rel]);
  let prefix: string;
  const registry = (version: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version }) })));

  beforeEach(() => {
    prefix = path.join(root, 'prefix');
    h.root = path.join(prefix, ...inPrefix('node_modules', 'clawdcursor'));
    touch('prefix', ...(win ? ['clawdcursor.cmd'] : ['bin', 'clawdcursor']));
    touch('prefix', ...inPrefix('node_modules', 'npm', 'bin', 'npm-cli.js'));
    vi.stubEnv('npm_execpath', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawn.mockReset();
  });
  afterEach(() => { process.exitCode = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('installs the newer version into the prefix this copy lives in: node + npm-cli.js, no shell, no sudo', async () => {
    registry('1.9.0');
    spawn.mockReturnValue({ status: 0 } as any);
    await runUpdate();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { shell?: unknown }];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([path.join(prefix, ...inPrefix('node_modules', 'npm', 'bin', 'npm-cli.js')),
      'install', '-g', '--prefix', prefix, 'clawdcursor@1.9.0', '--loglevel', 'error']);
    expect(opts?.shell).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it('a failed npm run exits 1 and is not retried with sudo', async () => {
    registry('1.9.0');
    spawn.mockReturnValue({ status: 1 } as any);
    await runUpdate();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(process.exitCode).toBe(1);
  });

  it('up to date: runs nothing', async () => {
    registry('1.8.0');
    await runUpdate();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('a copy that is not an npm global install is not touched', async () => {
    registry('1.9.0');
    h.root = path.join(root, 'checkout', 'clawdcursor');
    await runUpdate();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('a registry answer that is not a plain version installs nothing', async () => {
    registry('github:a/b');
    await runUpdate();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
