/**
 * OCR click coordinates must be converted ONCE, and which side converts is
 * OS-dependent. See ocrPointToClickPoint in src/tools/smart.ts.
 */
import { describe, it, expect } from 'vitest';
import { ocrPointToClickPoint } from '../tools/smart';

describe('ocrPointToClickPoint — single conversion per OS', () => {
  it('Windows HiDPI: passes PHYSICAL through (mouseClick divides once itself)', () => {
    // Was divided here AND in physicalToMouse -> landed at target / 2.25^2.
    expect(ocrPointToClickPoint(1350, 900, 2.25, 'win32')).toEqual({ x: 1350, y: 900 });
  });

  it('Linux: passes PHYSICAL through', () => {
    expect(ocrPointToClickPoint(800, 600, 2, 'linux')).toEqual({ x: 800, y: 600 });
  });

  it('macOS Retina: divides to LOGICAL (mouseClick does not convert on darwin)', () => {
    // Removing this would re-introduce #154 — every click ~2x off on Retina.
    expect(ocrPointToClickPoint(800, 600, 2, 'darwin')).toEqual({ x: 400, y: 300 });
  });

  it('no scaling is a no-op everywhere', () => {
    for (const p of ['win32', 'linux', 'darwin'] as const) {
      expect(ocrPointToClickPoint(321, 123, 1, p)).toEqual({ x: 321, y: 123 });
    }
  });

  it('a missing/zero dpiRatio on macOS does not divide by zero', () => {
    expect(ocrPointToClickPoint(100, 50, 0, 'darwin')).toEqual({ x: 100, y: 50 });
  });
});
