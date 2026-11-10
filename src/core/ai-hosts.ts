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
import { psOpts } from '../platform/ps-spawn';
import { logger } from './observability/logger';

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

/** The ancestors once read; null until then. */
let ancestry: Set<number> | null = null;
/** The read in flight, if any. An input to a window that is not on the list waits for it (bounded), never decides without it. */
let ancestryPending: Promise<void> | null = null;
let ancestryOn = false;
let failedLogged = false;
/** How long an input waits for a pending read before it falls back to the list alone. */
let ancestryWaitMs = 2000;

/** The stdio entry: this server has a host process to find. Starts the read now, in the background, so the usual case never waits. Never called for the HTTP daemon. */
export function enableHostAncestry(): void {
  if (ancestryOn) return;
  ancestryOn = true;
  startRead(readTable);
}

/** Start the read; whatever happens, the direct parent still counts (aiHostKind), so a failed read is "no more ancestors", never "none". */
function startRead(read: () => Promise<ProcRow[]>): void {
  ancestryPending = computeAncestors(read).then(set => { ancestry = set; }, () => {}).finally(() => { ancestryPending = null; });
}

/** For tests: run the real read path with a table reader of the test's own. */
export function __startHostAncestryReadForTests(read: () => Promise<ProcRow[]>, waitMs = 2000): Promise<void> {
  ancestryOn = true; ancestryWaitMs = waitMs; ancestry = null;
  startRead(read);
  return ancestryPending!;
}

/**
 * For tests: the ancestor pids to use (null = off, and forget what was read). A promise stands for a read still in flight: it
 * resolves to the pids, or never.
 */
export function __setHostAncestryForTests(pids: Iterable<number> | Promise<Iterable<number>> | null, waitMs = 2000): void {
  ancestryOn = pids !== null;
  ancestryWaitMs = waitMs;
  ancestry = null;
  ancestryPending = null;
  if (pids === null) return;
  if (pids instanceof Promise) {
    const p: Promise<void> = pids.then(set => { ancestry = new Set(set); }, () => {}).finally(() => { if (ancestryPending === p) ancestryPending = null; });
    ancestryPending = p;
  } else ancestry = new Set(pids);
}

function readTable(): Promise<ProcRow[]> {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; "$($_.ProcessId) $($_.ParentProcessId) $c $($_.Name)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']];
  return new Promise((resolve, reject) => {
    execFile(cmd as string, args as string[], psOpts({ timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }), (err, stdout) => {
      if (err) return reject(new Error(String((err as NodeJS.ErrnoException).code ?? 'process table unreadable')));
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

/** The ancestors, or null when the table could not be read (then only the direct parent is known). */
async function computeAncestors(read: () => Promise<ProcRow[]>): Promise<Set<number> | null> {
  try {
    const table = await read();
    if (!table.length) throw new Error('empty process table');
    return walkAncestors(table, process.pid);
  } catch (err) {
    // Once, and only the reason: no paths, no command lines.
    if (!failedLogged) { failedLogged = true; logger.warn('host.ancestry_failed', { reason: String((err as { message?: string })?.message ?? err).slice(0, 80) }); }
    return null;
  }
}

/**
 * Why a window counts as an AI host: its process is on the list, or this server was started from it. null = it does not.
 * While the ancestry read is still running, a window that is not on the list WAITS for it, bounded (~2 s): deciding without it
 * would let an input into the agent's own terminal through in the first seconds. Only a read that failed or does not finish in
 * time falls back to the list alone, and that is deliberately fail-open: a slow process table must not block input forever.
 */
export async function aiHostKind(w: { processName?: string | null; processId?: number }): Promise<'list' | 'ancestor' | null> {
  if (isAiHostProcess(w.processName)) return 'list';
  if (!ancestryOn || !w.processId) return null;
  // The direct parent is known without any process-table read, so until the table says otherwise (pending, failed or timed out)
  // it counts, unless its name is a shell the desktop itself owns (explorer, launchd, systemd). Once the table was read, it decides:
  // it also knows the parent's creation time (a reused pid) and name.
  if (w.processId === process.ppid && !ancestry) return NOT_A_HOST.has(normalize(w.processName ?? '')) ? null : 'ancestor';
  if (!ancestry && ancestryPending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ancestryPending, new Promise<void>(r => { timer = setTimeout(r, ancestryWaitMs); })]);
    clearTimeout(timer);
  }
  return ancestry?.has(w.processId) ? 'ancestor' : null;
}
