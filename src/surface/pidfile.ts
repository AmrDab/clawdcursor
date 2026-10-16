/**
 * Single-instance lockfile for `start` / `mcp` / `serve` modes.
 *
 * Prior versions stored a bare integer PID. That format had two failure
 * modes that surfaced as "Failed to reconnect to clawdcursor: -32000" on
 * Windows hosts:
 *
 *   1. PID recycling. process.kill(pid, 0) returns true for *any* live
 *      process — including unrelated processes the OS later assigned the
 *      original clawdcursor's PID to. The lockfile then permanently looked
 *      "live" and refused all future spawns until manually removed.
 *
 *   2. Orphan accumulation. Editor hosts (Claude Code, Cursor, etc.) that
 *      crash without reaping their MCP child leave a live but unusable
 *      clawdcursor whose PID legitimately matches the lockfile. The host's
 *      next reconnect spawns a fresh child, which loses the single-instance
 *      race and exits.
 *
 * This module fixes (1) by recording process start time alongside the PID
 * and verifying both before treating a lockfile as live. Recycled PIDs
 * always have a later start time than the original, so the mismatch is
 * unambiguous.
 *
 * Fix (2) is two-layered and deterministic — stdin-EOF alone is NOT reliable
 * when the host is a GUI app (quitting the Claude desktop app on Windows does
 * not deliver stdin EOF to the child):
 *   - the lock holder runs a parent-PID watchdog (see the `mcp` command in
 *     cli.ts) and self-exits when its host process dies; and
 *   - this module records the holder's parent PID (`ppid`) so a later claimant
 *     can detect a holder whose parent is dead — a confirmed orphan — and reap
 *     it instead of refusing to start (see claimPidFile).
 *
 * Backwards compat: a legacy bare-integer lockfile cannot be verified for
 * identity (no recorded start time), so it is treated as stale and
 * overwritten. First upgrade from a pre-fix version silently discards any
 * old lock — correct behavior since the old format can't be trusted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export type LockMode = 'start' | 'mcp' | 'serve';

const PID_DIR = path.join(os.homedir(), '.clawdcursor');

const SCHEMA_VERSION = 1;

// OS process-start-time precision varies (Linux jiffies ~10ms, ps -o lstart=
// is second-precise on macOS, Windows CreationDate is ms-precise but coarse
// when the system clock changes). 5 s comfortably swallows reporting jitter
// without letting a recycled PID masquerade as the original — anything
// recycled within a 5 s window is already extraordinarily unlikely.
const START_TIME_TOLERANCE_MS = 5000;

interface LockData {
  v: number;
  pid: number;
  startTime: number;
  mode: LockMode;
  /** PID of the process that spawned the lock holder (its host editor).
   *  Lets a later claimant detect an ORPHANED holder — one whose parent has
   *  died — and reap it instead of refusing to start. Optional for back-compat
   *  with locks written before this field existed. */
  ppid?: number;
}

export function pidFilePath(mode: LockMode): string {
  return path.join(PID_DIR, `${mode}.pid`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the start time of `pid` in ms since the Unix epoch, or null if
 * the process is not running or its start time cannot be determined.
 *
 * Implementation is a one-shot shell-out per call. The lock check runs at
 * most a handful of times across the whole lifetime of a clawdcursor
 * process (startup + sweep), so per-call latency is not a hot path.
 *
 * `timeoutMs` bounds the shell-out; on expiry the lookup returns null.
 * Tests raise it because a cold PowerShell + WMI query can exceed 5 s when
 * the machine is saturated (e.g. a full parallel vitest run).
 */
export function getProcessStartTime(pid: number, timeoutMs = 5000): number | null {
  try {
    if (process.platform === 'win32') {
      // Windows CreationDate is a CIM datetime: yyyymmddHHMMSS.ffffff±UUU.
      // ToFileTimeUtc returns 100-ns ticks since 1601-01-01 UTC; converting
      // to ms-since-epoch is a fixed offset. Going through file time avoids
      // having to parse a CIM-datetime string in JS.
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `try { (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CreationDate.ToFileTimeUtc() } catch { '' }`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs },
      ).trim();
      if (!out) return null;
      const fileTime = BigInt(out);
      // FileTime epoch (1601-01-01) → Unix epoch (1970-01-01) = 11644473600 s
      // = 116444736000000000 100-ns ticks. Each 10000 ticks is 1 ms.
      const epochMs = Number((fileTime - 116444736000000000n) / 10000n);
      return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
    }

    // POSIX: `ps -o lstart= -p <pid>` returns a single-line locale-formatted
    // date like "Thu May 15 18:31:25 2026" with no trailing newline issues.
    // Date.parse handles this format on every platform Node ships on.
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    }).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Try to read and parse a lockfile. Returns null for any failure (missing,
 * unreadable, unparseable, wrong schema, legacy bare-int format).
 *
 * Exported for tests; callers should use claimPidFile.
 */
