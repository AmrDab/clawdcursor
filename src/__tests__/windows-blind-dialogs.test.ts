/**
 * Windows blind-mode regressions from a live Win11 run (2026-10-14) driving
 * Notepad's Save as dialog with the compact tools:
 *
 *  1. Every Win32 control (File name Edit id 1001, Save Button id 1, ComboBox,
 *     ListView) came back as ControlType.Pane with no Value/Invoke pattern, so
 *     set_value / invoke on them failed. Root cause: UIAutomationClient loads its
 *     client-side proxies lazily, once, via a stack walk that throws under
 *     PowerShell's dynamic frames — after which every HWND gets only the bare
 *     HWND provider. The bridge now registers the proxies from compiled code.
 *  2. compile_ui / read_tree walked the process's MAIN window, not the modal
 *     dialog in the foreground (owned dialogs are UIA children of the owner).
 *  3. `window list` omitted owned dialogs for the same reason.
 *
 * (1) is checked against the real bridge on Windows: the desktop's icon view
 * (SysListView32) is a List through the proxy and a Pane without it, and the
 * failure needs a FromHandle call first — exactly the bridge's usual opener,
 * get-foreground-window. (2) and (3) need a live dialog, so they are
 * source-level guards (verified live on the VM).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'scripts', 'ps-bridge.ps1');
const bridge = readFileSync(bridgePath, 'utf8');

function fnBody(name: string): string {
  const start = bridge.indexOf(`function ${name} {`);
  if (start === -1) return '';
  const next = bridge.indexOf('\nfunction ', start + 1);
  return next === -1 ? bridge.slice(start) : bridge.slice(start, next);
}

describe('ps-bridge — Win32 controls keep their real control type (bug 1)', () => {
  it('registers the client-side proxies from compiled, non-inlined code before serving commands', () => {
    const reg = bridge.indexOf('[UiaProxies]::Register()');
    expect(reg).toBeGreaterThan(-1);
    expect(bridge).toContain('ClientSettings.RegisterClientSideProviderAssembly');
    expect(bridge).toMatch(/MethodImplOptions\.NoInlining\)\]\s*public static void Register\(\)/);
    expect(reg).toBeLessThan(bridge.indexOf('{"ready":true}'));
  });

  it.runIf(process.platform === 'win32')('a ListView is reported as List, not Pane, after a FromHandle-first session', () => {
    const pidOut = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).Id'], { encoding: 'utf8' }).trim();
    const pid = Number(pidOut);
    if (!pid) return; // no shell (headless runner): nothing to probe
    const input = [
      JSON.stringify({ cmd: 'get-foreground-window' }),
      JSON.stringify({ cmd: 'find-element', automationId: '1', processId: pid, maxResults: 10 }),
      'EXIT', '',
    ].join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
      { input, encoding: 'utf8', timeout: 60_000 });
    const lines = out.split(/\r?\n/).filter(Boolean);
    const found = JSON.parse(lines[lines.length - 1]) as Array<{ className: string; controlType: string }>;
    const listViews = found.filter(e => e.className === 'SysListView32');
    if (listViews.length === 0) return; // no desktop icon view on this machine
    for (const lv of listViews) expect(lv.controlType).toBe('ControlType.List');
  }, 90_000);
});

describe('ps-bridge — invoke-element name matching', () => {
  // With control types fixed, set_value "File name" still missed live: the
  // label is "File name:" (no exact hit), and the single bidirectional
  // contains-pass took the first element named just "Name" — a column header.
  const body = fnBody('Cmd-InvokeElement');

  it('compares names without the trailing label colon', () => {
    expect(body).toContain(".TrimEnd(':')");
  });

  it('tries "element name contains query" before "query contains element name"', () => {
    const fwd = body.indexOf('$elName.Contains($nameLower)');
    const rev = body.indexOf('$nameLower.Contains($elName)');
    expect(fwd).toBeGreaterThan(-1);
    expect(rev).toBeGreaterThan(fwd);
    expect(body).toMatch(/\$pass -eq 2 -and \$elName\.Contains\(\$nameLower\)/);
    expect(body).toMatch(/\$pass -eq 3 -and \$nameLower\.Contains\(\$elName\)/);
  });
});

describe('ps-bridge — owned / modal dialogs (bugs 2, 3)', () => {
  const ctx = fnBody('Cmd-GetScreenContext');

  it('walks the FOREGROUND window when it belongs to the requested process', () => {
    const fromFg = ctx.indexOf('FromHandle($fgH)');
    expect(ctx).toContain('[Win32UIA]::GetForegroundWindow()');
    expect(ctx).toMatch(/\$fgPid -eq \$focusedPid/);
    expect(fromFg).toBeGreaterThan(-1);
    // The first-window-of-the-pid lookup is only the fallback.
    expect(ctx.indexOf('$targetWin = $root.FindFirst(')).toBeGreaterThan(fromFg);
  });

  it('lists visible OWNED top-level windows (dialogs) alongside the desktop children', () => {
    expect(ctx).toMatch(/\[ScreenPM\]::GetWindow\(\$h, 4\)/); // GW_OWNER
    expect(ctx).toContain('[ScreenPM]::IsWindowVisible($h)');
    expect(ctx).toMatch(/FromHandle\(\$h\)/);
  });
});
