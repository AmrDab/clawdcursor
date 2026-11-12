/**
 * #384 (benchmark web-long-read): copy_all_text returned a 52,715-char page in one result. Claude Code saved it to a file
 * and showed a 2 KB preview, so Sonnet and Haiku never saw the station table in the middle of the page. A result now
 * holds at most PAGE_TEXT_CAP chars and says how to get the rest; `find` returns only the lines holding one value.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
const page = { text: '' };
vi.mock('../platform/copy-all-text', async (orig) => ({
  ...(await orig<typeof import('../platform/copy-all-text')>()),
  copyAllText: vi.fn(async () => ({ ok: true, text: page.text, window: '[msedge] "Bench Reading"' })),
}));

import { pageTextPart, PAGE_TEXT_CAP } from '../platform/copy-all-text';
import { getCompactTools } from '../tools/compact';

/** The web-long-read page's shape: 60 paragraphs, a station table, 60 more. `cells`: how a row comes out — tab-separated
 *  (copied from a browser) or one cell per line (document text). */
function longread(cells: 'tab' | 'lines'): string {
  const para = (i: number) => `Section ${i}. ${'lorem ipsum dolor sit amet consectetur '.repeat(10).trim()}.`;
  const rows = Array.from({ length: 40 }, (_, i) => {
    const code = i + 1 === 17 ? 'QX-4462-MY' : `AB-${1000 + i}-ZZ`;
    return cells === 'tab' ? `Delta-${i + 1}\t${code}` : `Delta-${i + 1}\n${code}`;
  });
  return ['Bench Reading', ...Array.from({ length: 60 }, (_, i) => para(i + 1)), 'Station reference codes',
    cells === 'tab' ? 'Station\tReference code' : 'Station\nReference code', ...rows,
    ...Array.from({ length: 60 }, (_, i) => para(i + 61)), 'Answer', 'Submit'].join('\n');
}

describe('pageTextPart: one result is at most PAGE_TEXT_CAP chars', () => {
  it('a text under the cap comes back whole, as before', () => {
    expect(pageTextPart('short page', 'Edge')).toEqual({ head: '10 chars from Edge:', body: 'short page', tail: '' });
  });

  it('a long text is cut at the cap, ends at a line break, and says the total and the next offset', () => {
    const text = longread('tab');
    expect(text.length).toBeGreaterThan(40_000);
    const p = pageTextPart(text, 'Edge');
    expect(p.body.length).toBeLessThanOrEqual(PAGE_TEXT_CAP);
    expect(p.body.endsWith('\n')).toBe(true);
    expect(p.head).toBe(`${text.length} chars from Edge, showing chars 0-${p.body.length}:`);
    expect(p.tail).toContain(`the text runs to ${text.length}. Next part: copy_all_text with offset:${p.body.length}.`);
    expect(p.tail).toContain('find:"<text>"');
  });

  it('paging with offset returns every char once, in order, and the last part says nothing is left', () => {
    const text = longread('lines');
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 10 && offset < text.length; i++) {
      const p = pageTextPart(text, 'Edge', { offset });
      expect(p.body.length).toBeLessThanOrEqual(PAGE_TEXT_CAP);
      joined += p.body;
      offset += p.body.length;
      if (offset < text.length) expect(p.tail).toContain(`offset:${offset}.`);
      else expect(p.tail).toBe('');
    }
    expect(joined).toBe(text);
  });

  it('an offset past the end is an error that names the length', () => {
    expect(pageTextPart('abc', 'Edge', { offset: 45 })).toMatchObject({ isError: true, body: '', head: 'offset 45 is past the end: the text of Edge has 3 chars.' });
  });
});

