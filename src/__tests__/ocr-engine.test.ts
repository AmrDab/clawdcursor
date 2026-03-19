/**
 * OcrEngine tests.
 *
 * Tests the OCR bridge logic: availability detection, caching, coordinate
 * offsetting for regions, JSON parsing from PowerShell output, and graceful
 * degradation on errors.
 *
 * Strategy: mock nut-js (screen.grab), sharp, child_process, and fs so
 * no actual screenshots or PowerShell processes are needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoist mock functions so they're available inside vi.mock factories ────────
const mockExecFile = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());

// ── Mock heavy native deps before any import ──────────────────────────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: {
    grab: vi.fn().mockResolvedValue({
      data: Buffer.alloc(4 * 100 * 100),   // 100×100 RGBA
      width: 100,
      height: 100,
    }),
  },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    extract: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

// Mock fs — track writeFileSync / unlinkSync calls without touching disk
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  };
});

// Mock child_process.execFile — must support util.promisify returning { stdout, stderr }
vi.mock('child_process', async () => {
  const { promisify } = await import('util');

  const execFileFn: any = (...args: unknown[]) => {
    const cb = args[args.length - 1];
    try {
      const result = mockExecFile();
      if (typeof cb === 'function') {
        (cb as Function)(null, result?.stdout ?? '', result?.stderr ?? '');
      }
    } catch (err) {
      if (typeof cb === 'function') {
        (cb as Function)(err);
      }
    }
  };

  // Set custom promisify so that promisify(execFile) returns { stdout, stderr }
  execFileFn[promisify.custom] = async (..._args: unknown[]) => {
    const result = mockExecFile();
    return { stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' };
  };

  return {
    execFile: execFileFn,
    exec: vi.fn(),
    spawn: vi.fn(),
  };
});

// ── Import the module under test ──────────────────────────────────────────────
import { OcrEngine } from '../ocr-engine';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REAL_PLATFORM = process.platform;

function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, writable: true, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, writable: true, configurable: true });
}

/** Sample OCR JSON output mimicking the PowerShell script's format */
function sampleOcrJson(elements: object[] = [], fullText = 'Hello World') {
  return JSON.stringify({ elements, fullText });
}