export function readLockFile(mode: LockMode): LockData | null {
  try {
    const raw = fs.readFileSync(pidFilePath(mode), 'utf-8').trim();
    if (!raw) return null;

    // Legacy bare-int format from pre-fix versions. We can't verify identity
    // from this alone, so callers treat it as stale and overwrite.
    if (/^\d+$/.test(raw)) return null;

    const parsed = JSON.parse(raw) as Partial<LockData>;
    if (
      parsed &&
      parsed.v === SCHEMA_VERSION &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startTime === 'number' &&
      (parsed.mode === 'start' || parsed.mode === 'mcp' || parsed.mode === 'serve')
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to claim the lockfile for `mode`. Returns:
 *   - null if the claim succeeded (no live duplicate, or only a stale /
 *     recycled / legacy lockfile was present and has been overwritten).
 *   - the live duplicate's pid if a verified clawdcursor of `mode` is
 *     already running.
 *
 * Identity is verified by start-time match within START_TIME_TOLERANCE_MS.
 * A bare PID liveness check would be fooled by PID recycling on Windows.
 */
export function claimPidFile(mode: LockMode): number | null {
  try {
    if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });

    const existing = readLockFile(mode);
    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      const actualStart = getProcessStartTime(existing.pid);
      if (
        actualStart !== null &&
        Math.abs(actualStart - existing.startTime) <= START_TIME_TOLERANCE_MS
      ) {
        // Same PID, same start time — a real live holder. But it may be an
        // ORPHAN: a host editor (Claude desktop, etc.) that quit without
        // reaping its MCP child leaves a live-but-unusable holder that would
        // otherwise block every reconnect forever. If we recorded the holder's
        // parent PID and that parent is now dead, the holder is orphaned — reap
        // it and take over. (No recorded ppid → can't prove orphan → stay
        // conservative and treat it as a live duplicate.)
        if (existing.ppid && existing.ppid > 1 && !isProcessAlive(existing.ppid)) {
          try { process.kill(existing.pid); } catch { /* already gone */ }
          // Fall through to overwrite — we are taking the lock.
        } else {
          return existing.pid;
        }
      }
      // PID is alive but doesn't match the recorded start time, OR the
      // start time can't be determined — either way the lockfile no longer
      // points to the original process. Fall through and overwrite.
    }

    const ourStart = Date.now() - Math.floor(process.uptime() * 1000);
    const data: LockData = {
      v: SCHEMA_VERSION,
      pid: process.pid,
      startTime: ourStart,
      mode,
      ppid: process.ppid,
    };
    fs.writeFileSync(pidFilePath(mode), JSON.stringify(data), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch {
    // Lock is best-effort. A filesystem error here should not block the
    // process from starting — the worst case (no single-instance guard)
    // is what users had before this guard existed.
    return null;
  }
}

/**
 * Release the lockfile for `mode`, but only if it still belongs to this
 * process. Prevents a slow exit from accidentally releasing a successor
 * process's lock.
 */
export function releasePidFile(mode: LockMode): void {
  try {
    const lock = readLockFile(mode);
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(pidFilePath(mode));
      return;
    }
    // Legacy bare-int format also belongs to nobody we can verify — fall
    // back to the old behavior of unlinking if the int matches our PID.
    const raw = fs.readFileSync(pidFilePath(mode), 'utf-8').trim();
    if (/^\d+$/.test(raw) && parseInt(raw, 10) === process.pid) {
      fs.unlinkSync(pidFilePath(mode));
    }
  } catch {
    // Non-fatal. A leftover lockfile will be reclaimed by the next claim.
  }
}

/**
 * Read just the PID from a lockfile, supporting both the new JSON format
 * and the legacy bare-int format. Used by `clawdcursor stop` to enumerate
 * running instances; callers do their own liveness check afterwards.
 */
export function readPidLoose(mode: LockMode): number | null {
  try {
    const raw = fs.readFileSync(pidFilePath(mode), 'utf-8').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    const parsed = JSON.parse(raw) as Partial<LockData>;
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}
