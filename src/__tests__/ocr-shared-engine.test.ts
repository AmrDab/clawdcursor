/**
 * One OCR engine per process: every reader (the ocr tool, smart_click / smart_read, compile_ui, expect, pause_for_user's
 * done_when) shares its 300 ms cache, and any agent act empties it, so a read after an act never sees the screen before it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ocrEngine, type OcrResult } from '../platform/ocr-engine';
import { guardedInput, setInputGuard } from '../platform/pointer-guard';

const cached: OcrResult = { elements: [], fullText: 'before the act', durationMs: 1 };
const internals = (e: unknown) => e as { cachedResult: OcrResult | null; cacheTimestamp: number; available: boolean | null };

afterEach(() => setInputGuard(null));

describe('ocrEngine()', () => {
  it('is one engine', () => {
    expect(ocrEngine()).toBe(ocrEngine());
  });

  it('an agent act empties its cache', async () => {
    const e = internals(ocrEngine());
    e.available = true;
    e.cachedResult = cached;
    e.cacheTimestamp = Date.now();
    expect(await ocrEngine().recognizeScreen()).toBe(cached);   // fresh: served from the cache

    setInputGuard({
      stopCheck() {}, before: async () => {}, done() {}, focused: async () => {}, launched: async () => {}, byName: async () => {},
    });
    await guardedInput('keyPress', ['Return'], async () => undefined);
    expect(e.cachedResult).toBeNull();
  });
});
