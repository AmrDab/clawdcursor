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

/** A sharp pipeline over a correctly ordered, opaque copy of the grab. */
export function sharpFromGrab(img: GrabImage): ReturnType<typeof sharp> {
  const raw = normalizeGrab(img);
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
}
