/**
 * Windows: turn an application NAME into something that can only be an installed app.
 *
 * `Start-Process -FilePath <name>` hands the string to the shell, which reads it as a program on PATH, a file — or a
 * URI (`ms-settings:`, `search-ms:`), and the Start-menu search fallback types it and opens the best match, which can
 * be a document. For a name that is not in clawdcursor's alias table, neither is acceptable: open_app is not the tool
 * announced as destructive (open_file and open_uri are). So such a name is looked up first, read-only:
 *   1. a program on PATH (`Get-Command -CommandType Application`) or under App Paths → its full path;
 *   2. an app in the Start menu (`Get-StartApps`: what the Start menu itself lists) → its app id, started through
 *      `shell:AppsFolder\<id>`, which can only start an app.
 * Nothing found → null, and nothing is started.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { powershellExe, psOpts } from './ps-spawn';
import { appNameRefusal } from '../core/router/aliases';

const execFileAsync = promisify(execFile);

// The name arrives as $env:, never as script source (ps-input.ts). Wildcard characters cannot reach Get-Command: the
// caller refuses them (appNameRefusal). One JSON line out.
const SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$n = $env:CLAWD_APP_NAME',
  // Programs only (.exe / .com): PATH also holds scripts and extensionless shims, which the shell would open, not run.
  '$c = Get-Command -CommandType Application -Name $n -All | Where-Object { $_.Source -match "\\.(exe|com)$" } | Select-Object -First 1',
  'if ($c -and $c.Source) { @{ path = $c.Source } | ConvertTo-Json -Compress; exit }',
  'foreach ($h in "HKCU:", "HKLM:") { foreach ($k in $n, "$n.exe") {',
  '  $p = Join-Path $h ("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + $k)',
  '  if (Test-Path -LiteralPath $p) { $v = (Get-Item -LiteralPath $p).GetValue(""); if ($v) { @{ path = ([string]$v).Trim([char]34) } | ConvertTo-Json -Compress; exit } }',
  '} }',
  '$apps = @(Get-StartApps)',
  '$a = $apps | Where-Object { $_.Name -eq $n } | Select-Object -First 1',
  'if (-not $a) { $a = $apps | Where-Object { $_.Name.StartsWith($n, [StringComparison]::OrdinalIgnoreCase) } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }',
  'if (-not $a) { $a = $apps | Where-Object { $_.Name.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }',
  'if ($a -and $a.AppID) { @{ appId = $a.AppID; name = $a.Name } | ConvertTo-Json -Compress }',
].join('\n');

export interface InstalledApp { path?: string; appId?: string; name?: string }

/** The installed app `name` stands for, or null. Never throws; never starts anything. */
export async function resolveInstalledWindowsApp(name: string): Promise<InstalledApp | null> {
  const n = String(name ?? '').trim();
  if (!n || appNameRefusal(n)) return null;   // not a name: never reaches a lookup
  try {
    const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      psOpts({ timeout: 15_000, env: { ...process.env, CLAWD_APP_NAME: n }, windowsHide: true }));
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
    if (!line) return null;
    const hit = JSON.parse(line) as InstalledApp;
    // A full path to a program, or an app id with nothing a shell could reinterpret.
    // eslint-disable-next-line no-control-regex -- intentional: control characters never belong in a path or an app id
    if (hit.path && /^[A-Za-z]:\\[^\x00-\x1f"<>|*?]+\.(exe|com)$/i.test(hit.path)) return { path: hit.path };
    // eslint-disable-next-line no-control-regex -- intentional: control characters never belong in a path or an app id
    if (hit.appId && !/[\x00-\x1f"<>|*?]/.test(hit.appId)) return { appId: hit.appId, name: hit.name };
    return null;
  } catch {
    return null;
  }
}
