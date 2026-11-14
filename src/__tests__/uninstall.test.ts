/**
 * `clawdcursor uninstall` stopped the daemon at a fixed :3847, so a daemon on another port kept running; and it removed
 * skill registrations from four hosts while registerSkills writes six (Claude Code and Cursor were left behind).
 * Loopback only; nothing is uninstalled here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';
import { stopRunningDaemon } from '../surface/uninstall';
import { ourSkillRegistrations, hostRegistries } from '../surface/skill-register';
import { claimPidFile, recordLockPort, pidFilePath, DAEMON_LOCK } from '../surface/pidfile';
import { initServerToken } from '../surface/auth';
import { TOKEN_PATH } from '../paths';

describe('uninstall stops the daemon where it runs', () => {
  it('POSTs /stop, with the token, to the port the daemon recorded', async () => {
    const seen: { method?: string; url?: string; auth?: string }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"stopped":true}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(port).not.toBe(3847);
      const token = initServerToken();
      expect(claimPidFile(DAEMON_LOCK)).toBeNull();   // this process plays the daemon
      recordLockPort(DAEMON_LOCK, port);
      await stopRunningDaemon();
      expect(seen).toEqual([{ method: 'POST', url: '/stop', auth: `Bearer ${token}` }]);
      expect(fs.existsSync(pidFilePath(DAEMON_LOCK))).toBe(false);   // the lock sweep ran after it
    } finally { server.close(); }
  });

  it('never signals a live process its lock names under a wrong start time (a reused pid), and removes the lock', async () => {
    fs.rmSync(TOKEN_PATH, { force: true });   // no token: no /stop request, only the lock sweep
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    try {
      fs.mkdirSync(path.dirname(pidFilePath(DAEMON_LOCK)), { recursive: true });
      fs.writeFileSync(pidFilePath(DAEMON_LOCK), JSON.stringify({ v: 1, pid: stranger.pid, startTime: 1_000_000_000_000, mode: DAEMON_LOCK }));
      const kill = vi.spyOn(process, 'kill');
      await stopRunningDaemon();
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0)).toEqual([]);   // liveness probes only
      kill.mockRestore();
      expect(fs.existsSync(pidFilePath(DAEMON_LOCK))).toBe(false);
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
    } finally { stranger.kill('SIGKILL'); }
  }, 60_000);
});

describe('the skill registrations uninstall removes', () => {
  let home: string;
  afterEach(() => {
    // Unlink the links first, so the recursive clean-up can never follow one.
    for (const [, dir] of hostRegistries(home)) {
      const p = path.join(dir, 'clawdcursor');
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* none */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('every host registerSkills writes to — Claude Code and Cursor included — and only what clawdcursor wrote', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-uninstall-skills-'));
    const pkg = (name: string) => {
      const dir = fs.mkdtempSync(path.join(home, 'pkg-'));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
      return dir;
    };
    const ours = pkg('clawdcursor');
    const target = (i: number) => path.join(hostRegistries(home)[i][1], 'clawdcursor');
    const link = (from: string, to: string) => {
      fs.mkdirSync(path.dirname(from), { recursive: true });
      fs.symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
    };
    const copied = (dir: string, extra?: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: clawdcursor\n---\n');
      if (extra) fs.writeFileSync(path.join(dir, extra), 'mine');
    };
    expect(hostRegistries(home).map(([n]) => n)).toEqual(['Claude Code', 'OpenClaw', 'OpenClaw (dev)', 'OpenClaw (flat)', 'Codex', 'Cursor']);
    link(target(0), ours);                     // Claude Code: the symlink registerSkills makes
    copied(target(5));                         // Cursor: its SKILL.md-copy fallback
    link(target(4), pkg('someone-else'));      // Codex: a link to another package
    copied(target(1), 'notes.md');             // OpenClaw: the user's own folder (registerSkills only refreshed SKILL.md)
    expect(ourSkillRegistrations(home)).toEqual([target(0), target(5)]);
  });
});
