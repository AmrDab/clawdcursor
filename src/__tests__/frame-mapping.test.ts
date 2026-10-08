/**
 * Screenshot coordinates map back through the frame they were read off —
 * any monitor, any position (negative origins included), any DPI. Field
 * setup: agent host on one monitor, target window on another.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mapImagePoint, mapImageLength, setLastFrame } from '../core/agent-loop/coord-scale';
import { toMouse, toImage, toMouseLength } from '../tools/types';

const ctx = (msf: number) => ({ getMouseScaleFactor: () => msf, getScreenshotScaleFactor: () => msf }) as never;

afterEach(() => setLastFrame(null));

describe('frame mapping', () => {
  it('primary frame (null) keeps the plain mouse scale — single-monitor behaviour unchanged', () => {
    setLastFrame(null);
    expect(mapImagePoint(640, 400, 3)).toEqual({ x: 1920, y: 1200 });
    expect(mapImageLength(100, 3)).toBe(300);
  });

  it('a secondary monitor to the RIGHT (different DPI) maps onto that monitor', () => {
    // primary 3840x2400 @225%; secondary 2560x1440 @100% at x=3840
    setLastFrame({ originX: 3840, originY: 0, scale: 2, display: 1 });
    expect(mapImagePoint(640, 360, 3)).toEqual({ x: 3840 + 1280, y: 720 });
    expect(mapImageLength(100, 3)).toBe(200);
  });

  it('a monitor LEFT of / ABOVE the primary (negative origin)', () => {
    setLastFrame({ originX: -1920, originY: -1080, scale: 1.5, display: 2 });
    expect(mapImagePoint(0, 0, 3)).toEqual({ x: -1920, y: -1080 });
    expect(mapImagePoint(1280, 720, 3)).toEqual({ x: 0, y: 0 });
  });

  it('tool helpers: screen space passes through; image space and cursor read are exact inverses', () => {
    setLastFrame({ originX: 3840, originY: -200, scale: 2, display: 1 });
    expect(toMouse(ctx(3), 500, 500, 'screen')).toEqual({ x: 500, y: 500 });
    const p = toMouse(ctx(3), 321, 123);
    expect(p).toEqual({ x: 3840 + 642, y: -200 + 246 });
    expect(toImage(ctx(3), p.x, p.y)).toEqual({ x: 321, y: 123 });
    expect(toMouseLength(ctx(3), 50)).toBe(100);
  });
});
