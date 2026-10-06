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
vi.mock('../platform/ocr-engine', () => {
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

    it('uses a11y coordinate fallback when OCR has no match but a11y has bounds', async () => {
      // Use a target that OCR won't find — only a11y can locate it
      mockInvokeElement.mockResolvedValue({ success: false, clickPoint: { x: 500, y: 300 } });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'UniqueA11yButton' }, ctx);
      expect(result.text).toContain('a11y bounds');
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

    it('reports structured failure JSON with attempted methods on total failure', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      // OCR won't match "NonexistentButton"
      const result = await smartClick.handler({ target: 'NonexistentButton' }, ctx);
      // Existing callers still see truthy isError — that contract is preserved.
      expect(result.isError).toBe(true);
      // Smarter callers can JSON.parse(text) for structured diagnostics
      // (see issue #101: bare timeout used to discard this info).
      const parsed = JSON.parse(result.text);
      expect(parsed.error).toBe('no_clickable_target');
      expect(parsed.reason).toBe('all_fallbacks_failed');
      expect(parsed.target).toBe('NonexistentButton');
      expect(Array.isArray(parsed.tried)).toBe(true);
      expect(parsed.tried.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.candidates)).toBe(true);
      expect(typeof parsed.elapsedMs).toBe('number');
    });

    it('matches OCR elements with partial text match', async () => {
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Sub' }, ctx);
      // "Sub" partially matches "Submit"
      expect(result.text).toContain('OCR');
      expect(result.text).toContain('Submit');
    });

    it('multi-word target prefers an adjacent n-gram match over a stray single token (BUG-B)', async () => {
      // Reproduces the exam-page failure: the word "begin" appears alone in
      // instructional text, and "begin" + "exam" appear as two adjacent OCR
      // tokens forming the actual button. The old length-ratio ranker took
      // the stray "begin" (5/10 = 0.5) and silently mis-clicked. The n-gram
      // ranker must score the merged "begin exam" at 1.0 and win.
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = async () => ({
        elements: [
          // Stray "begin" in instruction text — wrong target
          { text: 'begin', x: 901, y: 415, width: 37, height: 14, line: 84, confidence: 0.9 },
          // The real button — two adjacent tokens on the same line
          { text: 'begin', x: 602, y: 877, width: 36, height: 13, line: 135, confidence: 0.95 },
          { text: 'exam',  x: 647, y: 880, width: 30, height:  7, line: 135, confidence: 0.95 },
        ],
        fullText: 'begin begin exam',
        durationMs: 100,
      });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx();
        const result = await smartClick.handler({ target: 'begin exam' }, ctx);
        expect(result.isError).toBeUndefined();
        // Must click the n-gram's centroid, NOT the stray token at y≈422
        const m = result.text.match(/at (\d+),(\d+)/);
        expect(m).toBeTruthy();
        const clickY = Number(m![2]);
        expect(clickY).toBeGreaterThan(800);
        expect(clickY).toBeLessThan(900);
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    it('a stray single-char OCR token must NOT claim a multi-char target (live regression: "OK" clicked "O" at 0.45)', async () => {
      // Live Outlook run 2026-06-06: a discard-draft dialog was open and the
      // agent called smart_click(target="OK"). OCR saw a stray "O" near the
      // taskbar; the substring rule scored it min(1,2)/max(1,2)*0.9 = 0.45,
      // which cleared the 0.40 floor — and the click landed at (164,749),
      // nowhere near the dialog. A 1-char token is OCR noise and must never
      // claim a multi-char target.
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = async () => ({
        elements: [
          { text: 'O', x: 160, y: 745, width: 8, height: 12, line: 99, confidence: 0.9 },
        ],
        fullText: 'O',
        durationMs: 100,
      });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx();
        const result = await smartClick.handler({ target: 'OK' }, ctx);
        expect(result.isError).toBe(true);
        expect(mockMouseClick).not.toHaveBeenCalled();
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    it('a repeated word cannot stand in for a missing one (live regression: "Row 50" clicked "Row Row")', async () => {
      // Live Ubuntu VM run 2026-10: smart_click("Row 50") on a list scrolled
      // to rows 01-17 matched two adjacent "Row" tokens. Token overlap counted
      // the duplicate twice — 2/2 coverage, 0.85 — and clicked the wrong row.
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = async () => ({
        elements: [
          { text: 'Row', x: 444, y: 126, width: 26, height: 10, line: 1, confidence: 0.97 },
          { text: 'Row', x: 474, y: 126, width: 26, height: 10, line: 1, confidence: 0.97 },
        ],
        fullText: 'Row Row',
        durationMs: 100,
      });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx();
        const result = await smartClick.handler({ target: 'Row 50' }, ctx);
        expect(result.isError).toBe(true);
        expect(mockMouseClick).not.toHaveBeenCalled();
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    // ── Issue #101: structured failure payloads ──

    it('successful click still returns plain human-readable text (not JSON)', async () => {
      // Sanity check: the JSON failure payload must NOT bleed into the
      // happy path. Existing string-matching callers depend on prose like
      // `Clicked "X" via OCR (matched ...)`.
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.text).toMatch(/^Clicked "Submit"/);
      // Must not be parseable JSON — that would mean we accidentally
      // routed a success through the failure builder.
      expect(() => JSON.parse(result.text)).toThrow();
    });

    it('accepts `name` as an alias for `target` (the rest of the a11y surface uses `name`)', async () => {
      // Shipped in 704311a — without this test a regression deleting the alias
      // would pass the whole suite silently.
      mockInvokeElement.mockResolvedValue({ success: false });
      const ctx = createCtx();
      const result = await smartClick.handler({ name: 'Submit' }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.text).toMatch(/^Clicked "Submit"/);
    });

    it('never reports failure for an a11y invoke that is still running — it waits for the outcome (no ghost click)', async () => {
      // Live macOS run (2026-10): smart_click("Row 50") returned
      // deadline_exceeded, then the still-running AXPress clicked Row 50 a
      // moment later. The invoke IS the click, so its outcome must be awaited;
      // only the read-only OCR search may be abandoned at the deadline.
      const lateSuccess = vi.fn(() => new Promise(r => setTimeout(() => r({ success: true }), 600)));
      const ctx = createCtx({
        a11y: {
          getActiveWindow: mockGetActiveWindow,
          invokeElement: lateSuccess,
          findElement: mockFindElement,
          getFocusedElement: mockGetFocusedElement,
          getScreenContext: mockGetScreenContext,
          writeClipboard: mockWriteClipboard,
          invalidateCache: mockInvalidateCache,
        } as any,
      });
      const result = await smartClick.handler({ target: 'NeverGonnaMatchAnythingInOcr', timeout: 200 }, ctx);
      expect(result.isError).toBeFalsy();
      expect(result.text).toMatch(/Clicked "NeverGonnaMatchAnythingInOcr" via UI Automation/);
    });

    it('returns structured JSON with error: "deadline_exceeded" when the deadline fires', async () => {
      // Force both OCR and a11y invoke to outlast the 50ms deadline.
      // The OLD bare-Promise.race would have thrown a bare timeout and
      // discarded the diagnostic state. The new deadline-aware loop must
      // return a structured payload instead, with isError still truthy.
      const slowInvoke = vi.fn(() => new Promise(r => setTimeout(() => r({ success: false }), 5000)));
      // Patch the mocked OCR engine for this one test to be slow.
      const ctx = createCtx({
        a11y: {
          getActiveWindow: mockGetActiveWindow,
          invokeElement: slowInvoke,
          findElement: mockFindElement,
          getFocusedElement: mockGetFocusedElement,
          getScreenContext: mockGetScreenContext,
          writeClipboard: mockWriteClipboard,
          invalidateCache: mockInvalidateCache,
        } as any,
      });
      // Slow down OCR too by patching the singleton via re-import isn't easy;
      // instead use a target the OCR mock won't match so OCR returns null
      // quickly — what we're testing is the a11y branch overrunning the deadline.
      const result = await smartClick.handler(
        // 200ms deadline (was 50ms — too tight under CI event-loop jitter);
        // still fires well before the 5000ms slow a11y invoke above.
        { target: 'NeverGonnaMatchAnythingInOcr', timeout: 200 },
        ctx,
      );
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.error).toBe('deadline_exceeded');
      expect(parsed.reason).toBe('deadline_exceeded');
      expect(parsed.target).toBe('NeverGonnaMatchAnythingInOcr');
      // The diagnostic state survived the deadline — that's the whole point.
      expect(Array.isArray(parsed.tried)).toBe(true);
      expect(parsed.tried.some((t: string) => t.includes('deadline_exceeded'))).toBe(true);
      expect(typeof parsed.elapsedMs).toBe('number');
    });

    it('returns structured JSON with at least one OCR candidate when OCR matched but click failed', async () => {
      // OCR sees "Submit" but mouseClick throws (simulates e.g. nut-js
      // raising on a coordinate that's behind a modal, or the OS denying
      // synthetic input). The failure payload must surface the OCR hit
      // as a candidate so the caller knows the text WAS found.
      mockInvokeElement.mockResolvedValue({ success: false });
      const throwingMouseClick = vi.fn().mockRejectedValue(new Error('synthetic input denied'));
      const ctx = createCtx({
        desktop: {
          mouseClick: throwingMouseClick,
          keyPress: mockKeyPress,
        } as any,
      });
      const result = await smartClick.handler({ target: 'Submit' }, ctx);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.error).toBe('no_clickable_target');
      expect(parsed.target).toBe('Submit');
      expect(parsed.candidates.length).toBeGreaterThanOrEqual(1);
      const ocrCandidate = parsed.candidates.find((c: any) => c.source === 'ocr');
      expect(ocrCandidate).toBeTruthy();
      expect(ocrCandidate.text).toBe('Submit');
      expect(ocrCandidate.bounds).toMatchObject({ x: 100, y: 200, w: 80, h: 30 });
    });
  });

  // ── smart_read ──

  describe('smart_read', () => {
    it('reads via OCR primary with a11y supplement for window scope', async () => {
      mockGetScreenContext.mockResolvedValue('Full a11y tree here...\nWith multiple lines\nAnd buttons');
      const ctx = createCtx();
      const result = await smartRead.handler({ scope: 'window' }, ctx);
      // OCR is primary — should appear first
      expect(result.text).toContain('[via OCR');
      // a11y tree should be appended as supplement
      expect(result.text).toContain('=== A11Y TREE (supplement) ===');
      expect(result.text).toContain('Full a11y tree here...');
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
      // Portable key combo — `mod+v` resolves to Cmd+V on macOS and Ctrl+V
      // elsewhere via the platform adapter, so smart_type stays
      // OS-agnostic without `process.platform` branching.
      expect(mockKeyPress).toHaveBeenCalledWith('mod+v');
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
      await smartType.handler({ text: 'test', target: 'Input field' }, ctx);
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

    it('falls back to coordinate click when invokeElement throws (RPC/UWP error)', async () => {
      mockInvokeElement.mockRejectedValue(new Error('RPC_E_SERVERFAULT'));
      mockFindElement.mockResolvedValue([{
        name: 'Calculate',
        controlType: 'ControlType.Button',
        automationId: '',
        bounds: { x: 200, y: 400, width: 60, height: 60 },
      }]);
      const ctx = createCtx();
      const result = await invokeEl.handler({ name: 'Calculate', action: 'click' }, ctx);
      expect(result.text).toContain('coordinate fallback');
      expect(mockMouseClick).toHaveBeenCalledWith(230, 430);
      expect(result.isError).toBeUndefined();
    });

    it('returns error when invokeElement throws and no element bounds found', async () => {
      mockInvokeElement.mockRejectedValue(new Error('AXError: element not available'));
      mockFindElement.mockResolvedValue([]);
      const ctx = createCtx();
      const result = await invokeEl.handler({ name: 'Ghost', action: 'click' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('invoke_element error');
    });
  });

  // ── smart_click RPC fallback ──

  describe('smart_click RPC fallback', () => {
    it('falls back to element bounds when invokeElement throws', async () => {
      mockInvokeElement.mockRejectedValue(new Error('RPC_E_SERVERFAULT'));
      mockFindElement.mockResolvedValue([{
        name: '7',
        controlType: 'ControlType.Button',
        automationId: 'num7Button',
        bounds: { x: 100, y: 300, width: 50, height: 50 },
      }]);
      const ctx = createCtx();
      const result = await smartClick.handler({ target: '7' }, ctx);
      expect(result.text).toContain('a11y bounds');
      expect(mockMouseClick).toHaveBeenCalledWith(125, 325);
    });
  });
});
