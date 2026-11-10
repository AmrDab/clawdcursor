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

/** The same app by name: case, path, ".exe" / ".app" and a " - Insiders" suffix do not matter; a few product names map to their process. */
const APP_ALIASES: Record<string, string> = { 'visual studio code': 'code', 'vs code': 'code', vscode: 'code', 'claude desktop': 'claude', 'chatgpt desktop': 'chatgpt' };
const appKey = (n: string) => {
  const k = normalize(n.trim()).replace(/\s*-\s*insiders$/, '').trim();
  return APP_ALIASES[k] ?? k;
};
/** Is `launched` (what the agent asked to open) the app whose process is `processName`? Equality, never a substring ("code" is not Codex). */
export function sameApp(launched: string | undefined | null, processName: string | undefined | null): boolean {
  if (!launched || !processName) return false;
  const a = appKey(launched);
  return !!a && a === appKey(processName);
}

// ── The processes this server was started from ──

/** Ancestors that own the desktop itself, not an app: a window of theirs is the shell, never "the host". */
const NOT_A_HOST = new Set(['explorer', 'launchd', 'systemd', 'init', 'services', 'svchost', 'winlogon', 'wininit', 'finder', 'sshd', 'login', 'kernel_task']);

interface ProcRow { pid: number; ppid: number; name: string; /** creation time (Windows file time); 0 when the OS table has none */ created: number }

/** The ancestors once read; null until then. An input that arrives before it is read goes by the list alone, never waits. */
let ancestry: Set<number> | null = null;
let ancestryOn = false;

/** The stdio entry: this server has a host process to find. Starts the read now, in the background. Never called for the HTTP daemon. */
export function enableHostAncestry(): void {
  if (ancestryOn) return;
  ancestryOn = true;
  void computeAncestors().then(set => { if (ancestryOn && !ancestry) ancestry = set; }, () => {});
}

/** For tests: the ancestor pids to use (null = off, and forget what was read). */
export function __setHostAncestryForTests(pids: Iterable<number> | null, ready = true): void {
  ancestryOn = pids !== null;
  ancestry = pids && ready ? new Set(pids) : null;   // not ready: the read has started and not finished
}

function readTable(): Promise<ProcRow[]> {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; "$($_.ProcessId) $($_.ParentProcessId) $c $($_.Name)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']];
  return new Promise(resolve => {
    execFile(cmd as string, args as string[], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows: ProcRow[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = win ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line) : /^\s*(\d+)\s+(\d+)\s+()(.*?)\s*$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3] || 0), name: m[4] });
      }
      resolve(rows);
    });
  });
}

/**
 * Process ids above `self` in the process tree (its parent, that one's parent, ...), minus the desktop's own shells. A parent
 * must have been created BEFORE its child: Windows reuses the pid of a process that has exited, so a dead parent's pid can
 * name an unrelated, newer process, and the walk stops there.
 */
export function walkAncestors(table: ProcRow[], self: number): Set<number> {
  const out = new Set<number>();
  const byPid = new Map(table.map(r => [r.pid, r]));
  let child = byPid.get(self);
  for (let hops = 0; child && hops < 32; hops++) {
    const pid = child.ppid;
    const row = byPid.get(pid);
    if (pid <= 4 || !row || out.has(pid)) break;
    if (row.created && child.created && row.created >= child.created) break;
    if (!NOT_A_HOST.has(normalize(row.name))) out.add(pid);
    child = row;
  }
  out.delete(self);
  return out;
}

async function computeAncestors(): Promise<Set<number>> {
  try { return walkAncestors(await readTable(), process.pid); } catch { return new Set(); }
}

/** Why a window counts as an AI host: its process is on the list, or this server was started from it. null = it does not. */
export function aiHostKind(w: { processName?: string | null; processId?: number }): 'list' | 'ancestor' | null {
  if (isAiHostProcess(w.processName)) return 'list';
  if (ancestryOn && ancestry && w.processId && ancestry.has(w.processId)) return 'ancestor';
  return null;
}
