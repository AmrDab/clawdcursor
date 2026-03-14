/**
 * Smart tools tests.
 *
 * Tests the smart_click, smart_read, smart_type, and invoke_element MCP tools.
 * Verifies a11y → CDP → OCR fallback chain, coordinate handling, and error cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps ────────────────────────────────────────────────────

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
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

// Mock OCR engine for OCR fallback tests
vi.mock('../ocr-engine', () => {
  return {
    OcrEngine: class MockOcrEngine {
      isAvailable() { return true; }
      async recognizeScreen() {
        return {
          elements: [
            { text: 'Submit', x: 100, y: 200, width: 80, height: 30, line: 1, confidence: 0.95 },
            { text: 'Cancel', x: 200, y: 200, width: 80, height: 30, line: 1, confidence: 0.92 },
            { text: 'File', x: 10, y: 10, width: 40, height: 20, line: 0, confidence: 0.98 },
          ],
          fullText: 'File Submit Cancel',
          durationMs: 300,
        };
      }
      invalidateCache() {}
    },
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────

import { getSmartTools } from '../tools/smart';
import type { ToolContext } from '../tools/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockMouseClick = vi.fn();
const mockKeyPress = vi.fn();
const mockInvalidateCache = vi.fn();
const mockGetActiveWindow = vi.fn().mockResolvedValue({
  title: 'Test App',
  processName: 'testapp',
  processId: 1234,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
});
const mockInvokeElement = vi.fn();
const mockFindElement = vi.fn();
const mockGetFocusedElement = vi.fn();
const mockGetScreenContext = vi.fn();
const mockWriteClipboard = vi.fn();

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    desktop: {
      mouseClick: mockMouseClick,
      keyPress: mockKeyPress,
    },
    a11y: {
      getActiveWindow: mockGetActiveWindow,
      invokeElement: mockInvokeElement,
      findElement: mockFindElement,
      getFocusedElement: mockGetFocusedElement,
      getScreenContext: mockGetScreenContext,
      writeClipboard: mockWriteClipboard,
      invalidateCache: mockInvalidateCache,
    },
    cdp: {
      isConnected: vi.fn().mockResolvedValue(false),
      getPage: vi.fn().mockReturnValue(null),
    },
    getMouseScaleFactor: () => 1.5,
    getScreenshotScaleFactor: () => 3.0,
    ensureInitialized: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveWindow.mockResolvedValue({
    title: 'Test App',
    processName: 'testapp',
    processId: 1234,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Smart Tools', () => {
  const tools = getSmartTools();
  const smartClick = tools.find(t => t.name === 'smart_click')!;
  const smartRead = tools.find(t => t.name === 'smart_read')!;
  const smartType = tools.find(t => t.name === 'smart_type')!;
  const invokeEl = tools.find(t => t.name === 'invoke_element')!;

  it('registers all 4 smart tools', () => {
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual(['smart_read', 'smart_click', 'smart_type', 'invoke_element']);
  });

  // ── smart_click ──

  describe('smart_click', () => {
    it('clicks via UIA invoke when available', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      expect(result.text).toContain('UI Automation');
      expect(result.text).toContain('invoke_element');
      expect(mockInvalidateCache).toHaveBeenCalled();
    });

    it('uses coordinate fallback when UIA invoke fails but bounds available', async () => {
      mockInvokeElement.mockResolvedValue({ success: false, clickPoint: { x: 500, y: 300 } });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      expect(result.text).toContain('coordinate fallback');
      // Coordinates should be passed directly — no a11yToMouse conversion
      expect(mockMouseClick).toHaveBeenCalledWith(500, 300);
    });

    it('falls through to OCR when UIA fails entirely', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      // Should find "Submit" in OCR elements and click at center
      expect(result.text).toContain('OCR');
      expect(result.text).toContain('Submit');
      // OCR element: x=100, y=200, width=80, height=30 → center at (140, 215)
      expect(mockMouseClick).toHaveBeenCalledWith(140, 215);
    });

    it('skips UIA for known empty-a11y apps', async () => {
      mockGetActiveWindow.mockResolvedValue({
        title: 'Terminal',
        processName: 'windowsterminal',
        processId: 5678,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      // Should skip UIA and go to OCR
      expect(mockInvokeElement).not.toHaveBeenCalled();
      expect(result.text).toContain('OCR');
    });

    it('reports all attempted methods on total failure', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      // OCR won't match "NonexistentButton"
      const result = await smartClick.handler({ target: 'NonexistentButton' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('smart_click failed');
      expect(result.text).toContain('Attempted');
    });

    it('matches OCR elements with partial text match', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Sub' }, ctx);
      // "Sub" partially matches "Submit"
      expect(result.text).toContain('OCR');
      expect(result.text).toContain('Submit');
    });
  });

  // ── smart_read ──

  describe('smart_read', () => {
    it('reads via a11y tree for window scope', async () => {
      mockGetScreenContext.mockResolvedValue('Full a11y tree here...\nWith multiple lines\nAnd buttons');
      const ctx = createCtx();
      const result = await smartRead.handler({ scope: 'window' }, ctx);
      expect(result.text).toContain('[via UI Automation active window]');
    });

    it('reads focused element for focused scope', async () => {
      mockGetFocusedElement.mockResolvedValue({
        name: 'Search',
        controlType: 'ControlType.Edit',
        bounds: { x: 100, y: 200, width: 300, height: 30 },
      });
      const ctx = createCtx();
      const result = await smartRead.handler({ scope: 'focused' }, ctx);
      expect(result.text).toContain('[via UI Automation focused element]');
      expect(result.text).toContain('Search');
    });

    it('falls through to OCR when a11y returns empty', async () => {
      mockGetScreenContext.mockResolvedValue('');
      const ctx = createCtx();
      const result = await smartRead.handler({ scope: 'window' }, ctx);
      expect(result.text).toContain('[via OCR');
    });

    it('skips a11y for known empty-a11y apps', async () => {
      mockGetActiveWindow.mockResolvedValue({
        title: 'Terminal',
        processName: 'windowsterminal',
        processId: 5678,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      mockGetScreenContext.mockResolvedValue('');
      const ctx = createCtx();
      const result = await smartRead.handler({ scope: 'window' }, ctx);
      // Should skip to OCR without trying a11y
      expect(mockGetScreenContext).not.toHaveBeenCalled();
      expect(result.text).toContain('[via OCR');
    });

    it('searches for specific target element via a11y', async () => {
      mockFindElement.mockResolvedValue([{
        name: 'Submit',
        controlType: 'ControlType.Button',
        automationId: 'btn-submit',
        bounds: { x: 100, y: 200, width: 80, height: 30 },
        isEnabled: true,
      }]);
      const ctx = createCtx();
      const result = await smartRead.handler({ target: 'Submit' }, ctx);
      expect(result.text).toContain('[via UI Automation search]');
      expect(result.text).toContain('Submit');
    });
  });

  // ── smart_type ──

  describe('smart_type', () => {
    it('types into currently focused element when no target specified', async () => {
      const ctx = createCtx();
      const result = await smartType.handler({ text: 'Hello world' }, ctx);
      expect(mockWriteClipboard).toHaveBeenCalledWith('Hello world');
      expect(mockKeyPress).toHaveBeenCalledWith('ctrl+v');
      expect(result.text).toContain('11 chars');
    });

    it('focuses target element via UIA before typing', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      const ctx = createCtx();
      const result = await smartType.handler({ text: 'test', target: 'Search box' }, ctx);
      expect(mockInvokeElement).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Search box', action: 'focus' })
      );
      expect(mockWriteClipboard).toHaveBeenCalledWith('test');
      expect(result.text).toContain('into "Search box"');
    });

    it('clicks to focus when UIA focus fails but bounds available', async () => {
      mockInvokeElement.mockResolvedValue({ success: false, clickPoint: { x: 400, y: 250 } });
      const ctx = createCtx();
      const result = await smartType.handler({ text: 'test', target: 'Input field' }, ctx);
      // Should click at coordinates directly (no a11yToMouse conversion)
      expect(mockMouseClick).toHaveBeenCalledWith(400, 250);
      expect(mockWriteClipboard).toHaveBeenCalledWith('test');
    });

    it('returns error when target element cannot be found', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartType.handler({ text: 'test', target: 'Nonexistent' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Could not find element');
    });
  });

  // ── invoke_element ──

  describe('invoke_element', () => {
    it('invokes element by name', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      const ctx = createCtx();
      const result = await invokeEl.handler({ name: 'Save', action: 'click' }, ctx);
      expect(result.text).toContain('Invoked "Save"');
      expect(result.text).toContain('click');
    });

    it('invokes element by automationId', async () => {
      mockInvokeElement.mockResolvedValue({ success: true, value: 'Hello' });
      const ctx = createCtx();
      const result = await invokeEl.handler({ automationId: 'txtSearch', action: 'get-value' }, ctx);
      expect(result.text).toContain('txtSearch');
      expect(result.text).toContain('Hello');
    });

    it('requires either name or automationId', async () => {
      const ctx = createCtx();
      const result = await invokeEl.handler({ action: 'click' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('required');
    });

    it('uses coordinate fallback for click when invoke fails', async () => {
      mockInvokeElement.mockResolvedValue({ success: false, clickPoint: { x: 300, y: 150 } });
      const ctx = createCtx();
      const result = await invokeEl.handler({ name: 'Button', action: 'click' }, ctx);
      expect(result.text).toContain('coordinate fallback');
      // Coordinates passed directly — no conversion
      expect(mockMouseClick).toHaveBeenCalledWith(300, 150);
    });

    it('returns error when element not found and no coordinates', async () => {
      mockInvokeElement.mockResolvedValue({ success: false, error: 'Element not found' });
      const ctx = createCtx();
      const result = await invokeEl.handler({ name: 'Ghost', action: 'click' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Element not found');
    });

    it('defaults action to click when not specified', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      const ctx = createCtx();
      await invokeEl.handler({ name: 'Button' }, ctx);
      expect(mockInvokeElement).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'click' })
      );
    });
  });
});
