/**
 * find_element on a window part of which did not answer. "accessibility search TIMED OUT on a very large window" was the only
 * wording for every incomplete read, including a quick miss next to one stubborn element (live blind run, 2026-10-19). A real
 * timeout keeps its words; a partial read says what it is: not found in the part that answered.
 */
import { describe, it, expect, vi } from 'vitest';
import { getA11yTools } from '../tools/a11y';

const find = getA11yTools().find(t => t.name === 'find_element')!;
const ctx = (platform: Record<string, unknown>) => ({
  ensureInitialized: async () => {},
  platform: { findElements: vi.fn(async () => []), ...platform },
  a11y: { findElement: vi.fn(async () => []) },
  cdp: { isConnected: async () => false },
}) as never;

describe('find_element', () => {
  it('a partial read: "not found in the readable part", with what to do next — and not "TIMED OUT"', async () => {
    const r = await find.handler({ name: 'Tahoe', processId: 5 }, ctx({
      lastFindError: 'partial',
      lastFindNote: 'element search: not found in the readable part of the window (1 element did not answer)',
    }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not found in the readable part of the window (1 element did not answer)');
    expect(r.text).toMatch(/read_tree/);
    expect(r.text).not.toMatch(/TIMED OUT/);
  });

  it('a real timeout keeps its words', async () => {
    const r = await find.handler({ name: 'x', processId: 5 }, ctx({ lastFindError: 'timeout' }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/TIMED OUT/);
  });
});
