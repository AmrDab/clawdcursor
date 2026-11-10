/**
 * CWE-427: on Windows, a program spawned by bare name ("powershell.exe") is looked up in the current directory before PATH, so a
 * planted powershell.exe there would run. Every PowerShell (and system program) clawdcursor starts is named by absolute path under
 * %SystemRoot%, through execFile / spawn with an argument array (no shell), from a private working directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const calls = vi.hoisted(() => ({ execFile: [] as Array<{ file: string; args: string[]; opts: any }> }));
vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    execFile: (file: string, args: string[], opts: any, cb?: any) => {
      calls.execFile.push({ file, args, opts });
      const done = typeof opts === 'function' ? opts : cb;
      done?.(null, '', '');
      return { stdin: { on() {}, end() {} } } as any;
    },
  };
});

import { powershellExe, system32Exe, windowsDirExe, psOpts, privateRunDir, __setSystemRootForTests } from '../platform/ps-spawn';
import { runPsWithStdin } from '../platform/ps-input';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-sysroot-'));
  for (const rel of [['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], ['System32', 'reg.exe'], ['explorer.exe']]) {
    const f = path.join(root, ...rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  }
  __setSystemRootForTests(root);
  calls.execFile.length = 0;
});
afterEach(() => { __setSystemRootForTests(undefined); fs.rmSync(root, { recursive: true, force: true }); });

describe('absolute paths', () => {
  it('PowerShell, System32 and SystemRoot programs are full paths under SystemRoot', () => {
    expect(powershellExe()).toBe(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(system32Exe('reg.exe')).toBe(path.join(root, 'System32', 'reg.exe'));
    expect(windowsDirExe('explorer.exe')).toBe(path.join(root, 'explorer.exe'));
    expect(path.isAbsolute(powershellExe())).toBe(true);
  });

  it('no SystemRoot, or no file there: a clear error, never a PATH lookup', () => {
    __setSystemRootForTests(null);
    expect(() => powershellExe()).toThrow(/SystemRoot is not set.*never searches PATH/);
    __setSystemRootForTests(path.join(root, 'nowhere'));
    expect(() => powershellExe()).toThrow(/powershell\.exe was not found at .*never searches PATH/);
    expect(() => system32Exe('taskkill.exe')).toThrow(/taskkill\.exe was not found/);
  });

  it('a PowerShell call (runPsWithStdin) runs the absolute path, with an argument array, from the private directory', async () => {
    await runPsWithStdin('Set-Clipboard', 'x', 1000);
    const c = calls.execFile[0];
    expect(c.file).toBe(powershellExe());
    expect(Array.isArray(c.args)).toBe(true);
    expect(c.opts.cwd).toBe(privateRunDir());
  });
});

describe('the private working directory', () => {
  it('is under the user\'s home (~/.clawdcursor/run), mode 0700, never the shared temp folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-home-'));
    const saved = { run: process.env.CLAWDCURSOR_RUN_DIR, home: process.env.HOME, profile: process.env.USERPROFILE };
    delete process.env.CLAWDCURSOR_RUN_DIR;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const dir = privateRunDir();
      expect(dir).toBe(path.join(home, '.clawdcursor', 'run'));
      expect(fs.existsSync(dir)).toBe(true);
      expect(path.relative(os.tmpdir(), dir).startsWith('..') || dir.startsWith(home)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      process.env.CLAWDCURSOR_RUN_DIR = saved.run;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('psOpts adds it, keeps the caller\'s other options, and lets the caller choose a cwd', () => {
    expect(psOpts({ timeout: 5 })).toEqual({ timeout: 5, cwd: privateRunDir() });
    expect(psOpts()).toEqual({ cwd: privateRunDir() });
    expect(psOpts({ cwd: '/elsewhere' }).cwd).toBe('/elsewhere');
  });
});

describe('no bare-name system programs and no shell exec of PowerShell in the sources', () => {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (p.endsWith('.ts')) files.push(p);
    }
  })(path.join(__dirname, '..'));
  const lines = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f: path.relative(path.join(__dirname, '..'), f), n: i + 1, l })))
    .filter(x => !/^\s*(\/\/|\*|\/\*)/.test(x.l));

  it('PowerShell is never the bare-name first argument of a spawn / execFile', () => {
    const bad = lines.filter(x => /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|spawnExec)\(\s*['"`](powershell|pwsh)(\.exe)?['"`]/i.test(x.l));
    expect(bad.map(x => `${x.f}:${x.n}`)).toEqual([]);
  });

  it('no exec() / execSync() / execAsync() call runs a powershell string through a shell', () => {
    const bad = lines.filter(x => /\b(exec|execSync|execAsync)\(\s*[`'"][^`'"]*(powershell|pwsh)/i.test(x.l));
    expect(bad.map(x => `${x.f}:${x.n}`)).toEqual([]);
  });

  it('reg, tasklist, taskkill, netstat, rundll32, explorer and chcp are not spawned by bare name', () => {
    const bad = lines.filter(x => /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync|exec)\(\s*[`'"](reg|reg\.exe|tasklist|taskkill|netstat|rundll32|explorer|explorer\.exe|chcp|chcp\.com)\b/i.test(x.l));
    expect(bad.map(x => `${x.f}:${x.n}`)).toEqual([]);
  });
});
