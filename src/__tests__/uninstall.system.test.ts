/**
 * `clawdcursor uninstall` and a reused pid: the lock names a live process that is not the daemon (its start time differs),
 * so uninstall must not signal it. Starts a real node process, hence the system project. The rest is in uninstall.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { stopRunningDaemon } from '../surface/uninstall';
import { pidFilePath, DAEMON_LOCK } from '../surface/pidfile';
import { TOKEN_PATH } from '../paths';

describe('uninstall stops the daemon where it runs', () => {
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
