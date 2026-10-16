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
const mockGetWindows = vi.fn().mockResolvedValue([]);

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
      getWindows: mockGetWindows,
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
  mockGetWindows.mockResolvedValue([]);
});

/** Run `fn` with the mocked OCR engine returning `elements`. */
async function withOcr<T>(elements: Array<Record<string, unknown>>, fn: () => Promise<T>): Promise<T> {
  const { OcrEngine } = await import('../platform/ocr-engine');
  const orig = (OcrEngine.prototype as any).recognizeScreen;
  (OcrEngine.prototype as any).recognizeScreen = async () => ({
    elements, fullText: elements.map(e => e.text).join(' '), durationMs: 10,
  });
  try { return await fn(); } finally { (OcrEngine.prototype as any).recognizeScreen = orig; }
}

/** Run `fn` as if on `platform` (smart_click reads process.platform). */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Smart Tools', () => {
  const tools = getSmartTools();
  const smartClick = tools.find(t => t.name === 'smart_click')!;
  const smartRead = tools.find(t => t.name === 'smart_read')!;
  const smartType = tools.find(t => t.name === 'smart_type')!;
  const invokeEl = tools.find(t => t.name === 'invoke_element')!;

  it('smart_click "1" falls back to the calculator key name "One" (live Windows Calculator)', async () => {
    mockInvokeElement.mockImplementation(async (q: any) => q.name === 'One' ? { success: true } : { success: false });
    const r = await withOcr([], () => smartClick.handler({ target: '1' }, createCtx()));
    expect(mockInvokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'One', action: 'click' }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/UI Automation/);
  });

  it('smart_type focuses the FIELD when a same-named label comes first (live: "First name")', async () => {
    mockInvokeElement.mockResolvedValue({ success: false });   // focus by name hit the label
    mockFindElement.mockResolvedValue([
      { name: 'First name', controlType: 'Text', bounds: { x: 10, y: 10, width: 60, height: 14 } },
      { name: 'First name', controlType: 'Edit', bounds: { x: 80, y: 6, width: 200, height: 22 } },
    ]);
    const r = await smartType.handler({ target: 'First name', text: 'Ada' }, createCtx());
    expect(r.isError).toBeFalsy();
    expect(mockMouseClick).toHaveBeenCalledWith(180, 17);
  });

  it('smart_type still refuses when no editable element has the name', async () => {
    mockInvokeElement.mockResolvedValue({ success: false });
    mockFindElement.mockResolvedValue([{ name: 'First name', controlType: 'Text', bounds: { x: 10, y: 10, width: 60, height: 14 } }]);
    const r = await smartType.handler({ target: 'First name', text: 'Ada' }, createCtx());
    expect(r.isError).toBe(true);
    expect(mockMouseClick).not.toHaveBeenCalled();
  });

  it('Windows-style THROWN "not found" still tries the key name (live 01bb90b)', async () => {
    mockInvokeElement.mockImplementation(async (q: any) => {
      if (q.name === 'One') return { success: true };
      throw new Error('Element not found: "1"');
    });
    const r = await withOcr([], () => smartClick.handler({ target: '1' }, createCtx()));
    expect(r.isError).toBeFalsy();
    expect(mockInvokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'One' }));
  });

  it('Windows-style THROWN focus miss still falls back to the field (live 01bb90b)', async () => {
    mockInvokeElement.mockRejectedValue(new Error('Element not found: "First name"'));
    mockFindElement.mockResolvedValue([
      { name: 'First name', controlType: 'Text', bounds: { x: 10, y: 10, width: 60, height: 14 } },
      { name: 'First name', controlType: 'Edit', bounds: { x: 80, y: 6, width: 200, height: 22 } },
    ]);
    const r = await smartType.handler({ target: 'First name', text: 'Ada' }, createCtx());
    expect(r.isError).toBeFalsy();
    expect(mockMouseClick).toHaveBeenCalledWith(180, 17);
  });

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

    it('a 2-char fragment must NOT claim a short target (live: "sin" clicked an "in" in the top bar)', async () => {
      // Live Ubuntu VM 2026-10-15: xcalc's "sin" key was not read by OCR, but
      // an "in" in another window was — substring rule 2/3*0.9 = 0.6 — and
      // smart_click clicked it.
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = async () => ({
        elements: [{ text: 'in', x: 996, y: 22, width: 12, height: 14, line: 1, confidence: 0.9 }],
        fullText: 'in',
        durationMs: 100,
      });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx();
        const result = await smartClick.handler({ target: 'sin' }, ctx);
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

    it('prefers a standalone exact word over the same word inside a title phrase (live regression: "Save" clicked "Save as")', async () => {
      // Live Win11 VM 2026-10-14: smart_click("Save") on Notepad's Save as
      // dialog fell back to OCR, where the title "Save as" and the Save button
      // both held an exact "Save" token. The tie went to the first line — the
      // title — and the click landed on the title bar at (82,42).
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = async () => ({
        elements: [
          { text: 'Save',   x: 66,  y: 35,  width: 32, height: 14, line: 0,  confidence: 0.98 },
          { text: 'as',     x: 102, y: 38,  width: 14, height: 11, line: 0,  confidence: 0.98 },
          { text: 'Save',   x: 473, y: 461, width: 30, height: 14, line: 20, confidence: 0.97 },
          { text: 'Cancel', x: 560, y: 461, width: 44, height: 14, line: 20, confidence: 0.97 },
        ],
        fullText: 'Save as\nSave Cancel',
        durationMs: 100,
      });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx();
        const result = await smartClick.handler({ target: 'Save' }, ctx);
        expect(result.isError).toBeUndefined();
        const m = result.text.match(/at (\d+),(\d+)/);
        expect(m).toBeTruthy();
        expect(Number(m![2])).toBeGreaterThan(400); // the button row, not the title
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    it('a match that is only a word inside a sentence, with no visible effect, is NOT reported as a hit', async () => {
      // Live Win11 re-test 2026-10-15: smart_click("Resume") on the pause pill.
      // OCR never read the button's label, only the message "Windows blind
      // re-test: click Resume" — the click hit the sentence's last word, nothing
      // changed, and the tool still said "Clicked "Resume" via OCR".
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      const sentence = ['Windows', 'blind', 're-test:', 'click', 'Resume'];
      let x = 274;
      const elements = sentence.map(t => { const e = { text: t, x, y: 50, width: t.length * 7, height: 10, line: 19, confidence: 0.9 }; x += t.length * 7 + 5; return e; });
      elements.push({ text: 'End', x: 692, y: 90, width: 21, height: 10, line: 29, confidence: 0.9 }, { text: 'task', x: 718, y: 90, width: 25, height: 10, line: 29, confidence: 0.9 });
      const recognize = vi.fn(async () => ({ elements, fullText: 'Windows blind re-test: click Resume End task', durationMs: 50 }));
      (OcrEngine.prototype as any).recognizeScreen = recognize;
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: 'Resume' }, createCtx());
        expect(mockMouseClick).toHaveBeenCalledTimes(1);
        expect(recognize.mock.calls.length).toBeGreaterThanOrEqual(2); // re-read after the click
        // The click was performed: not an error (an error invites a second
        // click that re-flips a toggle), but clearly NOT confirmed.
        expect(result.isError).toBeFalsy();
        expect(result.text).toMatch(/NOT confirmed/);
        expect(result.text).toMatch(/inside/i);
        expect(result.text).toMatch(/Do NOT click it again/);
        expect(result.text).not.toMatch(/^Clicked "Resume"/);
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    it('a word inside a sentence that DID change the screen succeeds, flagged as text', async () => {
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      const words = ['Read', 'the', 'full', 'terms', 'here'];
      let x = 100;
      const elements = words.map(t => { const e = { text: t, x, y: 300, width: t.length * 7, height: 10, line: 4, confidence: 0.9 }; x += t.length * 7 + 5; return e; });
      let n = 0;
      (OcrEngine.prototype as any).recognizeScreen = async () => (++n === 1
        ? { elements, fullText: 'Read the full terms here', durationMs: 50 }
        : { elements: [], fullText: 'Terms of service 1. Scope', durationMs: 50 });
      try {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: 'terms' }, createCtx());
        expect(result.isError).toBeUndefined();
        expect(result.text).toMatch(/^Clicked "terms" via OCR/);
        expect(result.text).toMatch(/inside the text/i);
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
    });

    // ── B6: live macOS blind test 2026-10-15 — smart_click("1") with the
    // Calculator's pid clicked the menu-bar clock's "14" and opened
    // Notification Center, reported as a success.
    it('a short / numeric target never matches a substring of a longer token ("1" is not "14")', async () => {
      await withOcr([{ text: '14', x: 4290, y: 20, width: 36, height: 20, line: 0, confidence: 0.95 }], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: '1' }, createCtx());
        expect(result.isError).toBe(true);
        expect(mockMouseClick).not.toHaveBeenCalled();
      });
    });

    it('a short target still clicks the token that IS exactly it', async () => {
      await withOcr([
        { text: '14', x: 1700, y: 5, width: 30, height: 20, line: 0, confidence: 0.95 },
        { text: '1', x: 300, y: 500, width: 12, height: 20, line: 9, confidence: 0.9 },
      ], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: '1' }, createCtx());
        expect(result.isError).toBeUndefined();
        expect(mockMouseClick).toHaveBeenCalledWith(306, 510);
      });
    });

    it('with processId, refuses an OCR match outside that process window instead of clicking it', async () => {
      mockGetWindows.mockResolvedValue([
        { processId: 1234, title: 'Test App', processName: 'testapp', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isMinimized: false },
        { processId: 777, title: 'Calculator', processName: 'calculator', bounds: { x: 600, y: 300, width: 300, height: 400 }, isMinimized: false },
      ]);
      await withOcr([{ text: '1', x: 1800, y: 5, width: 12, height: 20, line: 0, confidence: 0.95 }], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: '1', processId: 777 }, createCtx());
        expect(result.isError).toBe(true);
        expect(mockMouseClick).not.toHaveBeenCalled();
        expect(result.text).toMatch(/outside the window of process 777/);
      });
    });

    it('with processId on a Retina Mac, finds the match inside that window (window bounds are points, OCR is physical)', async () => {
      // Calculator at points (1000,300) 230x400 -> physical (2000,600) 460x800.
      mockGetWindows.mockResolvedValue([
        { processId: 777, title: 'Calculator', processName: 'Calculator', bounds: { x: 1000, y: 300, width: 230, height: 400 }, isMinimized: false },
      ]);
      mockGetActiveWindow.mockResolvedValue({ title: 'Calculator', processName: 'Calculator', processId: 777, bounds: { x: 1000, y: 300, width: 230, height: 400 } });
      await onPlatform('darwin', () => withOcr([
        { text: '1', x: 2100, y: 1300, width: 20, height: 30, line: 7, confidence: 0.95 },
        { text: '1', x: 4300, y: 20, width: 10, height: 20, line: 0, confidence: 0.95 },
      ], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const ctx = createCtx({ desktop: { mouseClick: mockMouseClick, keyPress: mockKeyPress, getDpiRatio: () => 2 } as any });
        const result = await smartClick.handler({ target: '1', processId: 777 }, ctx);
        expect(result.isError).toBeUndefined();
        expect(mockMouseClick).toHaveBeenCalledWith(1055, 658);
        expect(result.text).not.toMatch(/WARNING/);
      }));
    });

    it('without processId, a match outside the focused window is still clicked with a warning', async () => {
      mockGetActiveWindow.mockResolvedValue({ title: 'Test App', processName: 'testapp', processId: 1234, bounds: { x: 0, y: 100, width: 500, height: 500 } });
      await withOcr([{ text: 'Submit', x: 1500, y: 20, width: 60, height: 20, line: 0, confidence: 0.95 }], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: 'Submit' }, createCtx());
        expect(result.isError).toBeUndefined();
        expect(result.text).toMatch(/WARNING: matched outside focused window/);
      });
    });

    // ── B8: live macOS 2026-10-15 — "Make Plain Text" was read by OCR as
    // "Make ... Text" and smart_click ran 24 s into deadline_exceeded.
    it('a multi-word target matches when OCR dropped one middle word', async () => {
      await withOcr([
        { text: 'Make', x: 400, y: 300, width: 40, height: 16, line: 5, confidence: 0.9 },
        { text: '...', x: 446, y: 300, width: 14, height: 16, line: 5, confidence: 0.5 },
        { text: 'Text', x: 466, y: 300, width: 34, height: 16, line: 5, confidence: 0.9 },
      ], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: 'Make Plain Text' }, createCtx());
        expect(result.isError).toBeUndefined();
        expect(result.text).toMatch(/^Clicked "Make Plain Text" via OCR/);
      });
    });

    it('a different middle word is NOT a fuzzy match ("Make Rich Text" is not "Make Plain Text")', async () => {
      await withOcr([
        { text: 'Make', x: 400, y: 300, width: 40, height: 16, line: 5, confidence: 0.9 },
        { text: 'Rich', x: 446, y: 300, width: 30, height: 16, line: 5, confidence: 0.9 },
        { text: 'Text', x: 482, y: 300, width: 34, height: 16, line: 5, confidence: 0.9 },
      ], async () => {
        mockInvokeElement.mockResolvedValue({ success: false });
        const result = await smartClick.handler({ target: 'Make Plain Text' }, createCtx());
        expect(result.isError).toBe(true);
        expect(mockMouseClick).not.toHaveBeenCalled();
      });
    });

    it('a slow a11y search with no OCR match fails as not-found, not deadline_exceeded', async () => {
      const slowMiss = vi.fn(() => new Promise(r => setTimeout(() => r({ success: false }), 400)));
      const ctx = createCtx({ a11y: { getActiveWindow: mockGetActiveWindow, invokeElement: slowMiss, findElement: mockFindElement,
        invalidateCache: mockInvalidateCache, getWindows: mockGetWindows } as any });
      const result = await smartClick.handler({ target: 'NeverGonnaMatchAnythingInOcr', timeout: 100 }, ctx);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.error).toBe('no_clickable_target');
      expect(parsed.tried.join(' ')).toMatch(/none matched/);
    });

    it('a11y "Element not found" does not trigger a second full tree search', async () => {
      const notFound = vi.fn().mockRejectedValue(new Error('Element not found: name="Make Plain Text"'));
      const ctx = createCtx({ a11y: { getActiveWindow: mockGetActiveWindow, invokeElement: notFound, findElement: mockFindElement,
        invalidateCache: mockInvalidateCache, getWindows: mockGetWindows } as any });
      await smartClick.handler({ target: 'Make Plain Text' }, ctx);
      expect(mockFindElement).not.toHaveBeenCalled();
    });

    it('says when the a11y invoke is still running (a modal box opened)', async () => {
      // Windows bridge: Save -> "Confirm Save As" keeps InvokePattern.Invoke
      // running; the bridge answers {pending:true} instead of blocking ~10 s.
      mockInvokeElement.mockResolvedValue({ success: true, data: { pending: true } });
      const result = await smartClick.handler({ target: 'Save' }, createCtx());
      expect(result.text).toMatch(/via UI Automation/);
      expect(result.text).toMatch(/still running.*re-read/i);
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
      // OCR must be cut off by the deadline too: an OCR that FINISHED with no
      // match is a plain not-found (no_clickable_target), whatever a11y took.
      const { OcrEngine } = await import('../platform/ocr-engine');
      const origRecognize = (OcrEngine.prototype as any).recognizeScreen;
      (OcrEngine.prototype as any).recognizeScreen = () =>
        new Promise(r => setTimeout(() => r({ elements: [], fullText: '', durationMs: 9000 }), 9000));
      let result;
      try {
        result = await smartClick.handler(
          // 200ms deadline (was 50ms — too tight under CI event-loop jitter);
          // still fires well before the 5000ms slow a11y invoke above.
          { target: 'NeverGonnaMatchAnythingInOcr', timeout: 200 },
          ctx,
        );
      } finally {
        (OcrEngine.prototype as any).recognizeScreen = origRecognize;
      }
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

    // B10: live macOS Save panel — smart_type {target:"Save As", text:"blind-note.txt"}
    // gave "blind-note.txt.txt" (macOS preselects only the base name).
    it('with a target, replaces the field content (select-all, then paste)', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      const result = await smartType.handler({ text: 'blind-note.txt', target: 'Save As' }, createCtx());
      expect(mockKeyPress.mock.calls.map(c => c[0])).toEqual(['mod+a', 'mod+v']);
      expect(result.text).toMatch(/replaced/);
    });

    it('mode:"append" types at the cursor without clearing the field', async () => {
      mockInvokeElement.mockResolvedValue({ success: true });
      await smartType.handler({ text: '.bak', target: 'Save As', mode: 'append' }, createCtx());
      expect(mockKeyPress.mock.calls.map(c => c[0])).toEqual(['mod+v']);
    });

    it('without a target, types at the cursor (never selects all of a document)', async () => {
      await smartType.handler({ text: 'hi' }, createCtx());
      expect(mockKeyPress.mock.calls.map(c => c[0])).toEqual(['mod+v']);
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