const SAMPLE_ELEMENTS = [
  { text: 'Hello', x: 10, y: 20, width: 50, height: 15, confidence: 1.0, line: 0 },
  { text: 'World', x: 70, y: 20, width: 55, height: 15, confidence: 1.0, line: 0 },
  { text: 'Test', x: 10, y: 50, width: 40, height: 15, confidence: 1.0, line: 1 },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OcrEngine', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockWriteFileSync.mockReset();
    mockUnlinkSync.mockReset();
  });

  afterEach(() => {
    restorePlatform();
  });

  // ── isAvailable ───────────────────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns true on Windows', () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      expect(eng.isAvailable()).toBe(true);
    });

    it('returns a boolean on macOS based on local Swift availability', () => {
      setPlatform('darwin');
      const eng = new OcrEngine();
      expect(typeof eng.isAvailable()).toBe('boolean');
    });

    it('returns false on Linux', () => {
      setPlatform('linux');
      const eng = new OcrEngine();
      expect(eng.isAvailable()).toBe(false);
    });

    it('never throws on any platform', () => {
      for (const p of ['win32', 'darwin', 'linux', 'freebsd']) {
        setPlatform(p);
        expect(() => new OcrEngine().isAvailable()).not.toThrow();
      }
    });

    it('caches the result on subsequent calls', () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      expect(eng.isAvailable()).toBe(true);
      // Changing platform shouldn't change cached result for same instance
      setPlatform('linux');
      expect(eng.isAvailable()).toBe(true);
    });
  });

  // ── recognizeScreen ───────────────────────────────────────────────────────

  describe('recognizeScreen()', () => {
    it('returns EMPTY_RESULT when unavailable', async () => {
      setPlatform('darwin');
      const eng = new OcrEngine();
      const result = await eng.recognizeScreen();
      expect(result.elements).toEqual([]);
      expect(result.fullText).toBe('');
    });

    it('parses OCR JSON output correctly on Windows', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson(SAMPLE_ELEMENTS, 'Hello World Test') });

      const result = await eng.recognizeScreen();

      expect(result.elements).toHaveLength(3);
      expect(result.elements[0]).toEqual(expect.objectContaining({ text: 'Hello', x: 10, y: 20 }));
      expect(result.elements[1]).toEqual(expect.objectContaining({ text: 'World', x: 70, y: 20 }));
      expect(result.elements[2]).toEqual(expect.objectContaining({ text: 'Test', line: 1 }));
      expect(result.fullText).toBe('Hello World Test');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('saves screenshot to temp file and cleans up', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson([]) });

      await eng.recognizeScreen();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      // Temp path should contain "clawdcursor-ocr"
      const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toContain('clawdcursor-ocr');
    });

    it('cleans up temp file even on OCR error', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: '{"error":"OCR failed"}' });

      const result = await eng.recognizeScreen();

      // Should degrade gracefully
      expect(result.elements).toEqual([]);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('handles empty elements array', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson([], '') });

      const result = await eng.recognizeScreen();

      expect(result.elements).toEqual([]);
      expect(result.fullText).toBe('');
    });

    it('marks unavailable if first call fails', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockImplementation(() => { throw new Error('PowerShell not found'); });

      const result = await eng.recognizeScreen();

      expect(result.elements).toEqual([]);
      expect(eng.isAvailable()).toBe(false);
    });
  });

  // ── Cache behavior ────────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached result within 300ms', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson(SAMPLE_ELEMENTS) });

      const first = await eng.recognizeScreen();

      // Change mock — but cached result should be returned
      mockExecFile.mockReturnValue({
        stdout: sampleOcrJson([{ text: 'Different', x: 0, y: 0, width: 10, height: 10, confidence: 1, line: 0 }]),
      });
      const second = await eng.recognizeScreen();

      // Should be the cached result, not the new one
      expect(second.elements).toEqual(first.elements);
      // execFile should have been called only once (first call)
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache() forces a fresh OCR call', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson(SAMPLE_ELEMENTS) });

      await eng.recognizeScreen();
      eng.invalidateCache();

      mockExecFile.mockReturnValue({
        stdout: sampleOcrJson([{ text: 'New', x: 0, y: 0, width: 10, height: 10, confidence: 1, line: 0 }]),
      });
      const result = await eng.recognizeScreen();

      expect(result.elements[0].text).toBe('New');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  // ── recognizeRegion ───────────────────────────────────────────────────────

  describe('recognizeRegion()', () => {
    it('offsets coordinates to screen space', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      // OCR returns coordinates relative to the cropped region
      const regionElements = [
        { text: 'Button', x: 5, y: 10, width: 40, height: 12, confidence: 1.0, line: 0 },
      ];
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson(regionElements) });

      // Region starts at (20, 30) — within 100×100 mock screen
      const result = await eng.recognizeRegion(20, 30, 50, 50);

      // Coordinates should be offset: (5+20, 10+30)
      expect(result.elements[0].x).toBe(25);
      expect(result.elements[0].y).toBe(40);
    });

    it('clamps region to screen bounds', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: sampleOcrJson([]) });

      // Screen is 100×100 (from mock). Request region beyond bounds.
      const result = await eng.recognizeRegion(90, 90, 200, 200);

      // Should not throw — clamped internally
      expect(result.elements).toEqual([]);
    });

    it('returns EMPTY_RESULT when unavailable', async () => {
      setPlatform('darwin');
      const eng = new OcrEngine();
      const result = await eng.recognizeRegion(0, 0, 100, 100);
      expect(result.elements).toEqual([]);
    });
  });

  // ── JSON parsing edge cases ───────────────────────────────────────────────

  describe('JSON parsing', () => {
    it('handles missing fields in elements gracefully', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({
        stdout: JSON.stringify({
          elements: [{ text: 'Hi' }],  // missing x, y, width, height, confidence, line
          fullText: 'Hi',
        }),
      });

      const result = await eng.recognizeScreen();

      expect(result.elements[0]).toEqual({
        text: 'Hi',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        confidence: 0,
        line: 0,
      });
    });

    it('handles null elements array', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({
        stdout: JSON.stringify({ elements: null, fullText: '' }),
      });

      const result = await eng.recognizeScreen();
      expect(result.elements).toEqual([]);
    });

    it('handles malformed JSON gracefully', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({ stdout: 'not-json{{{' });

      const result = await eng.recognizeScreen();
      expect(result.elements).toEqual([]);
    });

    it('handles error response from PowerShell', async () => {
      setPlatform('win32');
      const eng = new OcrEngine();
      mockExecFile.mockReturnValue({
        stdout: JSON.stringify({ error: 'No OCR languages installed' }),
      });

      const result = await eng.recognizeScreen();
      expect(result.elements).toEqual([]);
    });
  });
});
