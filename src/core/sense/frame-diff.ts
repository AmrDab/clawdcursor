/**
 * Frame diff (#357, #358): where two greyscale frames of the same size differ. Pure: buffers in, region out — the capture
 * lives in pixel-watch.ts. One module for the effect line ("pixels changed in …") and for `expect` region_changed /
 * region_unchanged, so both mean the same thing by "changed".
 *
 * What does not count as a change:
 *   - small luminance noise: a pixel differs only when its grey level moves by LUMA_THRESHOLD or more (of 255) — video
 *     compression, anti-aliasing and a fading shadow stay under it;
 *   - a small area: fewer than `minPixels` differing pixels is a blinking caret or a hover glint, not an act's effect;
 *   - motion that was already there: pixels that differed between two frames taken BEFORE the act (`movingMask`) are left
 *     out of the comparison. A region that was mostly moving (video, an animation) cannot show an effect either way, so
 *     the verdict says so instead of guessing.
 */

export interface Grey { data: Uint8Array; width: number; height: number }
export interface Box { x: number; y: number; width: number; height: number }

/** A pixel changed when its grey level moved by at least this much (0-255). */
export const LUMA_THRESHOLD = 24;
/** Fewest differing pixels that count as an effect, for a region frame (≤ 512 px on its long edge). A caret is ~2×20. */
export const REGION_MIN_PIXELS = 64;
/** The same for the downscaled whole-screen frame, where everything is smaller. */
export const SCREEN_MIN_PIXELS = 12;
/** Past this share of a region moving before the act, no verdict about the act is possible. */
export const MOVING_LIMIT = 0.5;

export interface Diff { count: number; box: Box | null }

function same(a: Grey, b: Grey): void {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`frames differ in size (${a.width}x${a.height} vs ${b.width}x${b.height})`);
}

/** The pixels of `a` and `b` that differ by the threshold, as a 0/1 map. */
function changedMap(a: Grey, b: Grey, threshold: number): Uint8Array {
  same(a, b);
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0; i < out.length; i++) if (Math.abs(a.data[i] - b.data[i]) >= threshold) out[i] = 1;
  return out;
}

/** Pixels that moved between two frames taken before the act, grown by one pixel so a moving edge stays masked. */
export function movingMask(a: Grey, b: Grey, threshold = LUMA_THRESHOLD): Uint8Array {
  const m = changedMap(a, b, threshold);
  const { width: w, height: h } = a;
  const grown = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) grown[yy * w + xx] = 1;
    }
  }
  return grown;
}

/** How many pixels differ between `a` and `b` (outside `mask`), and the box around them. */
export function diffFrames(a: Grey, b: Grey, opts: { threshold?: number; mask?: Uint8Array } = {}): Diff {
  const m = changedMap(a, b, opts.threshold ?? LUMA_THRESHOLD);
  let count = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = y * a.width + x;
    if (!m[i] || opts.mask?.[i]) continue;
    count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { count, box: count ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null };
}

export interface RegionVerdict {
  /** The act changed the region (enough pixels, outside what was already moving). */
  changed: boolean;
  /** Set when no verdict can be given: most of the region was already moving before the act. */
  inconclusive?: string;
  count: number;
  box: Box | null;
}

/**
 * Did the act change a region? `before` and `after` bracket the act; `baseline`, when given, is a second frame taken just
 * before `before`, to find motion that needs no act.
 */
export function judgeRegion(before: Grey, after: Grey, baseline?: Grey, minPixels = REGION_MIN_PIXELS): RegionVerdict {
  const mask = baseline ? movingMask(baseline, before) : undefined;
  if (mask) {
    let moving = 0;
    for (const v of mask) moving += v;
    if (moving / mask.length > MOVING_LIMIT) {
      return { changed: false, count: 0, box: null,
        inconclusive: `${Math.round(100 * moving / mask.length)}% of the region was already changing before the act (video or animation)` };
    }
  }
  const d = diffFrames(before, after, { mask });
  return { changed: d.count >= minPixels, count: d.count, box: d.count >= minPixels ? d.box : null };
}
