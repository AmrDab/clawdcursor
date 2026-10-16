/**
 * scripts/verify-macos.mjs is run by hand on a real Mac; its pass/fail rules live in scripts/verify-macos-checks.mjs
 * so they can be tested anywhere.
 *
 * Review finding 7: the "helper window list" check compared the helper with the old osascript list and FAILED when the
 * old script had failed or taken over 90 s (`lost === null`) — i.e. on exactly the Macs where the old script is too slow,
 * which is what the helper was written for.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getPackageRoot } from '../paths';

type Verdict = { pass: boolean; note: string };
type Checks = { windowListVerdict(o: { old: unknown[] | null; helperMs: number; lost: number | null }): Verdict };

const load = async (): Promise<Checks> =>
  (await import(pathToFileURL(path.join(getPackageRoot(), 'scripts', 'verify-macos-checks.mjs')).href)) as Checks;

describe('windowListVerdict', () => {
  it('fast, and nothing the old script saw is missing → pass', async () => {
    const { windowListVerdict } = await load();
    expect(windowListVerdict({ old: [{}, {}], helperMs: 400, lost: 0 }).pass).toBe(true);
  });

  it('fast, but the old script saw windows the helper lost → fail, and says how many', async () => {
    const { windowListVerdict } = await load();
    const v = windowListVerdict({ old: [{}, {}, {}], helperMs: 400, lost: 2 });
    expect(v.pass).toBe(false);
    expect(v.note).toMatch(/2/);
  });

  it('nothing lost, but too slow → fail', async () => {
    const { windowListVerdict } = await load();
    expect(windowListVerdict({ old: [{}], helperMs: 3500, lost: 0 }).pass).toBe(false);
  });

  it('REGRESSION: the old script failed or timed out (nothing to compare with) and the helper is fast → pass, not fail', async () => {
    const { windowListVerdict } = await load();
    const v = windowListVerdict({ old: null, helperMs: 400, lost: null });
    expect(v.pass).toBe(true);
    expect(v.note).toMatch(/not compared|failed|could not/i);
  });

  it('the old script failed and the helper is slow → still fail (speed is the other half of the check)', async () => {
    const { windowListVerdict } = await load();
    expect(windowListVerdict({ old: null, helperMs: 3500, lost: null }).pass).toBe(false);
  });

  it('an old list that is genuinely empty compares like any other', async () => {
    const { windowListVerdict } = await load();
    expect(windowListVerdict({ old: [], helperMs: 400, lost: 0 }).pass).toBe(true);
  });
});
