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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    const owned = fnBody('Get-OwnedWindowElements');
    expect(ctx).toContain('Get-OwnedWindowElements');
    expect(owned).toMatch(/\[ScreenPM\]::GetWindow\(\$h, 4\)/); // GW_OWNER
    expect(owned).toContain('[ScreenPM]::IsWindowVisible($h)');
    expect(owned).toMatch(/FromHandle\(\$h\)/);
  });
});

// ── Follow-ups (2026-10-15) ──────────────────────────────────────────────────

/** The C# source of the bridge's compiled UIA helpers (the here-string that defines UiaInvoker). */
function invokerSource(): string {
  const at = bridge.indexOf('class UiaInvoker');
  if (at === -1) return '';
  const start = bridge.indexOf('\n', bridge.lastIndexOf('@"', at)) + 1;
  return bridge.slice(start, bridge.indexOf('\n"@', at)).replace(/\r$/, '');
}

describe('ps-bridge — a Win32 Invoke that opens a modal box does not block the bridge', () => {
  // Live 2026-10-14: invoking the Save as dialog's Save button (or smart_click
  // "Save") took ~10 s because InvokePattern.Invoke on a Win32 button only
  // returns when the modal "Confirm Save As" box it opened is dismissed.
  it('click runs InvokePattern through the bounded UiaInvoker and reports a pending invoke', () => {
    const body = fnBody('Cmd-InvokeElement');
    expect(invokerSource()).toContain('class UiaInvoker');
    expect(body).toMatch(/\[UiaInvoker\]::Invoke\(\$p, \d+\)/);
    expect(body).toContain('pending=$true');
  });

  it.runIf(process.platform === 'win32')('UiaInvoker returns "pending" for a long call, "ok" / "error:" otherwise, and keeps a late error', () => {
    const src = invokerSource();
    expect(src).not.toBe('');
    const script = [
      `Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @'\n${src}\n'@`,
      `Add-Type @'\npublic static class T { public static void Slow() { System.Threading.Thread.Sleep(1500); }`,
      ` public static void SlowThrow() { System.Threading.Thread.Sleep(600); throw new System.InvalidOperationException("late boom"); }`,
      ` public static void Fast() { } public static void Boom() { throw new System.InvalidOperationException("boom"); } }\n'@`,
      `function D($n) { [System.Delegate]::CreateDelegate([System.Action], [T].GetMethod($n)) }`,
      `$sw = [Diagnostics.Stopwatch]::StartNew(); $a = [UiaInvoker]::Run((D 'Slow'), 300); $ms = $sw.ElapsedMilliseconds`,
      `$b = [UiaInvoker]::Run((D 'Fast'), 300); $c = [UiaInvoker]::Run((D 'Boom'), 300)`,
      `$d = [UiaInvoker]::Run((D 'SlowThrow'), 100); Start-Sleep -Milliseconds 1000; $e = [UiaInvoker]::TakeLateError(); $f = [UiaInvoker]::TakeLateError()`,
      `@{ a=$a; ms=$ms; b=$b; c=$c; d=$d; e=$e; f=$f } | ConvertTo-Json -Compress`,
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'clawd-invoker-'));
    const file = join(dir, 'invoker.ps1');
    writeFileSync(file, '﻿' + script, 'utf8');
    let out: string;
    try {
      out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8', timeout: 60_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const r = JSON.parse(out.trim().split(/\r?\n/).pop()!);
    expect(r.a).toBe('pending');
    expect(r.ms).toBeLessThan(1000);  // returned at the wait, not when the call ended
    expect(r.b).toBe('ok');           // the still-running call does not block the next one
    expect(r.c).toBe('error:boom');
    expect(r.d).toBe('pending');
    expect(r.e).toBe('late boom');    // a failure after the wait is kept…
    expect(r.f).toBeNull();           // …and reported once
  }, 90_000);
});

describe('ps-bridge — value reads/writes prefer the editable control over its label', () => {
  // Live 2026-10-14: get_value "File name" returned the label "File name:"
  // (a Text) — the label, its ComboBox and the inner Edit all carry that name.
  const body = fnBody('Cmd-InvokeElement');

  it('a value action takes an editable name match before a label', () => {
    expect(body).toMatch(/\$valueAction = .*'set-value'.*'get-value'|\$valueAction = .*'get-value'.*'set-value'/);
    expect(body).toContain('$EDITABLE -contains');
  });

  it('get-value on a label reads the control it labels (LabeledBy only)', () => {
    expect(body).toMatch(/Resolve-EditableTarget \$element -LabeledOnly/);
    expect(fnBody('Resolve-EditableTarget')).toContain('$LabeledOnly');
  });
});

describe('ps-bridge — focus-window reaches owned dialogs', () => {
  const body = fnBody('Cmd-FocusWindow');
  it('matches over the desktop children plus visible owned windows', () => {
    expect(body).toContain('Get-OwnedWindowElements');
    expect(fnBody('Cmd-GetScreenContext')).toContain('Get-OwnedWindowElements');
  });
  it('tells the caller the focused window is owned', () => {
    expect(body).toMatch(/owned\s+= /);
  });
});

describe('ps-bridge — clicking a no-activate overlay is not a focus failure', () => {
  // Live 2026-10-15: clicking the pause pill's Resume printed "⚠ FOCUS NOT
  // CONFIRMED — the click may have landed on Settings". The pill is
  // WS_EX_NOACTIVATE (it must never steal focus), so the raise attempt always
  // "failed" — by design. Such windows take clicks without activation.
  it('activate-at-point treats a WS_EX_NOACTIVATE window as a no-op, not a failed raise', () => {
    const body = fnBody('Cmd-ActivateAtPoint');
    const check = body.indexOf('0x08000000');
    expect(check).toBeGreaterThan(-1);
    expect(body).toContain('no-activate-window');
    expect(check).toBeLessThan(body.indexOf('SetForegroundWindow($root)'));
  });
});
