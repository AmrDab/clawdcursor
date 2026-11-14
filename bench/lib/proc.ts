/** Process helpers. The benchmark only ever stops processes it started itself. */
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const isWin = process.platform === 'win32';

/** Windows system programs by absolute path: never whatever `taskkill` or `powershell` is first on PATH. */
export function system32(...rel: string[]): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...rel);
}
export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * A program on PATH. On Windows only a real executable (.exe): a .cmd or .bat shim would have to be run through the
 * shell, and nothing in the benchmark is.
 */
export function which(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** An npm launcher script for `name` on PATH (name.cmd / name.bat), on Windows. It is only reported, never run. */
export function findShim(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    for (const ext of ['.cmd', '.bat']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** Start a child in its own process group, so the whole tree can be stopped. Always by argument array, never through a shell. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { windowsHide: true, detached: !isWin, ...opts, shell: false });
}

/**
 * Start an app whose WINDOW the benchmark needs on screen. `windowsHide` tells Windows to start the process with its
 * first window hidden (SW_HIDE): right for a helper, and the reason the native fixture had no window at all in the
 * first live run, so the fence found nothing of it to allow.
 */
export function startVisible(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return start(cmd, args, { ...opts, windowsHide: false });
}

/** Windows: does this process have a visible main window yet? Elsewhere there is no cheap way to ask: true. */
export async function hasWindow(pid: number | undefined, platform: string = process.platform): Promise<boolean> {
  if (platform !== 'win32') return true;
  if (!pid) return false;
  const out = await tryRun(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue).MainWindowHandle`]);
  return Number(out?.trim()) > 0;
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
export async function pidsByCommandLine(marker: string, image: string): Promise<number[]> {
  if (marker.length < 12) throw new Error('refusing to match processes on a short marker');
  // Never execFileSync here: a blocked event loop lets the HTTP connections to the daemon and the model go stale.
  const out = await new Promise<string>(resolve => {
    const done = (_err: unknown, stdout: string | Buffer) => resolve(String(stdout ?? ''));   // pgrep exits 1 when nothing matches
    if (isWin) {
      // The marker goes through the environment: no quoting of a path inside a PowerShell command.
      execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $env:BENCH_IMAGE -and $_.CommandLine -and $_.CommandLine.Contains($env:BENCH_MARKER) } '
        + '| ForEach-Object { $_.ProcessId }'],
      { env: { ...process.env, BENCH_MARKER: marker, BENCH_IMAGE: image }, timeout: 30_000, windowsHide: true, cwd: os.tmpdir() }, done);
    } else execFile('pgrep', ['-f', '--', marker], { timeout: 30_000 }, done);
  });
  return out.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
}

export async function killByCommandLine(marker: string, image: string): Promise<void> {
  for (const pid of await pidsByCommandLine(marker, image)) {
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

/** Run a program (by argument array, never through a shell) and return its stdout; null when it is missing or fails. */
export function tryRun(cmd: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise(resolve => {
    // From the temp directory: Windows PowerShell can leave a Microsoft/ module cache in its working directory.
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, cwd: os.tmpdir(), shell: false }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
