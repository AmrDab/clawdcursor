/**
 * Windows: turn an application NAME into something that can only be an installed app.
 *
 * `Start-Process -FilePath <name>` hands the string to the shell, which reads it as a program on PATH, a file — or a
 * URI (`ms-settings:`, `search-ms:`), and the Start-menu search fallback types it and opens the best match, which can
 * be a document. For a name that is not in clawdcursor's alias table, neither is acceptable: open_app is not the tool
 * announced as destructive (open_file and open_uri are). So such a name is looked up first, read-only:
 *   1. a program on PATH (`Get-Command -CommandType Application`) or under App Paths → its full path;
 *   2. an app the Start menu lists under exactly that name (`Get-StartApps`, any case), and only if the entry has an
 *      app's shape: a packaged app id, or a shortcut whose target is a .exe / .com. The Start menu also holds URL and
 *      document shortcuts; those are refused. It is started through `shell:AppsFolder\<id>`.
 * Nothing found → null, and nothing is started.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { powershellExe, psOpts } from './ps-spawn';
import { appNameRefusal } from './app-aliases';

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
  // The Start menu, by EXACT name only (-eq on strings ignores case): a prefix or a fragment ("a", "Uninstall") could
  // pick an uninstaller or a document link. Each match is reported with what its shortcut points at; the caller accepts
  // it only if it has an app's shape (isAppShapedStartEntry).
  '$hits = @(Get-StartApps | Where-Object { $_.Name -eq $n })',
  'if ($hits.Count -eq 0) { exit }',
  '$items = @()',
  'try { $items = @((New-Object -ComObject Shell.Application).NameSpace("shell:AppsFolder").Items()) } catch { }',
  '$out = foreach ($a in $hits) {',
  '  $t = ""',
  '  $it = $items | Where-Object { $_.Path -eq $a.AppID } | Select-Object -First 1',
  '  if ($it) { $t = [string]$it.ExtendedProperty("System.Link.TargetParsingPath") }',
  '  @{ appId = [string]$a.AppID; name = [string]$a.Name; target = $t }',
  '}',
  'ConvertTo-Json -Compress -InputObject @{ apps = @($out) }',
].join('\n');

export interface InstalledApp { path?: string; appId?: string; name?: string; target?: string }

/** A program file: a drive path to a .exe / .com, with no second `:`, no `/`, nothing a shell could reinterpret. */
// eslint-disable-next-line no-control-regex -- intentional: control characters never belong in a path
const PROGRAM_PATH = /^[A-Za-z]:\\[^:\x00-\x1f"<>|*?/]+\.(exe|com)$/i;
/** A packaged app's id (AUMID): `<PackageFamily>!<AppId>` — the same shape launchApp accepts for a UWP app id. */
const PACKAGED_ID = /^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/;
/** A classic Start-menu id: a name, a known-folder path or a drive path — no scheme, no `:` beyond a drive prefix. */
const CLASSIC_ID = /^(?:[A-Za-z]:\\)?[A-Za-z0-9_.{}\\ ()+&',#@-]+$/;

/**
 * Does this Start-menu entry have an app's shape? An allowlist: a packaged app id (with no shortcut target), or a
 * classic id whose shortcut target is a program file. Everything else — a URL or document shortcut, a script, an id or
 * a target with a scheme — is not an app.
 */
export function isAppShapedStartEntry(appId: string, target?: string): boolean {
  const id = String(appId ?? '');
  const t = String(target ?? '');
  if (PACKAGED_ID.test(id)) return t === '' || PROGRAM_PATH.test(t);
  return CLASSIC_ID.test(id) && PROGRAM_PATH.test(t);
}

/** The installed app `name` stands for, or null. Never throws; never starts anything. */
export async function resolveInstalledWindowsApp(name: string): Promise<InstalledApp | null> {
  const n = String(name ?? '').trim();
  if (!n || appNameRefusal(n)) return null;   // not a name: never reaches a lookup
  try {
    const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      psOpts({ timeout: 15_000, env: { ...process.env, CLAWD_APP_NAME: n }, windowsHide: true }));
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
    if (!line) return null;
    const hit = JSON.parse(line) as InstalledApp & { apps?: InstalledApp[] };
    if (hit.path) return PROGRAM_PATH.test(hit.path) ? { path: hit.path } : null;
    const app = (hit.apps ?? []).find(a => isAppShapedStartEntry(String(a.appId ?? ''), a.target));
    return app ? { appId: app.appId, name: app.name, target: app.target || undefined } : null;
  } catch {
    return null;
  }
}
