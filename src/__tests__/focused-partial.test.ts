/** get_focused_element: a focus search the platform cut (Linux, a wide window) is not "no focused element". */
import { describe, it, expect } from 'vitest';
import { getA11yTools } from '../tools/a11y';

const tool = getA11yTools().find(t => t.name === 'get_focused_element')!;
const ctxWith = (platform: object) => ({ ensureInitialized: async () => {}, platform }) as never;

describe('get_focused_element', () => {
  it('reports a cut search as an error, not as nothing focused', async () => {
    const r = await tool.handler({}, ctxWith({ lastFindError: 'partial', lastFindNote: 'cut at budget', getFocusedElement: async () => null }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cut at budget/);
  });
  it('still says nothing is focused when the search was complete', async () => {
    const r = await tool.handler({}, ctxWith({ lastFindError: null, getFocusedElement: async () => null }));
    expect(r.text).toBe('(no focused element)');
  });
});
