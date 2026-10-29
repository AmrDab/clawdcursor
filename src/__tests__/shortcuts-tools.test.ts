/**
 * Shortcut tools tests.
 *
 * Tests the MCP-exposed shortcuts_list and shortcuts_execute tools.
 * Verifies filtering by category/context, fuzzy matching, execution,
 * auto-context detection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps ────────────────────────────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { getShortcutTools } from '../tools/shortcuts';
import type { ToolContext } from '../tools/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockKeyPress = vi.fn();
const mockInvalidateCache = vi.fn();
const mockGetActiveWindow = vi.fn();

function createMockContext(): ToolContext {
  return {
    desktop: { keyPress: mockKeyPress },
    a11y: {
      invalidateCache: mockInvalidateCache,
      getActiveWindow: mockGetActiveWindow,
    },
    cdp: {},
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: vi.fn(),
  } as unknown as ToolContext;
}

function getListTool() {
  return getShortcutTools().find(t => t.name === 'shortcuts_list')!;
}

function getExecuteTool() {
  return getShortcutTools().find(t => t.name === 'shortcuts_execute')!;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shortcuts_list', () => {
  it('lists all universal shortcuts when no filters given', async () => {
    const tool = getListTool();
    const result = await tool.handler({}, createMockContext());

    const data = JSON.parse(result.text);
    expect(data.count).toBeGreaterThan(10);
    expect(data.platform).toBeDefined();
    // Should NOT include context-specific shortcuts (e.g. reddit upvote)
    const ids = data.shortcuts.map((s: any) => s.id);
    expect(ids).not.toContain('reddit-upvote');
    expect(ids).not.toContain('x-like');
    // Should include universal ones
    expect(ids).toContain('scroll-down');
    expect(ids).toContain('copy');
    expect(ids).toContain('new-tab');
  });

  it('filters by category', async () => {
    const tool = getListTool();
    const result = await tool.handler({ category: 'browser' }, createMockContext());

    const data = JSON.parse(result.text);
    expect(data.count).toBeGreaterThan(0);
    for (const s of data.shortcuts) {
      expect(s.category).toBe('browser');
    }
    // Should contain browser shortcuts
    const ids = data.shortcuts.map((s: any) => s.id);
    expect(ids).toContain('new-tab');
    expect(ids).toContain('close-tab');
    expect(ids).toContain('refresh');
  });

  it('filters by context — includes universal + context-specific', async () => {
    const tool = getListTool();
    const result = await tool.handler({ context: 'reddit' }, createMockContext());

    const data = JSON.parse(result.text);
    const ids = data.shortcuts.map((s: any) => s.id);
    // Should include reddit-specific shortcuts
    expect(ids).toContain('reddit-upvote');
    expect(ids).toContain('reddit-next');
    // Should also include universal shortcuts
    expect(ids).toContain('scroll-down');
    expect(ids).toContain('copy');
    // Should NOT include other context-specific shortcuts (outlook, x)
    expect(ids).not.toContain('x-like');
    expect(ids).not.toContain('outlook-new-message');
  });

  it('filters by both category and context', async () => {
    const tool = getListTool();
    const result = await tool.handler({ category: 'social', context: 'reddit' }, createMockContext());

    const data = JSON.parse(result.text);
    for (const s of data.shortcuts) {
      expect(s.category).toBe('social');
    }
    const ids = data.shortcuts.map((s: any) => s.id);
    expect(ids).toContain('reddit-upvote');
    // x-like is social but wrong context
    expect(ids).not.toContain('x-like');
  });

  it('returns helpful message when no shortcuts match', async () => {
    const tool = getListTool();
    const result = await tool.handler({ category: 'social' }, createMockContext());

    // No context provided, so context-specific social shortcuts are excluded
    // and there are no universal social shortcuts → empty
    expect(result.text).toContain('No shortcuts found');
    expect(result.text).toContain('Available categories');
  });

  it('includes key combos resolved for current platform', async () => {
    const tool = getListTool();
    const result = await tool.handler({ category: 'navigation' }, createMockContext());

    const data = JSON.parse(result.text);
    const scrollDown = data.shortcuts.find((s: any) => s.id === 'scroll-down');
    expect(scrollDown).toBeDefined();
    expect(scrollDown.key).toBe('PageDown');
  });

  it('includes usage hint in response', async () => {
    const tool = getListTool();
    const result = await tool.handler({}, createMockContext());

    const data = JSON.parse(result.text);
    // Hint points at the compact `system` compound action (shortcuts_run), the
    // surface external agents actually call — not the granular delegate name.
    expect(data.hint).toContain('shortcuts_run');
  });

  it('drops shortcuts with no key on this platform and dedupes by id (F6)', async () => {
    const tool = getListTool();
    const result = await tool.handler({ category: 'window' }, createMockContext());
    const data = JSON.parse(result.text);
    const ids = data.shortcuts.map((s: { id: string }) => s.id);
    // No empty-key entries leak through…
    expect(data.shortcuts.every((s: { key: string }) => s.key && s.key.trim() !== '')).toBe(true);
    // …and no id appears twice.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('shortcuts_execute', () => {
  beforeEach(() => {
    mockKeyPress.mockReset();
    mockInvalidateCache.mockReset();
    mockGetActiveWindow.mockReset();
    mockGetActiveWindow.mockResolvedValue({ processName: 'msedge', title: 'Reddit - Home' });
  });

  it('executes an exact match shortcut', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    const result = await tool.handler({ intent: 'scroll down' }, ctx);

    expect(mockKeyPress).toHaveBeenCalledWith('PageDown');
    expect(mockInvalidateCache).toHaveBeenCalled();

    const data = JSON.parse(result.text);
    expect(data.executed).toBe('PageDown');
    expect(data.matchType).toBe('exact');
    expect(data.intent).toBe('scroll down');
  });

  it('executes a fuzzy match shortcut', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    // "scrll down" is close enough for fuzzy match (Levenshtein distance 1 from "scrolldown")
    const result = await tool.handler({ intent: 'page down' }, ctx);

    expect(mockKeyPress).toHaveBeenCalledWith('PageDown');
    const data = JSON.parse(result.text);
    expect(data.executed).toBe('PageDown');
  });

  it('uses provided context for context-specific shortcuts', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    const result = await tool.handler({ intent: 'upvote', context: 'reddit' }, ctx);

    expect(mockKeyPress).toHaveBeenCalledWith('a');
    const data = JSON.parse(result.text);
    expect(data.executed).toBe('a');
    expect(data.intent).toBe('upvote');
  });

  it('auto-detects context from active window', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    mockGetActiveWindow.mockResolvedValue({ processName: 'msedge', title: 'Reddit - Popular' });

    const result = await tool.handler({ intent: 'next post' }, ctx);

    expect(mockKeyPress).toHaveBeenCalledWith('j');
    const data = JSON.parse(result.text);
    expect(data.executed).toBe('j');
  });

  it('returns error with suggestions when no match found', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    const result = await tool.handler({ intent: 'fly to the moon' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No shortcut matched');
    expect(result.text).toContain('Try one of these');
    expect(mockKeyPress).not.toHaveBeenCalled();
  });

  it('reports active window in response', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    mockGetActiveWindow.mockResolvedValue({ processName: 'notepad', title: 'Untitled' });

    const result = await tool.handler({ intent: 'copy' }, ctx);

    const data = JSON.parse(result.text);
    expect(data.window).toContain('notepad');
    expect(data.window).toContain('Untitled');
  });

  it('handles getActiveWindow failure gracefully', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    mockGetActiveWindow.mockRejectedValue(new Error('A11y unavailable'));

    // Should still execute the shortcut
    const result = await tool.handler({ intent: 'paste' }, ctx);

    expect(mockKeyPress).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('calls ensureInitialized before executing', async () => {
    const tool = getExecuteTool();
    const ctx = createMockContext();
    await tool.handler({ intent: 'undo' }, ctx);

    expect(ctx.ensureInitialized).toHaveBeenCalled();
  });
});

// The safety gate sees only {intent, context}; the chord is resolved inside the
// handler. It used to be pressed with no blocklist or destructive-label check, so
// "close window" sent Alt+F4 and "send email" sent the send shortcut unconfirmed.
describe('shortcuts_execute gates the chord it resolves', () => {
  beforeEach(() => {
    mockKeyPress.mockReset();
    mockGetActiveWindow.mockReset();
    mockGetActiveWindow.mockResolvedValue({ processName: 'OUTLOOK', title: 'Inbox - Outlook' });
  });

  it.each(['send email', 'delete email', 'send message'])('needs confirmation for a destructive intent ("%s")', async (intent) => {
    const result = await getExecuteTool().handler({ intent }, createMockContext());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('safety confirm -');
    expect(mockKeyPress).not.toHaveBeenCalled();
  });

  it('needs confirmation for a confirm-tier chord (close window → Alt+F4 on Windows)', async () => {
    // os.platform() reads process.platform.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...desc, value: 'win32' });
    try {
      const result = await getExecuteTool().handler({ intent: 'close window' }, createMockContext());
      expect(result.isError).toBe(true);
      expect(result.text).toContain('safety confirm -');
      expect(result.text).toContain('Alt+F4');
      expect(mockKeyPress).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', desc); }
  });

  it('still presses an ordinary shortcut', async () => {
    const result = await getExecuteTool().handler({ intent: 'copy' }, createMockContext());
    expect(result.isError).toBeUndefined();
    expect(mockKeyPress).toHaveBeenCalledTimes(1);
  });
});
