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

function ctxWith(listWindows: () => Promise<unknown[]>, platformOver: Record<string, unknown> = {}): ToolContext {
  return {
    ensureInitialized: vi.fn(),
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    platform: {
      listWindows: vi.fn(listWindows),
      getActiveWindow: vi.fn().mockResolvedValue(win),
      getFocusedElement: vi.fn().mockResolvedValue(null),
      getUiTree: vi.fn().mockResolvedValue([]),
      lastTreeTruncated: false,
      ...platformOver,
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

describe('read_screen — the UI TREE section (Mac review finding 3)', () => {
  it('a failed tree read is reported, and the WINDOWS / FOCUSED ELEMENT sections survive', async () => {
    const ctx = ctxWith(async () => [win]);
    (ctx.platform as any).getUiTree = vi.fn(async () => { throw new Error('AX tree read timed out after 12s'); });
    const r = await tool.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('TextEdit');
    expect(r.text).toContain('(tree read failed: AX tree read timed out after 12s)');
    expect(r.text).toContain('FOCUSED ELEMENT');
  });
});

// Mac review finding 1: a window list the helper's time budget cut short is a partial list, and the tools say so.
describe('window list — partial (apps the time budget never reached)', () => {
  const note = '(partial list: the time budget ran out before 2 apps (Slow App, Other App) were read, so their windows are missing — call again)';
  const getWindows = getA11yTools().find(t => t.name === 'get_windows')!;

  it('read_screen appends the note to the WINDOWS section', async () => {
    const r = await tool.handler({}, ctxWith(async () => [win], { lastWindowListPartial: note }));
    const windowsSection = r.text.split('FOCUSED WINDOW UI TREE')[0];
    expect(windowsSection).toContain('TextEdit');
    expect(windowsSection).toContain(note);
  });

  it('get_windows appends it after the list', async () => {
    const r = await getWindows.handler({}, ctxWith(async () => [win], { lastWindowListPartial: note }));
    expect(r.text).toContain('TextEdit');
    expect(r.text.trimEnd().endsWith(note)).toBe(true);
  });

  it('a complete list carries no note', async () => {
    const r1 = await tool.handler({}, ctxWith(async () => [win], { lastWindowListPartial: null }));
    const r2 = await getWindows.handler({}, ctxWith(async () => [win]));
    expect(r1.text).not.toMatch(/partial list/);
    expect(r2.text).not.toMatch(/partial list/);
  });
});
