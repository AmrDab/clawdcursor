/**
 * read_screen — "START HERE", the cheapest perception tool — swallowed a failed window list into "(no windows found)".
 * On a Mac that was the 8 s osascript timeout (and, behind the lock screen, System Events' empty answers): the agent read
 * "no windows" as a fact about the desktop. A failure is now said to be a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { getA11yTools } from '../tools/a11y';
import type { ToolContext } from '../tools/types';

const tool = getA11yTools().find(t => t.name === 'read_screen')!;
const R = { x: 0, y: 0, width: 100, height: 50 };
const win = { title: 'Doc', processName: 'TextEdit', processId: 7, bounds: R, isMinimized: false };

function ctxWith(listWindows: () => Promise<unknown[]>): ToolContext {
  return {
    ensureInitialized: vi.fn(),
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    platform: {
      listWindows: vi.fn(listWindows),
      getActiveWindow: vi.fn().mockResolvedValue(win),
      getFocusedElement: vi.fn().mockResolvedValue(null),
      getUiTree: vi.fn().mockResolvedValue([]),
      lastTreeTruncated: false,
    },
  } as unknown as ToolContext;
}

describe('read_screen — the WINDOWS section', () => {
  it('a failed window list says it failed, with the reason — it is not "(no windows found)"', async () => {
    const r = await tool.handler({}, ctxWith(async () => { throw new Error('window list timed out after 25s — the accessibility service did not answer'); }));
    expect(r.text).toContain('window list failed');
    expect(r.text).toContain('timed out after 25s');
    expect(r.text).not.toContain('(no windows found)');
  });

  it('a window list that is genuinely empty still says so', async () => {
    const r = await tool.handler({}, ctxWith(async () => []));
    expect(r.text).toContain('(no windows found)');
    expect(r.text).not.toContain('window list failed');
  });

  it('a healthy list is listed', async () => {
    const r = await tool.handler({}, ctxWith(async () => [win]));
    expect(r.text).toContain('TextEdit');
    expect(r.text).not.toContain('window list failed');
  });
});
