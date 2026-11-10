/**
 * How clawdcursor starts PowerShell and the other Windows system programs.
 *
 *  - BY ABSOLUTE PATH. On Windows, libuv searches the current directory before PATH when a program is spawned by bare name
 *    ("powershell.exe"), so a planted powershell.exe in the working directory would run (CWE-427). The programs below are
 *    named by their full path under %SystemRoot% (or %windir%), checked to exist; with neither set, or no file, the call fails
 *    with a clear error. There is no fallback to a PATH lookup.
 *  - NO SHELL. Callers use execFile / spawn with an argument array, never a command string through a shell: a shell also
 *    searches the working directory and parses metacharacters.
 *  - A PRIVATE WORKING DIRECTORY. Windows PowerShell writes Microsoft/Windows/PowerShell/ModuleAnalysisCache under LOCALAPPDATA,
 *    and under the working directory when its environment has none (a harness that strips it), where `git add -A` then commits it.
 *    So a PowerShell child runs from ~/.clawdcursor/run, a directory only the user can use (mode 0700), never the shared temp
 *    folder: a directory other users can write is exactly where a planted file would sit. Callers may pass their own cwd.
 *    Apps and terminals the agent opens FOR the user do not start there: they start in the user's home.
 *
 * Paths a script resolves are absolute and do not depend on the working directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let systemRootOverride: string | null | undefined;
/** For tests: the SystemRoot to use (null = unset, also for windir), or undefined to read the environment again. */
export function __setSystemRootForTests(root: string | null | undefined): void { systemRootOverride = root; }

function systemRoot(): string {
  const env = process.env;
  const root = systemRootOverride === undefined
    ? env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR
    : systemRootOverride;
  if (!root) throw new Error('SystemRoot (and windir) is not set, so the Windows system programs cannot be located (clawdcursor never searches PATH for them)');
  return root;
}

function existing(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} was not found at ${file} (clawdcursor never searches PATH for it)`);
  return file;
}

/** Full path of Windows PowerShell 5.1; throws when SystemRoot is unset or the file is missing. */
export function powershellExe(): string {
  return existing(path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

/** Full path of a program in %SystemRoot%\System32 (reg.exe, taskkill.exe, tasklist.exe, rundll32.exe, ...). */
export function system32Exe(name: string): string {
  return existing(path.join(systemRoot(), 'System32', name));
}

/** Full path of a program in %SystemRoot% itself (explorer.exe). */
export function windowsDirExe(name: string): string {
  return existing(path.join(systemRoot(), name));
}

let fallbackRunDir: string | null = null;

/**
 * The private working directory for PowerShell children (~/.clawdcursor/run, 0700), created on first use. On macOS / Linux it
 * is refused if it is a symlink, a non-directory or someone else's, and tightened to 0700 if it already exists with wider
 * permissions. If it cannot be made private, a fresh unguessable mkdtemp directory under the temp folder is used instead, never
 * a shared path.
 */
export function privateRunDir(): string {
  const dir = process.env.CLAWDCURSOR_RUN_DIR || path.join(os.homedir(), '.clawdcursor', 'run');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a plain directory');
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('not owned by this user');
      if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
    }
    return dir;
  } catch {
    fallbackRunDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-run-'));   // 0700, unguessable
    return fallbackRunDir;
  }
}

export function psOpts<const T extends object>(options?: T): T & { cwd: string } {
  const cwd = (options as { cwd?: string } | undefined)?.cwd;
  return { ...(options as T), cwd: cwd ?? privateRunDir() };
}
