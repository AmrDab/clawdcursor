import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { icaclsArgs, writePrivateJson, windowsUser } from '../src/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('agent.json, which can hold an API key, is owner-only', () => {
  it('Windows: icacls removes the inherited entries and grants the user alone full control', () => {
    expect(icaclsArgs('C:\\Users\\u\\.clawdcursor\\agent.json', 'PC\\u')).toEqual(['C:\\Users\\u\\.clawdcursor\\agent.json', '/inheritance:r', '/grant:r', 'PC\\u:F', '/remove:g', '*S-1-5-18', '*S-1-5-32-544']);
    expect(windowsUser({ USERDOMAIN: 'PC' })).toBe(`PC\\${os.userInfo().username}`);
  });

  it('Windows: the file is restricted before the key is written into it', () => {
    const file = path.join(dir, 'agent.json');
    const calls: Array<{ cmd: string; args: string[]; size: number }> = [];
    writePrivateJson(file, { anthropic: { apiKey: 'sk-test' } }, { platform: 'win32', user: 'PC\\u',
      run: (cmd, args) => { calls.push({ cmd, args, size: fs.statSync(file).size }); } });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toMatch(/System32[\\/]icacls\.exe$/i);
    expect(calls[0].args).toEqual(icaclsArgs(file, 'PC\\u'));
    expect(calls[0].size).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ anthropic: { apiKey: 'sk-test' } });
  });

  it('when the file cannot be restricted, nothing is saved', () => {
    const file = path.join(dir, 'agent.json');
    expect(() => writePrivateJson(file, { anthropic: { apiKey: 'sk-test' } }, { platform: 'win32', run: () => { throw new Error('access denied'); } }))
      .toThrow(/nothing was saved/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('macOS / Linux: mode 0600, also when the file was there before', () => {
    const file = path.join(dir, 'agent.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    writePrivateJson(file, { anthropic: { apiKey: 'sk-test' } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('Windows, for real: the only entry left is the current user\'s', () => {
    const file = path.join(dir, 'agent.json');
    writePrivateJson(file, { anthropic: { apiKey: 'sk-test' } });
    const acl = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [file], { encoding: 'utf8' });
    const entries = acl.split('\n').map(l => l.replace(file, '').trim()).filter(l => /:\(/.test(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].toLowerCase()).toContain(os.userInfo().username.toLowerCase());
    expect(entries[0]).toContain('(F)');
  });
});
