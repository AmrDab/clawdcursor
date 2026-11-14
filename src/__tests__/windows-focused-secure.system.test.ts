/**
 * Windows: the focused element says whether it is a password field (UIA IsPassword) and never carries a password
 * field's value. The type tool's "into a password field (not echoed)" relied on it, and it was missing on Windows only
 * (macOS and Linux already set it): the secret was echoed, and Edge's bullets read as a mismatch that held Return.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, runPsJson } from './helpers/ps-bridge-harness';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { psOpts } from '../platform/ps-spawn';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'scripts', 'ps-bridge.ps1');

describe('ps-bridge get-focused-element: password fields', () => {
  it.runIf(process.platform === 'win32')('the real bridge reports secure (false for an ordinary focused element)', (ctx) => {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
      psOpts({ input: `${JSON.stringify({ cmd: 'get-focused-element' })}\nEXIT\n`, encoding: 'utf8', timeout: 60_000 }));
    const reply = out.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(j => j && j.ready !== true && 'success' in j);
    if (!reply || reply.success === false) ctx.skip('nothing focused (headless runner)');
    expect(typeof reply.secure).toBe('boolean');
  }, 60_000);   // starting the real PowerShell bridge (UIA assemblies) is slow under a full parallel run
});

// The same command against a fake focused element (the harness rewrites AutomationElement.FocusedElement): a password
// box is reported secure and its value is never read, through either pattern.
describe.runIf(process.platform === 'win32')('ps-bridge get-focused-element (run for real, a fake focused element)', () => {
  let out: Array<Record<string, unknown>>;
  beforeAll(() => {
    const focus = (el: string) => `$script:FakeFocused = ${el}\nConvertTo-Json -InputObject (Cmd-GetFocusedElement) -Compress -Depth 5`;
    out = runPsJson(['Cmd-GetFocusedElement'], `${FAKE_UIA}\nfunction Add-StateFields { }`, [
      focus(`New-FakeEl -Name 'Password' -Password -Patterns @{ Value = (New-ValuePattern 'hunter2'); Text = (New-TextPattern 'hunter2') }`),
      focus(`New-FakeEl -Name 'Search' -Patterns @{ Value = (New-ValuePattern 'cats') }`),
      focus(`New-FakeEl -Name 'Name' -Patterns @{ Value = (New-ValuePattern '') }`),
      focus(`New-FakeEl -Name 'Canvas' -Type Pane`),
    ]) as Array<Record<string, unknown>>;
  }, 120_000);

  it('a password field: secure, not readable, and its value appears nowhere in the reply', () => {
    expect(out[0]).toMatchObject({ success: true, name: 'Password', value: '', readable: false, secure: true });
    expect(JSON.stringify(out[0])).not.toContain('hunter2');
  });

  it('an ordinary field: its value, readable, not secure; an empty one is readable ""; no pattern is not readable', () => {
    expect(out[1]).toMatchObject({ value: 'cats', readable: true, secure: false });
    expect(out[2]).toMatchObject({ value: '', readable: true, secure: false });
    expect(out[3]).toMatchObject({ value: '', readable: false, secure: false });
  });
});