describe('pageTextPart: find', () => {
  it.each(['tab', 'lines'] as const)('find "Delta-17" shows the row and its code (cells: %s)', (cells) => {
    const p = pageTextPart(longread(cells), 'Edge', { find: 'delta-17' });
    expect(p.head).toMatch(/^1 line of the \d+ chars from Edge contains "delta-17", with 2 lines around each:$/);
    expect(p.body).toContain('Delta-17');
    expect(p.body).toContain('QX-4462-MY');
    expect(p.body.split('\n').length).toBe(5);
    expect(p.tail).toBe('');
  });

  it('several matches: counted, contexts merged, gaps marked with …', () => {
    const text = ['a', 'b', 'x1', 'c', 'd', 'e', 'f', 'g', 'X2', 'h'].join('\n');
    const p = pageTextPart(text, 'Edge', { find: 'x' });
    expect(p.head).toContain('2 lines of the');
    expect(p.body).toBe(['a', 'b', 'x1', 'c', 'd', '…', 'f', 'g', 'X2', 'h'].join('\n'));
  });

  it('matches past the cap are counted, not shown', () => {
    const text = Array.from({ length: 50 }, (_, i) => `row ${i} key`).join('\n');
    const p = pageTextPart(text, 'Edge', { find: 'key' });
    expect(p.head).toContain('50 lines of the');
    expect(p.head).toContain('showing the first 20: make find more specific');
    expect(p.body).not.toContain('row 25 key');
  });

  it('a long line is shown around the match, not whole', () => {
    const text = `${'x'.repeat(5000)} code QX-4462-MY ${'y'.repeat(5000)}`;
    const p = pageTextPart(text, 'Edge', { find: 'QX-4462' });
    expect(p.body).toContain('QX-4462-MY');
    expect(p.body.length).toBeLessThan(250);
    expect(p.body.startsWith('…') && p.body.endsWith('…')).toBe(true);
  });

  it('no match says so, with an empty body', () => {
    expect(pageTextPart('abc', 'Edge', { find: 'zzz' })).toEqual({ head: 'No line of the 3 chars from Edge contains "zzz".', body: '', tail: '' });
  });
});

describe('system copy_all_text through the compact surface', () => {
  const ctx = () => ({
    ensureInitialized: async () => {}, platform: {} as any, a11y: { invalidateCache() {} } as any,
    desktop: {} as any, cdp: {} as any, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
  });
  const system = () => getCompactTools().find(t => t.name === 'system')!;

  it('find and offset are accepted (in the schema, not reported ignored) and the text stays wrapped', async () => {
    const schema = system().parameters;
    expect(schema.find?.type).toBe('string');
    expect(schema.offset?.type).toBe('number');
    page.text = longread('tab');
    const r = await system().handler({ action: 'copy_all_text', find: 'Delta-17' } as any, ctx() as any);
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/ignored/);
    expect(r.text).toMatch(/<untrusted-screen-content>[\s\S]*Delta-17\tQX-4462-MY[\s\S]*<\/untrusted-screen-content>/);
    const all = await system().handler({ action: 'copy_all_text' } as any, ctx() as any);
    expect(all.text.length).toBeLessThan(PAGE_TEXT_CAP + 1000);
    expect(all.text).toMatch(/<\/untrusted-screen-content>\nCut: /);
    const next = await system().handler({ action: 'copy_all_text', offset: 19_000 } as any, ctx() as any);
    expect(next.text).not.toMatch(/ignored/);
    expect(next.text).toMatch(/showing chars 19000-/);
  });
});

describe('accessibility find pages with offset', () => {
  const accessibility = () => getCompactTools().find(t => t.name === 'accessibility')!;
  const els = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}`, controlType: 'ListItem', bounds: { x: 10, y: 10 + i * 20, width: 100, height: 18 } }));
  const ctx = () => ({
    ensureInitialized: async () => {},
    platform: { findElements: async () => els, lastFindError: null },
    a11y: { invalidateCache: () => {} },
  }) as any;

  it('offset skips matches, and "... and N more" names the next offset', async () => {
    const first = await accessibility().handler({ action: 'find', name: 'Item' }, ctx());
    expect(first.text).toContain('"Item 19"');
    expect(first.text).toContain('... and 30 more — find again with offset:20');
    const r = await accessibility().handler({ action: 'find', name: 'Item', offset: 45 }, ctx());
    expect(r.text).not.toMatch(/ignored/);
    expect(r.text).not.toContain('"Item 44"');
    expect(r.text).toContain('"Item 45"');
    expect(r.text).toContain('"Item 49"');
    expect(r.text).not.toContain('more');
  });
});
