/**
 * focus_window tool tests — Bug 3 (processName filtering) + Bug 4 (off-screen recovery).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
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
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { getA11yTools } from '../tools/a11y';
import type { ToolContext } from '../tools/types';

const mockMouseClick = vi.fn();
const mockKeyPress = vi.fn();
const mockInvalidateCache = vi.fn();
const mockGetWindows = vi.fn();
const mockFocusWindow = vi.fn();
const mockGetActiveWindow = vi.fn();

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    desktop: {
      mouseClick: mockMouseClick,
      keyPress: mockKeyPress,
    },
    a11y: {
      getWindows: mockGetWindows,
      focusWindow: mockFocusWindow,
      getActiveWindow: mockGetActiveWindow,
      invalidateCache: mockInvalidateCache,
    },
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: vi.fn(),
    ...overrides,
  };
}

const tools = getA11yTools();
const focusWindow = tools.find(t => t.name === 'focus_window')!;

beforeEach(() => {
  vi.clearAllMocks();
  mockFocusWindow.mockResolvedValue({ success: true });
  mockGetActiveWindow.mockResolvedValue({
    title: 'Notepad', processName: 'notepad', processId: 100,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
  });
});

describe('focus_window — Bug 3: processName filtering', () => {
  it('prefers on-screen windows over off-screen ones with same processName', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 1, processName: 'notepad', title: 'Old Notepad', bounds: { x: -14, y: -14, width: 800, height: 600 }, isMinimized: false },
      { processId: 2, processName: 'notepad', title: 'Notepad', bounds: { x: 200, y: 100, width: 800, height: 600 }, isMinimized: false },
    ]);
    const ctx = createCtx();
    await focusWindow.handler({ processName: 'notepad' }, ctx);
    // Should focus pid 2 (on-screen), not pid 1 (off-screen at -14,-14)
    expect(mockFocusWindow).toHaveBeenCalledWith(undefined, 2);
  });

  it('AND-matches processName and title when both provided', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 1, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 100, y: 100, width: 800, height: 600 }, isMinimized: false },
      { processId: 2, processName: 'notepad', title: 'MyFile.txt - Notepad', bounds: { x: 200, y: 200, width: 800, height: 600 }, isMinimized: false },
    ]);
    const ctx = createCtx();
    await focusWindow.handler({ processName: 'notepad', title: 'MyFile' }, ctx);
    expect(mockFocusWindow).toHaveBeenCalledWith('MyFile', 2);
  });

  it('returns error when no visible window matches processName', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 1, processName: 'msedge', title: 'Edge', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isMinimized: false },
    ]);
    const ctx = createCtx();
    const result = await focusWindow.handler({ processName: 'notepad' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No window found');
  });

  it('prefers non-minimized windows over minimized ones', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 1, processName: 'notepad', title: 'A', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: true },
      { processId: 2, processName: 'notepad', title: 'B', bounds: { x: 100, y: 100, width: 800, height: 600 }, isMinimized: false },
    ]);
    const ctx = createCtx();
    await focusWindow.handler({ processName: 'notepad' }, ctx);
    expect(mockFocusWindow).toHaveBeenCalledWith(undefined, 2);
  });
});

describe('focus_window — Bug 4: off-screen recovery', () => {
  it('presses super+up when window bounds are off-screen after focus', async () => {
    // First getWindows call (for processName resolution): on-screen
    // After focusWindow: still at (-14, -14)
    mockGetWindows
      .mockResolvedValueOnce([
        // Phantom window scan (no phantoms — small window, on-screen)
        { processId: 42, processName: 'notepad', title: 'Notepad', bounds: { x: 100, y: 100, width: 800, height: 600 }, isMinimized: false },
      ])
      .mockResolvedValueOnce([
        // Window lookup for target matching
        { processId: 42, processName: 'notepad', title: 'Notepad', bounds: { x: 100, y: 100, width: 800, height: 600 }, isMinimized: false },
      ])
      .mockResolvedValueOnce([
        // After focusWindow, fresh read shows off-screen
        { processId: 42, processName: 'notepad', title: 'Notepad', bounds: { x: -14, y: -14, width: 800, height: 600 }, isMinimized: false },
      ])
      .mockResolvedValueOnce([
        // After snap, on-screen
        { processId: 42, processName: 'notepad', title: 'Notepad', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isMinimized: false },
      ])
      .mockResolvedValue([
        { processId: 42, processName: 'notepad', title: 'Notepad', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isMinimized: false },
      ]);

    mockGetActiveWindow.mockResolvedValue({
      title: 'Notepad', processName: 'notepad', processId: 42,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const ctx = createCtx();
    const result = await focusWindow.handler({ processName: 'notepad' }, ctx);
    const expectedSnapKey = process.platform === 'darwin' ? 'ctrl+cmd+f' : 'super+up';
    expect(mockKeyPress).toHaveBeenCalledWith(expectedSnapKey);
    expect(result.isError).toBeUndefined();
  });

  it('does NOT press snap key when window is already on-screen', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 10, processName: 'notepad', title: 'Notepad', bounds: { x: 200, y: 100, width: 800, height: 600 }, isMinimized: false },
    ]);
    const ctx = createCtx();
    await focusWindow.handler({ processName: 'notepad' }, ctx);
    expect(mockKeyPress).not.toHaveBeenCalledWith('super+up');
    expect(mockKeyPress).not.toHaveBeenCalledWith('ctrl+cmd+f');
  });

  it('skips coordinate click when targetBounds has negative x/y', async () => {
    mockGetWindows
      .mockResolvedValueOnce([
        { processId: 5, processName: 'calc', title: 'Calculator', bounds: { x: -14, y: -14, width: 400, height: 500 }, isMinimized: false },
      ])
      .mockResolvedValueOnce([
        { processId: 5, processName: 'calc', title: 'Calculator', bounds: { x: -14, y: -14, width: 400, height: 500 }, isMinimized: false },
      ])
      .mockResolvedValue([
        { processId: 5, processName: 'calc', title: 'Calculator', bounds: { x: 100, y: 100, width: 400, height: 500 }, isMinimized: false },
      ]);
    mockGetActiveWindow.mockResolvedValue({
      title: 'Calculator', processName: 'calc', processId: 5,
      bounds: { x: 100, y: 100, width: 400, height: 500 },
    });
    const ctx = createCtx();
    await focusWindow.handler({ processName: 'calc' }, ctx);
    // mouseClick should NOT be called with negative coords
    for (const call of mockMouseClick.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(0);
      expect(call[1]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('focus_window — owned dialogs', () => {
  // Live Win11 2026-10-14: `window focus` could not reach Notepad's Save as
  // dialog. Once the bridge finds owned dialogs, the tool must not "assert
  // focus" by clicking the window centre: on a dialog that click presses one
  // of its controls (the Save as file list's column header sits there).
  it('does not click inside an owned dialog the bridge focused', async () => {
    mockGetWindows.mockResolvedValue([
      { processId: 100, processName: 'notepad', title: 'notes.txt - Notepad', bounds: { x: 26, y: 26, width: 768, height: 519 }, isMinimized: false },
      { processId: 100, processName: 'notepad', title: 'Save as', bounds: { x: 32, y: 26, width: 625, height: 480 }, isMinimized: false },
    ]);
    mockFocusWindow.mockResolvedValue({ success: true, title: 'Save as', processId: 100, owned: true });
    mockGetActiveWindow.mockResolvedValue({
      title: 'Save as', processName: 'notepad', processId: 100,
      bounds: { x: 32, y: 26, width: 625, height: 480 },
    });
    const ctx = createCtx();
    const res = await focusWindow.handler({ processId: 100, title: 'Save as' }, ctx);
    expect(mockFocusWindow).toHaveBeenCalledWith('Save as', 100);
    expect(mockMouseClick).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('Save as');
  });
});
