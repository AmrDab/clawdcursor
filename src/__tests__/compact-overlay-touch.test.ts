/**
 * The overlay follows what an action DOES, not the compound it came through
 * (live Mac review 2026-10-15): `accessibility` is a tier-0 compound, so the
 * blind-mode actions on it — invoke, set_value — never showed the glow, while
 * `system` (tier 1) lit it for pure reads like ocr.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getCompactSurface } from '../tools/registry';
import { controlBanner } from '../core/banner';

const compound = (name: string) => getCompactSurface().find(t => t.name === name)!;
const ctx = { ensureInitialized: async () => { throw new Error('stub: not initialised'); } } as any;

afterEach(() => vi.restoreAllMocks());

describe('compact actions touch the overlay by their own tier', () => {
  it('accessibility invoke (an action) shows the overlay', async () => {
    const touch = vi.spyOn(controlBanner, 'touch').mockImplementation(() => {});
    await compound('accessibility').handler({ action: 'invoke', name: 'Save' }, ctx).catch(() => {});
    expect(touch).toHaveBeenCalled();
  });

  it('system ocr and accessibility read_tree (reads) do not', async () => {
    const touch = vi.spyOn(controlBanner, 'touch').mockImplementation(() => {});
    await compound('system').handler({ action: 'ocr' }, ctx).catch(() => {});
    await compound('accessibility').handler({ action: 'read_tree' }, ctx).catch(() => {});
    expect(touch).not.toHaveBeenCalled();
  });
});
