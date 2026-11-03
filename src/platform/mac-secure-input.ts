/**
 * macOS "secure input": while a password field (or anything that calls EnableSecureEventInput) has it, WindowServer sends
 * keyboard events — and, as seen on real Macs, app activation — only to the app that holds it, for the whole login session
 * (#267). A `window focus` then ends with the read-back saying "focus went to <other app>", which says nothing of the
 * cause. This names it: whether secure input is on, and who holds it.
 *
 * Asked only AFTER a focus read-back has already failed, never before, and never able to throw into the focus path:
 * every step has a timeout, and anything that does not answer means "unknown", which keeps the caller's own message.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 3_000;
/** `ioreg -l` prints the whole registry (several MB); the default 1 MB buffer would kill it. */
const IOREG_MAX_BUFFER = 64 * 1024 * 1024;

export interface SecureInputHolder {
  pid: number;
  /** The app's name, when the pid could be mapped to one. */
  name?: string;
}

/** `on: false` — secure input is off. `on: true` — it is on; `holder` is absent when the pid could not be found. */
export type SecureInputState = { on: false } | { on: true; holder?: SecureInputHolder };

export interface SecureInputDeps {
  exec(file: string, args: string[], opts: { timeoutMs: number; maxBuffer?: number }): Promise<{ stdout: string }>;
}

const defaultDeps: SecureInputDeps = {
  async exec(file, args, opts) {
    const { stdout } = await execFileAsync(file, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 1024 * 1024 });
    return { stdout: String(stdout) };
  },
};

// Carbon's bridge support does not declare IsSecureEventInputEnabled either (see PREFLIGHT_JXA in native-helper.ts, where
// CGPreflightScreenCaptureAccess was "not a function" on macOS 26.5), so it is bound by hand. Coerced, so a bridge that hands
// back 1/0 instead of a boolean still prints true/false.
export const SECURE_INPUT_JXA =
  "ObjC.import('Carbon'); ObjC.bindFunction('IsSecureEventInputEnabled', ['bool', []]); " +
  'String(Boolean($.IsSecureEventInputEnabled()))';

/**
 * The holder's pid in `ioreg -l -w 0` output, or null. ioreg prints the sessions inline in one array
 * (`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=412,...})`), with one dict per login
 * session under fast user switching, and a session that holds nothing says 0: the first pid above 0 is the holder.
 */
export function parseSecureInputPid(ioregOutput: string): number | null {
  for (const m of ioregOutput.matchAll(/"kCGSSessionSecureInputPID"\s*=\s*(\d+)/g)) {
    const pid = parseInt(m[1], 10);
    if (pid > 0) return pid;
  }
  return null;
}

/** An app's name from `ps -o comm=` output: the .app bundle's name when the executable lives in one, else the file name. */
export function appNameFromCommand(comm: string): string | undefined {
  const line = comm.trim().split('\n')[0]?.trim();
  if (!line) return undefined;
  const bundle = /\/([^/]+)\.app(?:\/|$)/.exec(line);
  if (bundle) return bundle[1];
  return line.split('/').pop() || undefined;
}

/**
 * Is secure input on, and who holds it? null: not known (the check failed or timed out) — treat as "no evidence".
 * Never throws.
 */
export async function checkSecureInput(deps: SecureInputDeps = defaultDeps): Promise<SecureInputState | null> {
  let on: boolean;
  try {
    const { stdout } = await deps.exec('osascript', ['-l', 'JavaScript', '-e', SECURE_INPUT_JXA], { timeoutMs: CHECK_TIMEOUT_MS });
    const out = stdout.trim();
    if (out !== 'true' && out !== 'false') return null;
    on = out === 'true';
  } catch {
    return null;
  }
  if (!on) return { on: false };

  // On: only now, building the error, the ~25 ms spawn that names the holder.
  let pid: number | null = null;
  try {
    const { stdout } = await deps.exec('ioreg', ['-l', '-w', '0'], { timeoutMs: CHECK_TIMEOUT_MS, maxBuffer: IOREG_MAX_BUFFER });
    pid = parseSecureInputPid(stdout);
  } catch { /* the holder stays unknown; secure input is still on */ }
  if (pid === null) return { on: true };

  let name: string | undefined;
  try {
    const { stdout } = await deps.exec('ps', ['-p', String(pid), '-o', 'comm='], { timeoutMs: CHECK_TIMEOUT_MS });
    name = appNameFromCommand(stdout);
  } catch { /* a pid without a name is still worth saying */ }
  return { on: true, holder: { pid, name } };
}

/** The error the agent reads. */
export function secureInputMessage(holder?: SecureInputHolder): string {
  if (!holder) {
    return 'secure input is on (the app holding it could not be found): macOS sends keys and focus only to it. ' +
      'Close or leave the password field in the app that has it, then try again.';
  }
  const who = holder.name ? `${holder.name}, pid ${holder.pid}` : `pid ${holder.pid}`;
  const where = holder.name ?? `the app with pid ${holder.pid}`;
  return `secure input is on (held by ${who}): macOS sends keys and focus only to it. ` +
    `Close or leave the password field in ${where}, then try again.`;
}
