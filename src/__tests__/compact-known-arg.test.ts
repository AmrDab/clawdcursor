/**
 * A compound's schema is the union of its actions' parameters, so a model passes `scope` (ocr's) to `copy_all_text`. A
 * parameter that is in the compound schema but not this action's is harmless and must not fail the call (live eval,
 * 2026-11-10); required-field checks stay.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('../platform/copy-all-text', async (orig) => ({
  ...(await orig<typeof import('../platform/copy-all-text')>()),
  copyAllText: vi.fn(async () => ({ ok: true, text: 'page text', window: 'Edge' })),
}));

import { getCompactTools } from '../tools/compact';

const ctx = () => ({
  ensureInitialized: async () => {}, platform: {} as any, a11y: { invalidateCache() {} } as any,
  desktop: {} as any, cdp: {} as any, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
});
const system = () => getCompactTools().find(t => t.name === 'system')!;

describe('compound dispatch: known-but-unused arguments', () => {
  for (const scope of ['window', 'screen']) {
    it(`copy_all_text accepts scope:"${scope}" and reads the focused window's document`, async () => {
      const r = await system().handler({ action: 'copy_all_text', scope } as any, ctx() as any);
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/9 chars from Edge/);
      expect(r.text).not.toMatch(/ignored/);
      if (scope === 'screen') expect(r.text).toMatch(/use ocr/);
    });
  }

  it('an argument no action of the compound has is still reported, and required fields are still enforced', async () => {
    const r = await system().handler({ action: 'copy_all_text', bogus_arg: 'x' } as any, ctx() as any);
    expect(r.text).toMatch(/ignored an argument it does not accept: bogus_arg/);
    const m = await system().handler({ action: 'clipboard_write' } as any, ctx() as any);
    expect(m.isError).toBe(true);
    expect(m.text).toMatch(/missing required field\(s\): text/);
  });
});
