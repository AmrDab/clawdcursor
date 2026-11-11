/** Process helpers. The benchmark only ever stops processes it started itself. */
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as net from 'net';
import * as path from 'path';

const isWin = process.platform === 'win32';

/** Windows system programs by absolute path: never whatever `taskkill` or `powershell` is first on PATH. */
export function system32(...rel: string[]): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...rel);
}
export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Start a child in its own process group, so the whole tree can be stopped. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { windowsHide: true, detached: !isWin, ...opts });
}

/** Stop a process we started, and its children. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) execFileSync(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * The pids of the processes named `image` (e.g. "msedge.exe") whose command line contains `marker`: a temp path only a
 * process of this run can have. A browser re-launches itself, so the pid we spawned is not the pid that owns the window.
 */
export function pidsByCommandLine(marker: string, image: string): number[] {
  if (marker.length < 12) throw new Error('refusing to match processes on a short marker');
  try {
    const out = isWin
      // The marker goes through the environment: no quoting of a path inside a PowerShell command.
      ? execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $env:BENCH_IMAGE -and $_.CommandLine -and $_.CommandLine.Contains($env:BENCH_MARKER) } '
        + '| ForEach-Object { $_.ProcessId }'],
      { env: { ...process.env, BENCH_MARKER: marker, BENCH_IMAGE: image }, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('pgrep', ['-f', '--', marker], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return []; }   // pgrep exits 1 when nothing matches
}

/** Stop those processes. */
export function killByCommandLine(marker: string, image: string): void {
  for (const pid of pidsByCommandLine(marker, image)) {
    try {
      if (isWin) execFileSync(system32('taskkill.exe'), ['/PID', String(pid), '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Poll until `probe` returns a value (not undefined / null / false), or throw after `timeoutMs`. */
export async function waitFor<T>(probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs: number, what: string, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await probe(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Run a program and return its stdout; null when it is missing or fails. */
export function tryRun(cmd: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
