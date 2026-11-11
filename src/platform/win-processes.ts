/**
 * Windows: the running processes with one of these names — pid, name, start time.
 *
 * launchApp asks when a launched app has shown no window within its wait: a slow starter (a CAD suite, an IDE) has
 * its process up long before its window, and that is "started, window not up yet", not a failed launch.
 *
 * A one-shot PowerShell, NOT the long-lived bridge: the bridge runs one command at a time, and the moment this
 * question matters is the moment an accessibility read may be stuck on the very app that is starting. Queued behind
 * it, the answer was lost when the stuck read timed out and the bridge was torn down. Read-only; never throws.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { powershellExe, psOpts } from './ps-spawn';

const execFileAsync = promisify(execFile);

export interface RunningProcess { pid: number; processName: string; /** Unix ms; 0 when it may not be read. */ started: number }

// The names arrive as $env:, never as script source (ps-input.ts); `|` cannot occur in a Windows file name. Exact
// names only: wildcard characters are escaped.
const SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$out = foreach ($n in ($env:CLAWD_PROC_NAMES -split "\\|")) {',
  '  if (-not $n) { continue }',
  '  Get-Process -Name ([System.Management.Automation.WildcardPattern]::Escape($n)) | ForEach-Object {',
  '    $s = 0; try { $s = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {}',
  '    @{ pid = $_.Id; name = $_.ProcessName; started = $s }',
  '  }',
  '}',
  'ConvertTo-Json -Compress -InputObject @($out)',
].join('\n');

/** How long the lookup may take: it is part of the launch wait, which must end. */
export const PROCESS_LOOKUP_TIMEOUT_MS = 5_000;

export async function findWindowsProcesses(names: readonly string[]): Promise<RunningProcess[]> {
  const wanted = names.map(n => n.trim()).filter(n => n && !n.includes('|'));
  if (wanted.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      psOpts({ timeout: PROCESS_LOOKUP_TIMEOUT_MS, env: { ...process.env, CLAWD_PROC_NAMES: wanted.join('|') }, windowsHide: true }));
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
    if (!line) return [];
    const rows = JSON.parse(line) as Array<{ pid?: unknown; name?: unknown; started?: unknown }>;
    return (Array.isArray(rows) ? rows : [])
      .map(r => ({ pid: Number(r.pid), processName: String(r.name ?? ''), started: Number(r.started) || 0 }))
      .filter(r => Number.isInteger(r.pid) && r.pid > 0);
  } catch {
    return [];
  }
}
