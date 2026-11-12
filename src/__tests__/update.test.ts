/**
 * `clawdcursor update` (#360) and the npm prefix it shares with `clawdcursor versions` (#372): both come from where the
 * copy sits on disk, never from running npm through a shell. Fake layouts in a temp dir; nothing is installed or run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globalPrefixOf } from '../surface/installed-copies';
import { installMethod, howToUpdate, npmCliPath } from '../surface/update';

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
  it('is the one next to Node, run by absolute path (no npm.cmd, no shell)', () => {
    const cli = touch('node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(npmCliPath({}, path.join(root, 'node', 'node.exe'), 'win32')).toBe(cli);
    const posix = touch('opt', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(npmCliPath({}, path.join(root, 'opt', 'bin', 'node'), 'linux')).toBe(posix);
  });

  it("prefers the one npm named when it started us, but never npx's", () => {
    const named = touch('other', 'npm-cli.js');
    const npx = touch('other', 'npx-cli.js');
    expect(npmCliPath({ npm_execpath: named }, path.join(root, 'nowhere', 'node'), 'linux')).toBe(named);
    expect(npmCliPath({ npm_execpath: npx }, path.join(root, 'nowhere', 'node'), 'linux')).toBeNull();
  });
});
