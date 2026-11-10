/**
 * URI-scheme handler resolution + verified launch (Windows).
 *
 * Why this exists: the obvious dispatch routes (`explorer.exe mailto:...`,
 * `rundll32 url.dll,FileProtocolHandler`, `cmd /c start "" "mailto:..."`)
 * silently fail to open a compose window for New Outlook (`olk.exe`). The
 * shell-routed paths return without error, no new window appears, and
 * the agent thinks the dispatch worked. The only reliable Windows path
 * is to resolve the registered handler executable and invoke IT directly
 * with the URI as an argument.
 *
 * This module:
 *   1. Resolves the user's default handler for a URI scheme by walking
 *      HKCU UserChoice -> HKCR ProgId -> shell\open\command.
 *   2. Falls back to a known-good list of common handlers when the
 *      registry lookup fails (New Outlook is the main case today).
 *   3. Launches the handler with the URI and VERIFIES a new visible
 *      top-level window appeared in the handler process within a
 *      bounded timeout. Returns honest success/failure.
 *
 * macOS and Linux already have reliable shell dispatch (`open` and
 * `xdg-open`), so this module is Windows-only. Callers should keep
 * using the platform-native dispatchers there.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { psOpts } from './ps-spawn';

const execFileAsync = promisify(execFile);

/**
 * Resolve the executable path for the user's default handler of `scheme`
 * (e.g. "mailto", "http", "tel"). Returns null when no handler is
 * registered or when the registry lookup fails for any reason.
 */
export async function resolveSchemeHandlerExecutable(scheme: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const s = scheme.toLowerCase();

  // Step 1: HKCU\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\<scheme>\UserChoice
  //   -> ProgId
  const userChoicePath = `HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${s}\\UserChoice`;
  let progId: string | null = null;
  try {
    const { stdout } = await execFileAsync('reg', ['query', userChoicePath, '/v', 'ProgId'], { timeout: 3000 });
    const m = stdout.match(/ProgId\s+REG_SZ\s+(.+?)[\r\n]/);
    if (m) progId = m[1].trim();
  } catch {
    // No UserChoice — fall through.
  }

  // Step 2: HKCR\<ProgId>\Shell\open\command -> (default)
  if (progId) {
    const cmdPath = `HKCR\\${progId}\\Shell\\open\\command`;
    try {
      const { stdout } = await execFileAsync('reg', ['query', cmdPath, '/ve'], { timeout: 3000 });
      const m = stdout.match(/\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)[\r\n]/);
      if (m) {
        const exe = extractExecutableFromCommand(m[1]);
        if (exe) return exe;
      }
    } catch {
      // ProgId points at a UWP app that doesn't expose shell\open\command
      // (Microsoft.OutlookForWindows for example). Fall through to the
      // known-handler list below.
    }
  }

  // Step 3: known-handler fallbacks. Add new entries here as needed.
  return resolveKnownHandlerForScheme(s);
}

/**
 * Parse a Windows shell command-line string and pull out the executable
 * path. Handles quoted paths, environment variable expansion (%ProgramFiles%),
 * and strips trailing placeholder arguments like %1.
 */
function extractExecutableFromCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  let exe: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end < 0) return null;
    exe = trimmed.slice(1, end);
  } else {
    const spaceIdx = trimmed.indexOf(' ');
    exe = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
  }
  // Expand %VAR% references.
  exe = exe.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
  return exe || null;
}

/**
 * Look up a known-good handler executable for a scheme when the registry
 * walk fails. UWP-packaged handlers (modern Outlook, Mail, etc.) don't
 * expose a classic shell\open\command, so we have to know the executable
 * location ourselves.
 */
