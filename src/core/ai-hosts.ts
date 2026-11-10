/**
 * Apps that host an AI assistant, by process name on each OS. Synthetic input must never land in one by accident (an agent
 * that types before it has focused a window sends its text to the chat it is running in), and none is ever raised at a click
 * point on the agent's behalf. One list for both: scripts/ps-bridge.ps1 keeps a copy for the Windows raise guard, and
 * ai-host-guard.test.ts fails when the two differ.
 *
 * Names are compared lower case, without a path, ".exe" or ".app". Windows and macOS report "Claude", "ChatGPT", "Codex",
 * "Cursor", "Code", "Code - Insiders", "Windsurf", "Zed"; Linux packages use the lower-case or hyphenated forms.
 *
 * Besides the list, a stdio server knows its own host: the processes it was started from (a terminal running Claude Code, an
 * app this list has never heard of). Their windows count as AI hosts too. The HTTP daemon has no such parent, so there the
 * list alone applies.
 */
import { execFile } from 'child_process';

export const AI_HOST_PROCESSES: readonly string[] = [
  'claude', 'claude-desktop', 'chatgpt', 'codex', 'cursor', 'code', 'code-insiders', 'code - insiders', 'windsurf', 'zed', 'zeditor', 'zed-editor',
];

const normalize = (name: string) => (name.replace(/\\/g, '/').split('/').pop() ?? name).replace(/\.(exe|app)$/i, '').toLowerCase();

/** The extra names the user added with CLAWD_FOREGROUND_DENYLIST (comma separated), normalized. */
function extraHosts(): string[] {
  return (process.env.CLAWD_FOREGROUND_DENYLIST ?? '').split(',').map(s => normalize(s.trim())).filter(Boolean);
}

/** Does this process name belong to an AI-assistant host app? */
export function isAiHostProcess(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = normalize(name);
  return AI_HOST_PROCESSES.includes(n) || extraHosts().includes(n);
}

// ── The processes this server was started from ──

/** Ancestors that own the desktop itself, not an app: a window of theirs is the shell, never "the host". */
const NOT_A_HOST = new Set(['explorer', 'launchd', 'systemd', 'init', 'services', 'svchost', 'winlogon', 'wininit', 'finder', 'sshd', 'login', 'kernel_task']);

let ancestry: Set<number> | Promise<Set<number>> | null = null;
let ancestryOn = false;

/** The stdio entry: this server has a host process to find. Never called for the HTTP daemon. */
export function enableHostAncestry(): void { ancestryOn = true; }

/** For tests: the ancestor pids to use (null = off, and forget what was read). */
export function __setHostAncestryForTests(pids: Iterable<number> | null): void {
  ancestryOn = pids !== null;
  ancestry = pids ? new Set(pids) : null;
}

function readTable(): Promise<Array<{ pid: number; ppid: number; name: string }>> {
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']];
  return new Promise(resolve => {
    execFile(cmd as string, args as string[], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows: Array<{ pid: number; ppid: number; name: string }> = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
      }
      resolve(rows);
    });
  });
}

/** Process ids above this server in the process tree (its parent, that one's parent, ...), minus the desktop's own shells. */
async function computeAncestors(): Promise<Set<number>> {
  const out = new Set<number>();
  try {
    const byPid = new Map((await readTable()).map(r => [r.pid, r]));
    for (let pid = process.ppid, hops = 0; pid > 4 && hops < 32 && !out.has(pid); hops++) {
      const row = byPid.get(pid);
      if (!row) break;
      if (!NOT_A_HOST.has(normalize(row.name))) out.add(pid);
      pid = row.ppid;
    }
  } catch { /* no table: the list alone applies */ }
  out.delete(process.pid);
  return out;
}

/** Is a window of this process one of the AI assistant's: on the list, or an app this server was started from? */
export async function isAiHostWindow(w: { processName?: string | null; processId?: number }): Promise<boolean> {
  if (isAiHostProcess(w.processName)) return true;
  if (!ancestryOn || !w.processId) return false;
  ancestry ??= computeAncestors();
  const set = await ancestry;
  if (!(ancestry instanceof Set)) ancestry = set;
  return set.has(w.processId);
}
