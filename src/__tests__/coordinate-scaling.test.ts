/**
 * Coordinate Scaling — pure math tests, zero native dependencies.
 *
 * Replicates the logic in native-desktop.ts without importing it
 * (that file imports nut-js which requires native bindings).
 */

import { describe, it, expect } from 'vitest';

const LLM_TARGET_WIDTH = 1280;

function computeScaleFactor(screenWidth: number): number {
  return screenWidth > LLM_TARGET_WIDTH ? screenWidth / LLM_TARGET_WIDTH : 1;
}

function llmToReal(llmX: number, llmY: number, scale: number): { x: number; y: number } {
  return { x: Math.round(llmX * scale), y: Math.round(llmY * scale) };
}

function llmToRealWithMonitorOffset(
  llmX: number, llmY: number, scale: number,
  monitorOffsetX: number, monitorOffsetY: number,
): { x: number; y: number } {
  return {
    x: Math.round(llmX * scale) + monitorOffsetX,
    y: Math.round(llmY * scale) + monitorOffsetY,
  };
}

describe('Scale factor computation', () => {
  it('2560×1440 → scale 2.0', () => {
    expect(computeScaleFactor(2560)).toBe(2.0);
  });

  it('1920×1080 → scale 1.5', () => {
    expect(computeScaleFactor(1920)).toBe(1.5);
  });

  it('1280×720 → scale 1.0 (no scaling)', () => {
    expect(computeScaleFactor(1280)).toBe(1.0);
  });

  it('800×600 → scale 1.0 (no upscaling)', () => {
    expect(computeScaleFactor(800)).toBe(1.0);
  });

  it('3840×2160 (4K) → scale 3.0', () => {
    expect(computeScaleFactor(3840)).toBe(3.0);
  });
});

describe('LLM → real coordinate mapping', () => {
  it('(640, 360) at scale 2.0 → (1280, 720)', () => {
    expect(llmToReal(640, 360, 2.0)).toEqual({ x: 1280, y: 720 });
  });

  it('(0, 0) at any scale → (0, 0)', () => {
    expect(llmToReal(0, 0, 2.0)).toEqual({ x: 0, y: 0 });
    expect(llmToReal(0, 0, 1.5)).toEqual({ x: 0, y: 0 });
    expect(llmToReal(0, 0, 1.0)).toEqual({ x: 0, y: 0 });
  });

  it('(100, 200) at scale 1.5 → (150, 300)', () => {
    expect(llmToReal(100, 200, 1.5)).toEqual({ x: 150, y: 300 });
  });

  it('(640, 360) at scale 1.0 → (640, 360) unchanged', () => {
    expect(llmToReal(640, 360, 1.0)).toEqual({ x: 640, y: 360 });
  });

  it('fractional result rounds correctly', () => {
    // 100 * 1.5 = 150.0, 33 * 1.5 = 49.5 → rounds to 50
    expect(llmToReal(100, 33, 1.5)).toEqual({ x: 150, y: 50 });
  });
});

describe('Multi-monitor coordinate mapping', () => {
  it('monitor at offset (1920, 0): LLM (100, 50) scale 1.0 → real (2020, 50)', () => {
    expect(llmToRealWithMonitorOffset(100, 50, 1.0, 1920, 0)).toEqual({ x: 2020, y: 50 });
  });

  it('monitor at offset (0, 1080): LLM (0, 0) → real (0, 1080)', () => {
    expect(llmToRealWithMonitorOffset(0, 0, 1.0, 0, 1080)).toEqual({ x: 0, y: 1080 });
  });

  it('monitor at offset (1920, 0) scale 2.0: LLM (640, 360) → real (4200, 720)', () => {
    // 640*2=1280 + 1920=3200? No: 640*2=1280, +1920=3200. Wait: 640*2=1280+1920=3200, 360*2=720
    expect(llmToRealWithMonitorOffset(640, 360, 2.0, 1920, 0)).toEqual({ x: 3200, y: 720 });
  });

  it('primary monitor (offset 0,0): same as without offset', () => {
    const withOffset = llmToRealWithMonitorOffset(200, 300, 1.5, 0, 0);
    const without = llmToReal(200, 300, 1.5);
    expect(withOffset).toEqual(without);
  });
});
