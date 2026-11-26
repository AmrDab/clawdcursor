/**
 * The schema snapshot captures each OS's surface on that OS: text that depends on process.platform shows up under perOs,
 * not as the first OS's text for all three. And a field only some OS returns is kept.
 */
import { describe, it, expect } from 'vitest';

import { currentSnapshot, mergeByOs } from '../schema/snapshot';

describe('schema snapshot, per OS', () => {
  it('text that differs by OS is captured on each OS (the instructions name the keys of each OS)', async () => {
    const { surfaces } = JSON.parse(await currentSnapshot()) as {
      surfaces: { compact: { instructions?: unknown; perOs: Record<string, Record<string, string>> } };
    };
    const byOs = surfaces.compact.perOs.instructions;
    expect(surfaces.compact.instructions).toBeUndefined();
    expect(byOs.win32).toMatch(/runs Windows/);
    expect(byOs.darwin).not.toBe(byOs.win32);
    expect(byOs.linux).not.toBe(byOs.win32);
  }, 60_000);

  it('a field only some OS returns is kept, under perOs', () => {
    const merged = mergeByOs({ win32: { a: 1 }, linux: { a: 1 }, darwin: { a: 1, macOnly: true } });
    expect(merged).toEqual({ a: 1, perOs: { macOnly: { darwin: true, linux: undefined, win32: undefined } } });
  });
});
