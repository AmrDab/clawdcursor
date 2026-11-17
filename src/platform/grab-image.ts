/**
 * Shared normalisation for raw screen grabs before they reach sharp.
 *
 * nut-js `screen.grab()` returns BGR(A) pixels (`colorMode: 0`), not RGBA —
 * feeding the buffer to sharp as RGBA swapped red and blue in every
 * screenshot. On X11 (24-bit visuals) the 4th byte is also 0, which sharp
 * reads as "fully transparent", so resize/flatten produced a black image.
 * Screen captures carry no meaningful alpha, so we force it opaque.
 *
 * `normalizeGrab` fixes both IN PLACE (the callers drop the buffer right
 * after sharp consumes it) and returns the raw descriptor sharp needs.
 * `sharpFromGrab` is the one-liner every capture path should use.
 */

import sharp from 'sharp';

/** The subset of a nut-js Image we read. `colorMode` 0 = BGR (nut-js default), 1 = RGB. */
export interface GrabImage {
  data: Buffer;
  width: number;
  height: number;
  channels?: number;
  colorMode?: number;
}

export interface RawSpec {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

const COLOR_MODE_RGB = 1;

export function normalizeGrab(img: GrabImage): RawSpec {
  const channels = img.channels === 3 ? 3 : 4;
  const swap = img.colorMode !== COLOR_MODE_RGB;
  const data = img.data;
  const end = Math.min(img.width * img.height * channels, data.length);
  if (swap || channels === 4) {
    for (let i = 0; i + channels <= end; i += channels) {
      if (swap) {
        const b = data[i];
        data[i] = data[i + 2];
        data[i + 2] = b;
      }
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { data, width: img.width, height: img.height, channels };
}

export function sharpFromGrab(img: GrabImage): ReturnType<typeof sharp> {
  const raw = normalizeGrab(img);
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
}

/**
 * `screenshot({region})` on a whole-screen grab (macOS, Linux): the part of the region inside the `width` x `height` image,
 * in sharp's extract() shape — the intersection, never shifted (a region hanging off the left edge keeps its right edge).
 * Throws when the region and the screen do not overlap.
 */
export function clampRegion(
  region: { x: number; y: number; width: number; height: number }, width: number, height: number,
): { left: number; top: number; width: number; height: number } {
  const x0 = Math.round(region.x);
  const y0 = Math.round(region.y);
  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(width, x0 + Math.round(region.width));
  const bottom = Math.min(height, y0 + Math.round(region.height));
  if (right <= left || bottom <= top) {
    throw new Error(
      `Region (${region.x},${region.y}) ${region.width}x${region.height} is outside the ${width}x${height} screen: nothing to capture`,
    );
  }
  return { left, top, width: right - left, height: bottom - top };
}
