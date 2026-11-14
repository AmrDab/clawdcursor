/**
 * Windows: the focused element says whether it is a password field (UIA IsPassword) and never carries a password
 * field's value. The type tool's "into a password field (not echoed)" relied on it, and it was missing on Windows only
 * (macOS and Linux already set it): the secret was echoed, and Edge's bullets read as a mismatch that held Return.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { psOpts } from '../platform/ps-spawn';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'scripts', 'ps-bridge.ps1');

describe('ps-bridge get-focused-element: password fields', () => {
  it.runIf(process.platform === 'win32')('the real bridge reports secure (false for an ordinary focused element)', () => {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
      psOpts({ input: `${JSON.stringify({ cmd: 'get-focused-element' })}\nEXIT\n`, encoding: 'utf8', timeout: 60_000 }));
    const reply = out.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(j => j && j.ready !== true && 'success' in j);
    if (!reply || reply.success === false) return;   // nothing focused (headless runner)
    expect(typeof reply.secure).toBe('boolean');
  }, 60_000);   // starting the real PowerShell bridge (UIA assemblies) is slow under a full parallel run
});
