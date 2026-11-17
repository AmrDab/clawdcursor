/**
 * ps-bridge `restore-foreground`: puts the user's window back in front after an act took the foreground. It needs the
 * foreground-lock workaround (an Alt key event from this process, then SetForegroundWindow) and must VERIFY by reading the
 * foreground back. Run for real against a fake Win32UIA / ClawdMsg: nothing reaches the desktop.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runPsJson } from './helpers/ps-bridge-harness';

type Run = { reply: { success: boolean; restored: boolean; error?: string }; calls: string[] };
const run = (body: string) => `${body}
$r = Cmd-RestoreForeground ([pscustomobject]@{ handle = 500 })
'{"reply":' + (ConvertTo-Json -InputObject $r -Compress) + ',"calls":' + (ConvertTo-Json -InputObject @([Win32UIA]::Calls) -Compress) + '}'`;

describe.runIf(process.platform === 'win32')('ps-bridge restore-foreground (run for real, fake windows)', () => {
  const CASES = {
    // The target (900) holds the foreground; setting does not stick in the fake, so the read-back says it failed.
    notBack: run('[Win32UIA]::Foreground = 900'),
    alreadyFront: run('[Win32UIA]::Foreground = 500'),
    noHandle: `$r = Cmd-RestoreForeground ([pscustomobject]@{ handle = 0 }); ConvertTo-Json -InputObject @{ reply = $r; calls = @() } -Compress`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, Run>;
  beforeAll(() => {
    const out = runPsJson(['Cmd-RestoreForeground'], '', keys.map(k => CASES[k])) as Run[];
    r = Object.fromEntries(keys.map((k, i) => [k, out[i]])) as typeof r;
  }, 120_000);

  it('lifts the foreground lock with an Alt key event BEFORE SetForegroundWindow, and does not claim a restore it cannot read back', () => {
    const c = r.notBack.calls;
    expect(c.indexOf('AltTap')).toBeGreaterThanOrEqual(0);
    expect(c.indexOf('AltTap')).toBeLessThan(c.indexOf('SetForegroundWindow 500'));
    expect(r.notBack.reply.restored).toBe(false);
  });

  it('is a no-op when the window is already in front', () => {
    expect(r.alreadyFront.reply).toEqual({ success: true, restored: true });
    expect(r.alreadyFront.calls).toEqual([]);
  });

  it('refuses a missing handle', () => {
    expect(r.noHandle.reply.success).toBe(false);
  });
});
