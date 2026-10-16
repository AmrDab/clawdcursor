/**
 * Focusing a window must not un-maximize it. The bridge's focus-window ran
 * ShowWindow(hwnd, SW_RESTORE=9) on every focus; SW_RESTORE restores a
 * MAXIMIZED window to its smaller normal size, so clawdcursor kept shrinking
 * full-screen windows (user report 2026-10-16). A maximized window is now shown
 * with SW_SHOWMAXIMIZED (3): it still activates (which the foreground lock
 * needs — plain SW_SHOW made focus fail on a live VM) and stays maximized.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
const start = bridge.indexOf('function Cmd-FocusWindow');
const focusFn = bridge.slice(start, bridge.indexOf('\nfunction ', start + 10));

describe('ps-bridge focus-window keeps a maximized window maximized', () => {
  it('a maximized window is shown with SW_SHOWMAXIMIZED (3), never SW_RESTORE', () => {
    expect(focusFn).toMatch(/if \(\[Win32UIA\]::IsZoomed\(\$hwnd\)\) \{ \[Win32UIA\]::ShowWindow\(\$hwnd, 3\)/);
    expect(focusFn).toMatch(/else \{ \[Win32UIA\]::ShowWindow\(\$hwnd, 9\)/);
    // exactly one SW_RESTORE, and it sits in the not-maximized branch
    expect(focusFn.match(/ShowWindow\(\$hwnd, 9\)/g)?.length).toBe(1);
  });

  it('the Alt-tap fallback loads System.Windows.Forms before using SendKeys', () => {
    const load = focusFn.indexOf('Add-Type -AssemblyName System.Windows.Forms');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(focusFn.indexOf('SendKeys]::SendWait'));
  });
});
