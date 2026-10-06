/**
 * Any screen shape must produce a screenshot no provider resizes again, and the
 * image → mouse factor must map every image pixel back onto the same spot.
 *
 * Before: the scale came from WIDTH ONLY, so a 1080×1920 portrait screen sent a
 * 1080×1920 image (2 MP); the provider shrank it to ~804×1430 and every
 * coordinate the model read back landed ~25% short.
 */
import { describe, it, expect } from 'vitest';
import { llmScale, llmSize, imageScale, LLM_TARGET_WIDTH, LLM_MAX_PIXELS } from '../core/agent-loop/coord-scale';

const SCREENS: Array<[string, number, number]> = [
  ['800x600', 800, 600],
  ['1024x768', 1024, 768],
  ['1280x800', 1280, 800],
  ['1280x1024 (5:4)', 1280, 1024],
  ['1920x1080', 1920, 1080],
  ['2048x1536 (4:3)', 2048, 1536],
  ['2560x1440', 2560, 1440],
  ['2736x1824 (Surface, 3:2)', 2736, 1824],
  ['3440x1440 (ultrawide)', 3440, 1440],
  ['3840x2400 (225%)', 3840, 2400],
  ['5120x1440 (super-ultrawide)', 5120, 1440],
  ['1080x1920 (portrait)', 1080, 1920],
  ['1440x2560 (portrait)', 1440, 2560],
  ['2160x3840 (portrait 4K)', 2160, 3840],
  ['2048x2048 (square)', 2048, 2048],
];

describe('llmSize fits every screen shape inside the image limits', () => {
  for (const [name, w, h] of SCREENS) {
    it(name, () => {
      const s = llmSize(w, h);
      expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(LLM_TARGET_WIDTH);
      expect(s.width * s.height).toBeLessThanOrEqual(LLM_MAX_PIXELS + 2 * (s.width + s.height));
      expect(s.scale).toBeGreaterThanOrEqual(1);          // never upscaled
      // Same factor on both axes (≤ 1 image px of rounding drift at the far edge).
      expect(Math.abs(w / s.scale - s.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(h / s.scale - s.height)).toBeLessThanOrEqual(0.5);
    });
  }

  it('leaves screens that already fit untouched', () => {
    expect(llmSize(1024, 768)).toEqual({ scale: 1, width: 1024, height: 768 });
    expect(llmSize(1280, 800)).toEqual({ scale: 1, width: 1280, height: 800 });
  });

  it('keeps the old width-only result for 16:9 / 16:10 landscape', () => {
    expect(llmScale(2560, 1440)).toBe(2);
    expect(llmScale(3840, 2400)).toBe(3);
  });

  it('caps portrait by height (1080x1920 → 720x1280)', () => {
    expect(llmSize(1080, 1920)).toEqual({ scale: 1.5, width: 720, height: 1280 });
  });

  it('degenerate sizes do not divide by zero', () => {
    expect(llmScale(0, 0)).toBe(1);
    expect(llmScale(NaN, 100)).toBe(1);
  });
});

describe('imageScale maps image px to the mouse driver on every shape', () => {
  for (const [name, w, h] of SCREENS) {
    it(`${name}: Windows/Linux image edge → physical edge`, () => {
      const f = imageScale({ screen: { physicalWidth: w, physicalHeight: h }, _platform: 'win32' });
      const img = llmSize(w, h);
      expect(Math.abs(img.width * f - w)).toBeLessThanOrEqual(f);
      expect(Math.abs(img.height * f - h)).toBeLessThanOrEqual(f);
    });
  }

  it('macOS Retina maps onto LOGICAL points (#154)', () => {
    const f = imageScale({ screen: { physicalWidth: 2880, physicalHeight: 1800, logicalWidth: 1440, logicalHeight: 900 }, _platform: 'darwin' });
    expect(f).toBeCloseTo(1440 / 1280, 6);
  });

  it('macOS "larger text" (logical < image width) scales DOWN instead of clamping to 1', () => {
    const f = imageScale({ screen: { physicalWidth: 2560, physicalHeight: 1600, logicalWidth: 1024, logicalHeight: 640 }, _platform: 'darwin' });
    expect(f).toBeCloseTo(0.8, 6);
  });

  it('macOS portrait Retina uses the height-capped image width', () => {
    const f = imageScale({ screen: { physicalWidth: 2160, physicalHeight: 3840, logicalWidth: 1080, logicalHeight: 1920 }, _platform: 'darwin' });
    expect(f).toBeCloseTo(1080 / llmSize(2160, 3840).width, 6);
  });
});
