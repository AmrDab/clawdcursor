/**
 * normalizeGrab / sharpFromGrab — the one place a nut-js grab is turned
 * into pixels sharp can encode.
 *
 * nut-js hands back BGR(A) (colorMode 0); on X11 24-bit visuals the 4th
 * byte is 0. Both must come out as the true, opaque RGB colour.
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { clampRegion, normalizeGrab, sharpFromGrab } from '../platform/grab-image';

async function decode(png: Buffer): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

describe('normalizeGrab', () => {
  it('swaps BGR → RGB and forces alpha opaque (nut-js default colorMode 0)', () => {
    // True colour (20,23,27) as GDI reports it, stored BGRA with alpha 0 (X11 case).
    const img = { data: Buffer.from([27, 23, 20, 0]), width: 1, height: 1, channels: 4, colorMode: 0 };
    const raw = normalizeGrab(img);
    expect(Array.from(raw.data)).toEqual([20, 23, 27, 255]);
    expect(raw.channels).toBe(4);
  });

  it('leaves RGB data alone apart from alpha (colorMode 1)', () => {
    const img = { data: Buffer.from([20, 23, 27, 0]), width: 1, height: 1, channels: 4, colorMode: 1 };
    expect(Array.from(normalizeGrab(img).data)).toEqual([20, 23, 27, 255]);
  });

  it('treats a grab with no colorMode as BGR (nut-js default)', () => {
    const img = { data: Buffer.from([27, 23, 20, 255]), width: 1, height: 1 };
    expect(Array.from(normalizeGrab(img).data)).toEqual([20, 23, 27, 255]);
  });

  it('handles 3-channel BGR without inventing an alpha byte', () => {
    const img = { data: Buffer.from([27, 23, 20, 204, 102, 51]), width: 2, height: 1, channels: 3, colorMode: 0 };
    const raw = normalizeGrab(img);
    expect(raw.channels).toBe(3);
    expect(Array.from(raw.data)).toEqual([20, 23, 27, 51, 102, 204]);
  });
});

describe('sharpFromGrab', () => {
  it('encodes the true colour for BGRA input with alpha 0 and 255', async () => {
    const img = {
      data: Buffer.from([27, 23, 20, 255, 204, 102, 51, 0]), // (20,23,27) then #3366CC
      width: 2, height: 1, channels: 4, colorMode: 0,
    };
    const png = await sharpFromGrab(img).png().toBuffer();
    expect(await decode(png)).toEqual([20, 23, 27, 255, 51, 102, 204, 255]);
  });

  it('survives a resize without going black (alpha-0 input used to be flattened to transparent)', async () => {
    const px = [204, 102, 51, 0];
    const img = { data: Buffer.from([...px, ...px, ...px, ...px]), width: 4, height: 1, channels: 4, colorMode: 0 };
    const png = await sharpFromGrab(img).resize(2, 1, { fit: 'fill' }).png().toBuffer();
    expect(await decode(png)).toEqual([51, 102, 204, 255, 51, 102, 204, 255]);
  });

  it('encodes RGB input (grim path) unchanged', async () => {
    const img = { data: Buffer.from([51, 102, 204, 255]), width: 1, height: 1, channels: 4, colorMode: 1 };
    const png = await sharpFromGrab(img).png().toBuffer();
    expect(await decode(png)).toEqual([51, 102, 204, 255]);
  });
});

describe('clampRegion — the region intersected with the screen, never shifted', () => {
  it('a region inside the screen is unchanged', () => {
    expect(clampRegion({ x: 10, y: 20, width: 100, height: 50 }, 1920, 1080)).toEqual({ left: 10, top: 20, width: 100, height: 50 });
  });

  it('off the left / top edge: the overlap only, its right / bottom edge kept', () => {
    expect(clampRegion({ x: -50, y: -30, width: 100, height: 80 }, 1920, 1080)).toEqual({ left: 0, top: 0, width: 50, height: 50 });
  });

  it('off the right / bottom edge: cut at the screen edge', () => {
    expect(clampRegion({ x: 1900, y: 1060, width: 100, height: 100 }, 1920, 1080)).toEqual({ left: 1900, top: 1060, width: 20, height: 20 });
  });

  it('no overlap at all is an error, not a 1x1 corner', () => {
    expect(() => clampRegion({ x: 2000, y: 10, width: 100, height: 100 }, 1920, 1080)).toThrow(/outside the 1920x1080 screen/);
    expect(() => clampRegion({ x: -200, y: 10, width: 100, height: 100 }, 1920, 1080)).toThrow(/outside/);
    expect(() => clampRegion({ x: 10, y: 1080, width: 100, height: 100 }, 1920, 1080)).toThrow(/outside/);
  });
});
