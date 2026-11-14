/**
 * Windows blind-mode regressions from a live Win11 run (2026-10-14) driving Notepad's Save as dialog: compile_ui /
 * read_tree walked the process's MAIN window, not the modal dialog in the foreground (owned dialogs are UIA children of
 * the owner), and `window list` omitted owned dialogs for the same reason. Both read the real desktop
 * (GetForegroundWindow, FromHandle), so they stay source-level guards (verified live on the VM). The rest of this
 * regression (control types, name matching, labels, a modal invoke, focus-window on a dialog) runs for real in
 * windows-blind-dialogs.system.test.ts and windows-focus-window.system.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { fnBody } from './helpers/ps-bridge-harness';

describe('ps-bridge — owned / modal dialogs', () => {
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
