import { describe, it, expect } from 'vitest';
import { diffFrames, judgeRegion, movingMask, REGION_MIN_PIXELS, type Grey } from '../core/sense/frame-diff';

const frame = (w: number, h: number, fill = 200): Grey => ({ data: new Uint8Array(w * h).fill(fill), width: w, height: h });
const rect = (g: Grey, x: number, y: number, w: number, h: number, v: number): Grey => {
  const d = new Uint8Array(g.data);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) d[j * g.width + i] = v;
  return { ...g, data: d };
};

describe('diffFrames', () => {
  it('finds the bounding box of what changed', () => {
    const a = frame(100, 80);
    const b = rect(rect(a, 10, 20, 5, 5, 0), 40, 50, 3, 2, 0);
    expect(diffFrames(a, b)).toEqual({ count: 25 + 6, box: { x: 10, y: 20, width: 33, height: 32 } });
  });
  it('says nothing changed for identical frames', () => {
    expect(diffFrames(frame(20, 20), frame(20, 20))).toEqual({ count: 0, box: null });
  });
  it('ignores a luminance move under the threshold (compression noise)', () => {
    expect(diffFrames(frame(20, 20, 200), frame(20, 20, 190)).count).toBe(0);
  });
  it('refuses frames of different sizes', () => {
    expect(() => diffFrames(frame(10, 10), frame(10, 11))).toThrow(/differ in size/);
  });
  it('leaves out masked pixels', () => {
    const a = frame(10, 10), b = rect(a, 0, 0, 4, 4, 0);
    expect(diffFrames(a, b, { mask: movingMask(a, b) }).count).toBe(0);
  });
});

describe('judgeRegion', () => {
  const base = frame(200, 100);
  it('region_changed: a stroke lands', () => {
    const v = judgeRegion(base, rect(base, 20, 40, 60, 3, 0), base);
    expect(v.changed).toBe(true);
    expect(v.box).toEqual({ x: 20, y: 40, width: 60, height: 3 });
  });
  it('a blinking caret (2x20) is not a change', () => {
    const v = judgeRegion(base, rect(base, 50, 30, 2, 20, 0), base);
    expect(v.changed).toBe(false);
    expect(v.count).toBe(40);
    expect(40).toBeLessThan(REGION_MIN_PIXELS);
  });
  it('a caret that blinks during the baseline is masked even when it is big', () => {
    const caretOn = rect(base, 50, 30, 4, 30, 0);   // 120 px: above the minimum
    // the baseline caught it on, "before" caught it off, after: on again
    expect(judgeRegion(base, caretOn, caretOn).changed).toBe(false);
  });
  it('an animation already running is masked; a stroke elsewhere still counts', () => {
    const t0 = rect(base, 10, 10, 30, 30, 0), t1 = rect(base, 10, 10, 30, 30, 120);   // a spinner square, 900 px, moving
    const t2 = rect(base, 10, 10, 30, 30, 0);
    expect(judgeRegion(t1, t2, t0).changed).toBe(false);                                 // only the animation
    const withStroke = rect(t2, 100, 70, 50, 3, 0);
    expect(judgeRegion(t1, withStroke, t0).changed).toBe(true);                          // animation + a stroke
  });
  it('video: most of the region moving before the act gives no verdict', () => {
    const noisy = (seed: number): Grey => {
      const g = frame(100, 100);
      for (let i = 0; i < g.data.length; i++) g.data[i] = (i * 37 + seed * 91) % 256;
      return g;
    };
    const v = judgeRegion(noisy(1), noisy(2), noisy(3));
    expect(v.changed).toBe(false);
    expect(v.inconclusive).toMatch(/already changing/);
  });
  it('region_unchanged: nothing moved, so nothing changed', () => {
    const v = judgeRegion(base, frame(200, 100), base);
    expect(v).toMatchObject({ changed: false, count: 0 });
    expect(v.inconclusive).toBeUndefined();
  });
  it('works without a baseline (no motion check)', () => {
    expect(judgeRegion(base, rect(base, 0, 0, 20, 20, 0)).changed).toBe(true);
  });
});
