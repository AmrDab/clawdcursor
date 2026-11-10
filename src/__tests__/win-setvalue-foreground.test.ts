/**
 * Windows set_value's keyboard fallback must type only into its own window.
 *
 * Audit 2026-11-05: with no writable ValuePattern the bridge did SetFocus + SendKeys("^a") + the text. SendKeys goes to
 * the FOREGROUND window and UIA SetFocus does not change it, so with the host's chat in front the select-all and the
 * value (a password, say) landed in the chat, and the bridge reported success. A source-level guard: running the
 * unfixed path live would type into whatever is in front on the test machine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bridge = readFileSync(join(__dirname, '..', '..', 'scripts', 'ps-bridge.ps1'), 'utf8');
const setValue = bridge.slice(bridge.indexOf('"set-value" {'), bridge.indexOf('"get-value" {'));

describe('ps-bridge set-value — keyboard fallback', () => {
  // Review of 1.5.27: the check compared PROCESSES, so a second window of the same process (Explorer, Notepad, Edge)
  // in front passed it. It compares the target's top-level WINDOW with the foreground window.
  it('checks that the top-level window of the target is is the foreground window before any keystroke', () => {
    const check = setValue.search(/GetAncestor\(\[Win32UIA\]::GetForegroundWindow\(\), 2\)/);
    const compare = setValue.indexOf('$topHwnd -eq 0 -or $fgRoot -ne $topHwnd');
    const firstKey = setValue.indexOf('SendWait(');
    expect(check).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(check);
    expect(firstKey).toBeGreaterThan(compare);
  });

  it('a window not in front is a plain failure (not refused), so set_value falls back to click-then-type', () => {
    const refusal = setValue.slice(setValue.indexOf('$topHwnd -eq 0'), setValue.indexOf('SendWait('));
    expect(refusal).toMatch(/success=\$false/);
    expect(refusal).not.toMatch(/refused/);
  });
});
