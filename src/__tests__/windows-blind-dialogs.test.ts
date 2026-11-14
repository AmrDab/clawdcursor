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
    const rev = body.indexOf('Test-NameMatch $elName $nameLower');   // the reverse match, with its minimum length
    expect(fwd).toBeGreaterThan(-1);
    expect(rev).toBeGreaterThan(fwd);
    // Each element gets the earliest pass it matches in: exact 1, starts with the whole word(s) 2, contains 3, a real part of the request 4.
    expect(body).toMatch(/elseif \(\$elName -eq \$nameLower\) \{ 1 \} elseif \(\$elName -match \$prefixRe\) \{ 2 \}\s+elseif \(\$elName\.Contains\(\$nameLower\)\) \{ 3 \} elseif \(Test-NameMatch \$elName \$nameLower\) \{ 4 \}/);
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
