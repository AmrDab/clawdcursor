/**
 * Windows: the focused element says whether it is a password field (UIA IsPassword) and never carries a password
 * field's value. The type tool's "into a password field (not echoed)" relied on it, and it was missing on Windows only
 * (macOS and Linux already set it): the secret was echoed, and Edge's bullets read as a mismatch that held Return.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'scripts', 'ps-bridge.ps1');
const bridge = readFileSync(bridgePath, 'utf8');
const fn = bridge.slice(bridge.indexOf('function Cmd-GetFocusedElement'), bridge.indexOf('\nfunction ', bridge.indexOf('function Cmd-GetFocusedElement') + 1));

describe('ps-bridge get-focused-element — password fields', () => {
  it('reads IsPassword, skips reading the value when set, and reports secure', () => {
    expect(fn).toMatch(/\$isPassword = \[bool\]\$cur\.IsPassword/);
    expect(fn).toMatch(/if \(-not \$isPassword\) \{[\s\S]*ValuePattern/);
    expect(fn).toMatch(/secure\s+= \$isPassword/);
  });

  it.runIf(process.platform === 'win32')('the real bridge reports secure (false for an ordinary focused element)', () => {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
      { input: `${JSON.stringify({ cmd: 'get-focused-element' })}\nEXIT\n`, encoding: 'utf8', timeout: 60_000 });
    const reply = out.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(j => j && j.ready !== true && 'success' in j);
    if (!reply || reply.success === false) return;   // nothing focused (headless runner)
    expect(typeof reply.secure).toBe('boolean');
  });
});

describe('WindowsAdapter maps secure through', () => {
  it('a password field comes back secure; an ordinary one does not carry the flag', async () => {
    const { WindowsAdapter } = await import('../platform/windows');
    const a = new WindowsAdapter() as unknown as { normalizeElement: (raw: unknown) => { secure?: boolean } };
    expect(a.normalizeElement({ name: 'Password', controlType: 'ControlType.Edit', value: '', secure: true }).secure).toBe(true);
    expect(a.normalizeElement({ name: 'Search', controlType: 'ControlType.Edit', value: 'x', secure: false }).secure).toBeUndefined();
  });
});
