/** The macOS wake-up script run for real under osascript. Unit side: a11y-wake.test.ts. */
import { describe, it, expect, vi } from 'vitest';

describe.runIf(process.platform === 'darwin')('enable-accessibility.jxa (macOS only)', () => {
  it('runs under osascript and reports the AX result as JSON', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const path = await import('path');
    const script = path.resolve(__dirname, '../../scripts/mac/enable-accessibility.jxa');
    // pid 1 (launchd) is not an app: the call must still answer with the JSON shape
    // (ok:false and an AXError code on a CI runner without accessibility permission).
    const out = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, '1'], { encoding: 'utf8', timeout: 30_000 }).trim());
    expect(typeof out.ok).toBe('boolean');
    expect(typeof out.axError).toBe('number');
    const bad = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, 'nope'], { encoding: 'utf8', timeout: 30_000 }).trim());
    expect(bad.ok).toBe(false);
  }, 60_000);
});