function resolveKnownHandlerForScheme(scheme: string): string | null {
  if (scheme !== 'mailto') return null;

  // 1. Already-running New Outlook (`olk.exe`). Pull its path off the
  //    live process when possible — that's the version actually installed.
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      'wmic process where "name=\'olk.exe\'" get ExecutablePath /value',
      { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/ExecutablePath=(.+)/);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    // wmic missing or olk not running.
  }

  // 2. Glob WindowsApps for the latest Microsoft.OutlookForWindows install.
  try {
    const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const base = 'C:\\Program Files\\WindowsApps';
    if (existsSync(base)) {
      const dirs = readdirSync(base).filter(d => d.startsWith('Microsoft.OutlookForWindows_'));
      if (dirs.length) {
        // Most-recent install wins (filesystem readdir order isn't sorted).
        dirs.sort();
        const exe = `${base}\\${dirs[dirs.length - 1]}\\olk.exe`;
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    // No permission to enumerate WindowsApps — that's fine.
  }

  return null;
}

/**
 * Is `scheme` a registered URI protocol in HKCR (has a `URL Protocol` value)?
 * Some schemes (ms-settings:, ms-windows-store:, …) ARE registered but route
 * through a `DelegateExecute` COM handler with an EMPTY shell\open\command — so
 * resolveSchemeHandlerExecutable() returns null even though the OS can open
 * them. Only ShellExecute (Start-Process) honors DelegateExecute. This lets the
 * caller decide to fall back to a shell dispatch instead of failing outright.
 */
export async function isRegisteredUriScheme(scheme: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const s = scheme.toLowerCase().replace(/[^a-z0-9+.-]/g, ''); // defensive: scheme charset only
  if (!s) return false;
  try {
    const { stdout } = await execFileAsync('reg', ['query', `HKCR\\${s}`, '/v', 'URL Protocol'], { timeout: 3000 });
    return /URL Protocol/i.test(stdout);
  } catch {
    return false;
  }
}

/**
 * Dispatch a URI via ShellExecute (PowerShell `Start-Process`) — the ONLY path
 * that honors `DelegateExecute` COM handlers (ms-settings: et al.) — and verify
 * a NEW visible top-level window appeared by diffing the full window list
 * before/after. The handler process is unknown (SystemSettings.exe for
 * ms-settings, etc.), so this diffs ALL windows rather than one process.
 *
 * The URI (agent-controlled) is passed via an ENV VAR, never interpolated into
 * the command string — no shell-injection surface.
 */
export async function shellDispatchUriAndVerify(
  uri: string,
  listWindows: () => Promise<Array<{ title?: string; handle?: number | string }>>,
  opts: { waitMs?: number } = {},
): Promise<{ windowOpened: boolean; title?: string; error?: string }> {
  if (process.platform !== 'win32') return { windowOpened: false, error: 'windows-only' };
  const waitMs = opts.waitMs ?? 5000;
  const snapshot = async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    try {
      for (const w of await listWindows()) m.set(String(w.handle), w.title ?? '');
    } catch { /* empty */ }
    return m;
  };
  const before = await snapshot();
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Start-Process -FilePath $env:CLAWD_URI'],
      psOpts({ detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAWD_URI: uri } }),
    );
    child.unref();
    child.on('error', () => { /* poll reports no-window */ });
  } catch (err) {
    return { windowOpened: false, error: err instanceof Error ? err.message : String(err) };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const after = await snapshot();
    for (const [handle, title] of after) {
      if (!before.has(handle)) return { windowOpened: true, title };
    }
  }
  return { windowOpened: false };
}

/**
 * Snapshot all visible top-level windows belonging to the given process
 * name (case-insensitive). Returns a Set of HWND-like identifiers so the
 * caller can diff "before" vs "after" launching a handler.
 */
async function snapshotProcessWindows(processNameLower: string): Promise<Set<string>> {
  if (process.platform !== 'win32') return new Set();
  try {
    // Use PowerShell to enumerate; it's already a dependency for the
    // a11y bridge so we're not adding a new runtime.
    //
    // processNameLower flows in from registry / WindowsApps lookups (not
    // LLM-controlled); it still arrives as $env:, never as script source (ps-input.ts).
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' -and $_.ProcessName.ToLower() -eq $env:CLAWD_PS_NAME } | ForEach-Object { "$($_.MainWindowHandle)|$($_.MainWindowTitle)" }`,
      ],
      psOpts({ timeout: 3000, env: { ...process.env, CLAWD_PS_NAME: processNameLower } }),
    );
    return new Set(
      stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Launch the resolved handler with the URI and verify that a NEW visible
 * top-level window appeared in the handler process. Returns:
 *   { success: true,  windowOpened: true,  hwndLabel } when a new window appeared.
 *   { success: true,  windowOpened: false }            when the handler ran but no new window appeared
 *                                                       (handler probably routed to an existing instance silently).
 *   { success: false, error }                           when the launch itself failed.
 */
export async function launchHandlerAndVerify(
  exePath: string,
  uri: string,
  opts: { waitMs?: number } = {},
): Promise<{ success: boolean; windowOpened: boolean; hwndLabel?: string; error?: string }> {
  const waitMs = opts.waitMs ?? 5000;
  // Derive the process name (lowercased, no extension) so we can diff
  // its visible windows before vs after.
  const exeBaseLower = exePath.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();

  const before = await snapshotProcessWindows(exeBaseLower);

  try {
    // detached + ignored stdio so we don't keep a pipe open to the GUI
    // app. unref() lets the daemon exit cleanly later. Any synchronous
    // spawn error throws into the catch below; the 'error' event handler
    // is registered so async failures don't crash the process either.
    const child = spawn(exePath, [uri], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    child.on('error', () => { /* poll-loop reports "no window appeared" */ });
  } catch (err) {
    return { success: false, windowOpened: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Poll for a new visible top-level window. Compose windows take 500ms-2s
  // to mount in New Outlook depending on cold/warm state.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    const after = await snapshotProcessWindows(exeBaseLower);
    const fresh = [...after].find(label => !before.has(label));
    if (fresh) {
      return { success: true, windowOpened: true, hwndLabel: fresh };
    }
  }
  return { success: true, windowOpened: false };
}
