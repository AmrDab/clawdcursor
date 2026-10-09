/**
 * `ocr_read_screen` tells the model to click its coordinates as-is with
 * space:"screen". That only holds if the coordinates ARE screen space on every
 * OS: OCR reads physical pixels, which on a Retina Mac are 2x the logical
 * points a click takes (Windows / Linux clicks take physical pixels).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reads = vi.hoisted(() => ({ screen: 0, regions: [] as number[][] }));
vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return true; }
    async recognizeScreen() {
      reads.screen++;
      return { elements: [{ text: 'Save', x: 800, y: 600, width: 120, height: 40, confidence: 1, line: 0 }], fullText: 'Save', durationMs: 5 };
    }
    async recognizeRegion(x: number, y: number, w: number, h: number) {
      reads.regions.push([x, y, w, h]);
      return { elements: [{ text: 'Save', x: x + 10, y: y + 20, width: 120, height: 40, confidence: 1, line: 0 }], fullText: 'Save', durationMs: 2 };
    }
  },
}));

import { getOcrTools, windowOcrRegion } from '../tools/ocr';

const REAL_PLATFORM = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

const ACTIVE = { title: 'Notepad', processName: 'notepad', processId: 7, isMinimized: false, bounds: { x: 100, y: 50, width: 400, height: 300 } };

async function read(platform: string, dpiRatio: number, params: Record<string, unknown> = {}, active: unknown = ACTIVE) {
  setPlatform(platform);
  const tool = getOcrTools().find(t => t.name === 'ocr_read_screen')!;
  const ctx = {
    ensureInitialized: async () => {},
    desktop: { getDpiRatio: () => dpiRatio },
    platform: { getActiveWindow: async () => active },
  } as any;
  const r = await tool.handler(params, ctx);
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

describe('ocr_read_screen scope', () => {
  beforeEach(() => { reads.screen = 0; reads.regions.length = 0; });
  afterEach(() => setPlatform(REAL_PLATFORM));

  it('default: the whole screen, as before', async () => {
    const out = await read('win32', 1);
    expect(out.scope).toBe('screen');
    expect(reads.screen).toBe(1);
    expect(reads.regions).toEqual([]);
  });

  it('scope:"window" reads only the focused window rectangle (coordinates stay screen-space)', async () => {
    const out = await read('win32', 1, { scope: 'window' });
    expect(out.scope).toBe('window');
    expect(out.window).toBe('Notepad');
    expect(reads.regions).toEqual([[100, 50, 400, 300]]);
    expect(reads.screen).toBe(0);
    expect(out.elements[0]).toMatchObject({ x: 110, y: 70 });   // region origin already added back by the engine
  });

  it('scope:"window" falls back to the whole screen when there is no usable window', async () => {
    for (const bad of [null, { ...ACTIVE, isMinimized: true }, { ...ACTIVE, bounds: { x: 0, y: 0, width: 0, height: 0 } }]) {
      reads.screen = 0; reads.regions.length = 0;
      const out = await read('win32', 1, { scope: 'window' }, bad);
      expect(out.scope).toBe('screen');
      expect(reads.screen).toBe(1);
    }
  });

  it('macOS: window bounds are logical points, the OCR crop is in physical pixels', async () => {
    await read('darwin', 2, { scope: 'window' });
    expect(reads.regions).toEqual([[200, 100, 800, 600]]);
  });
});

describe('windowOcrRegion', () => {
  it('Windows / Linux: bounds are already physical', () => {
    expect(windowOcrRegion({ x: -3760, y: -1243, width: 820, height: 620 }, 2.25, 'win32')).toEqual({ x: -3760, y: -1243, width: 820, height: 620 });
    expect(windowOcrRegion({ x: 10, y: 20, width: 30, height: 40 }, 2, 'linux')).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
  it('macOS: scaled by the Retina ratio', () => {
    expect(windowOcrRegion({ x: 10, y: 20, width: 30, height: 40 }, 2, 'darwin')).toEqual({ x: 20, y: 40, width: 60, height: 80 });
  });
  it('no usable area → null', () => {
    expect(windowOcrRegion(undefined, 1, 'win32')).toBeNull();
    expect(windowOcrRegion({ x: 0, y: 0, width: 0, height: 10 }, 1, 'win32')).toBeNull();
  });
});
