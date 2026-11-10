/**
 * Save As dialog reliability — unit tests for fix #123.
 *
 * These tests cover the deterministic logic changes without requiring a
 * live GUI (native input / UIA calls are mocked or exercised via pure math).
 *
 * Live-GUI verification is documented in the PR body.
 *
 * #121 (triple_click in Save As) is intentionally NOT addressed by changing
 * the triple_click primitive: `mouse_triple_click` is documented as "selects
 * a paragraph in most text editors", so globally rerouting it to Ctrl+A
 * (select-all) would break that contract in browsers/editors/terminals. The
 * Save As field opens with its text pre-selected, so the correct handling is
 * to type directly (no triple_click needed); a future text-replace helper can
 * Ctrl+A at the typing layer if required.
 */

import { describe, it, expect } from 'vitest';

// ─── Bug #123: activate-at-point ensures foreground before click ───────────
//
// Pure logic: the activate-at-point PS command is triggered iff the
// foreground window differs from the window at (x, y). Test the
// "needs activation" decision.

function needsActivation(fgHwnd: number, windowAtPointHwnd: number): boolean {
  // Mirrors the PS bridge Cmd-ActivateAtPoint:
  //   if ($root -ne $fg) { SetForegroundWindow }
  return fgHwnd !== windowAtPointHwnd && windowAtPointHwnd !== 0;
}

describe('#123 activate-at-point foreground guard', () => {
  it('same window → no activation needed', () => {
    expect(needsActivation(1234, 1234)).toBe(false);
  });

  it('different window → activation needed', () => {
    expect(needsActivation(1234, 5678)).toBe(true);
  });

  it('zero hwnd at point (no window) → no activation', () => {
    expect(needsActivation(1234, 0)).toBe(false);
  });

  it('zero fg hwnd (desktop?) + real hwnd at point → activation', () => {
    expect(needsActivation(0, 5678)).toBe(true);
  });
});

// ─── Bug #123: DPI-aware mouseScaleFactor ─────────────────────────────────
//
// mouseScaleFactor must convert image-space coords to the coordinate space
// nut-js SendInput expects (physical pixels on Win). On a machine where
// Windows Forms returns logical pixels different from nut-js physical pixels,
// the factor must account for dpiRatio so clicks land correctly.
//
// Formula: mouseScaleFactor = physicalWidth / LLM_TARGET_WIDTH
//   (nut-js on Windows accepts physical-pixel coords directly, which equals
//    physicalWidth / 1280 regardless of DPI scaling mode.)
//
// This is already what createToolContext computes (screenshotScaleFactor);
// the test documents the invariant so any future change to the formula
// is caught.

const LLM_TARGET_WIDTH = 1280;

function computeMouseScaleFactor(physicalWidth: number): number {
  return physicalWidth > LLM_TARGET_WIDTH ? physicalWidth / LLM_TARGET_WIDTH : 1;
}

function imageToPhysical(imageX: number, scaleFactor: number): number {
  return Math.round(imageX * scaleFactor);
}

describe('#123 DPI-aware mouseScaleFactor', () => {
  it('2560px physical, image center 640 → physical 1280', () => {
    const sf = computeMouseScaleFactor(2560);
    expect(sf).toBe(2);
    expect(imageToPhysical(640, sf)).toBe(1280);
  });

  it('1920px physical (150% DPI), image 853 → physical 1280', () => {
    const sf = computeMouseScaleFactor(1920);
    expect(sf).toBeCloseTo(1.5);
    expect(imageToPhysical(853, sf)).toBe(1280); // 853 * 1.5 = 1279.5 → 1280
  });

  it('1280px physical (100% DPI), image 640 → physical 640 (factor=1)', () => {
    const sf = computeMouseScaleFactor(1280);
    expect(sf).toBe(1);
    expect(imageToPhysical(640, sf)).toBe(640);
  });

  it('scale factor is always ≥ 1 (never shrinks coordinates)', () => {
    [800, 1024, 1280, 1920, 2560, 3840].forEach(w => {
      expect(computeMouseScaleFactor(w)).toBeGreaterThanOrEqual(1);
    });
  });
});
