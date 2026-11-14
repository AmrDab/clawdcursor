/**
 * Mac review finding 1: a window list the helper's time budget cut short is a partial list, and get_windows says so.
 * (The read_screen agents call lists the focused window's tree only; its window list is get_windows.)
 */
import { describe, it, expect, vi } from 'vitest';
import { getTool } from '../tools/registry';
import type { ToolContext } from '../tools/types';

const R = { x: 0, y: 0, width: 100, height: 50 };
const win = { title: 'Doc', processName: 'TextEdit', processId: 7, bounds: R, isMinimized: false };

function ctxWith(listWindows: () => Promise<unknown[]>, platformOver: Record<string, unknown> = {}): ToolContext {
  return {
    ensureInitialized: vi.fn(),
    desktop: {},
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    platform: {
      listWindows: vi.fn(listWindows),
      getActiveWindow: vi.fn().mockResolvedValue(win),
      ...platformOver,
    },
  } as unknown as ToolContext;
}

describe('window list — partial (apps the time budget never reached)', () => {
  const note = '(partial list: the time budget ran out before 2 apps (Slow App, Other App) were read, so their windows are missing — call again)';
  const getWindows = getTool('get_windows')!;

  it('get_windows appends it after the list', async () => {
    const r = await getWindows.handler({}, ctxWith(async () => [win], { lastWindowListPartial: note }));
    expect(r.text).toContain('TextEdit');
    expect(r.text.trimEnd().endsWith(note)).toBe(true);
  });

  it('a complete list carries no note', async () => {
    const r1 = await getWindows.handler({}, ctxWith(async () => [win], { lastWindowListPartial: null }));
    const r2 = await getWindows.handler({}, ctxWith(async () => [win]));
    expect(r1.text).not.toMatch(/partial list/);
    expect(r2.text).not.toMatch(/partial list/);
  });
});
