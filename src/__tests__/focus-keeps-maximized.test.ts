/**
 * Focusing a window must not un-maximize it. The bridge's focus-window ran
 * ShowWindow(hwnd, SW_RESTORE=9) on every focus; SW_RESTORE restores a
 * MAXIMIZED window to its smaller normal size, so clawdcursor kept shrinking
 * full-screen windows (user report 2026-10-16). A maximized window is now shown
 * with SW_SHOWMAXIMIZED (3): it still activates (which the foreground lock
 * needs — plain SW_SHOW made focus fail on a live VM) and stays maximized. That is run for real in
 * windows-focus-window.system.test.ts, where SendKeys is a fake: whether the real one is loaded first is read here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/ps-bridge.ps1'), 'utf8');
const start = bridge.indexOf('function Cmd-FocusWindow');
const focusFn = bridge.slice(start, bridge.indexOf('\nfunction ', start + 10));

describe('ps-bridge focus-window', () => {
  it('the Alt-tap fallback loads System.Windows.Forms before using SendKeys', () => {
    const load = focusFn.indexOf('Add-Type -AssemblyName System.Windows.Forms');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(focusFn.indexOf('SendKeys]::SendWait'));
  });
});
