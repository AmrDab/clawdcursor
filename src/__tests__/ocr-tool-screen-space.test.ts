/**
 * `ocr_read_screen` tells the model to click its coordinates as-is with
 * space:"screen". That only holds if the coordinates ARE screen space on every
 * OS: OCR reads physical pixels, which on a Retina Mac are 2x the logical
 * points a click takes (Windows / Linux clicks take physical pixels).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return true; }
    async recognizeScreen() {
      return { elements: [{ text: 'Save', x: 800, y: 600, width: 120, height: 40, confidence: 1, line: 0 }], fullText: 'Save', durationMs: 5 };
    }
  },
}));

import { getOcrTools } from '../tools/ocr';

const REAL_PLATFORM = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

async function read(platform: string, dpiRatio: number) {
  setPlatform(platform);
  const tool = getOcrTools().find(t => t.name === 'ocr_read_screen')!;
  const ctx = { ensureInitialized: async () => {}, desktop: { getDpiRatio: () => dpiRatio } } as any;
  const r = await tool.handler({}, ctx);
  return JSON.parse(r.text);
}

describe('ocr_read_screen returns screen coordinates on every OS', () => {
  afterEach(() => setPlatform(REAL_PLATFORM));

  it('macOS Retina: physical pixels → logical points', async () => {
    const out = await read('darwin', 2);
    expect(out.elements[0]).toMatchObject({ x: 400, y: 300, width: 60, height: 20 });
    expect(out.coordinateSystem).toBe('screen');
  });

  it('Windows and Linux: physical pixels are already screen space', async () => {
    for (const p of ['win32', 'linux']) {
      const out = await read(p, 2.25);
      expect(out.elements[0]).toMatchObject({ x: 800, y: 600, width: 120, height: 40 });
    }
  });
});
