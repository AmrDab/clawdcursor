/**
 * Regression guards for PR #170 — physicalToMouse DPI coordinate conversion.
 *
 * These are SOURCE-LEVEL tests: they read native-desktop.ts as text and
 * exercise the pure physicalToMouse conversion logic extracted into a local
 * helper that mirrors the real implementation exactly. NativeDesktop is NOT
 * instantiated (nut-js requires a live display; vitest runs headless).
 *
 * WHAT IS LOCKED IN:
 *   1. physicalToMouse: identity at dpiRatio=1, correct division at dpiRatio=2.25.
 *   2. macOS special-case: physicalToMouse MUST be a no-op on darwin regardless
 *      of dpiRatio — callers already pass LOGICAL coords (cli.ts macOS mouseScaleFactor
 *      maps image→logical, not image→physical). Dividing again would double-correct.
 *   3. MCP computer path: image (x) × mouseScaleFactor → physical → ÷dpiRatio = logical.
 *      On Windows mouseScaleFactor = screenshotScaleFactor = physicalWidth/1280,
 *      so image × (physical/image) / (physical/logical) = logical. Correct.
 *   4. a11y/focus_window path via a11yToMouse: physical → ÷(ssf/msf) → mouse.
 *      On Windows ssf=msf=physical/image, so ssf/msf=1, a11yToMouse is identity,
 *      then physicalToMouse divides by dpiRatio → logical. Correct.
 *   5. The darwin guard in physicalToMouse must be the first branch (before the
 *      dpiRatio<=1 check) so macOS Retina (dpiRatio>1) still returns identity.
 *
 * See VERDICT section in the PR review for the full arithmetic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const nativeDesktopSrc = readFileSync(
  join(here, '..', 'platform', 'native-desktop.ts'),
  'utf8',
);

// ── Mirror of physicalToMouse extracted for headless testing ──────────────────
// Matches the implementation in native-desktop.ts physicalToMouse() exactly.
// If the implementation changes, this test will catch the divergence via the
// source-level assertions in the "source" suite below.
function makePhysicalToMouse(dpiRatio: number, platform: 'win32' | 'darwin' | 'linux') {
  return (x: number, y: number): { x: number; y: number } => {
    // macOS guard must be first — darwin is exempt from dpiRatio division
    // because callers already pass logical coords.
    if (platform === 'darwin') return { x, y };
    if (dpiRatio <= 1) return { x, y };
    return {
      x: Math.round(x / dpiRatio),
      y: Math.round(y / dpiRatio),
    };
  };
}

// ── 1. Core physicalToMouse semantics ────────────────────────────────────────
describe('physicalToMouse — coordinate conversion', () => {
  it('dpiRatio=1 (non-HiDPI) → identity on win32', () => {
    const fn = makePhysicalToMouse(1, 'win32');
    expect(fn(100, 200)).toEqual({ x: 100, y: 200 });
    expect(fn(0, 0)).toEqual({ x: 0, y: 0 });
    expect(fn(1920, 1080)).toEqual({ x: 1920, y: 1080 });
  });

  it('dpiRatio=2.25 (225% display) → divides by 2.25', () => {
    const fn = makePhysicalToMouse(2.25, 'win32');
    // physical (2250, 1350) → logical (1000, 600)
    expect(fn(2250, 1350)).toEqual({ x: 1000, y: 600 });
    // physical (2880, 1620) → logical (1280, 720)
    expect(fn(2880, 1620)).toEqual({ x: 1280, y: 720 });
    // physical (0, 0) → logical (0, 0)
    expect(fn(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('dpiRatio=2.0 (200% / Retina-equivalent) → halves coordinates on win32', () => {
    const fn = makePhysicalToMouse(2.0, 'win32');
    expect(fn(2560, 1440)).toEqual({ x: 1280, y: 720 });
    expect(fn(100, 200)).toEqual({ x: 50, y: 100 });
  });

  it('dpiRatio=1.25 (125% display) → divides by 1.25 on win32', () => {
    const fn = makePhysicalToMouse(1.25, 'win32');
    expect(fn(2400, 1350)).toEqual({ x: 1920, y: 1080 });
  });

  it('rounds to nearest integer on win32', () => {
    const fn = makePhysicalToMouse(2.25, 'win32');
    // physical (2251, 1351) → logical (Math.round(2251/2.25), Math.round(1351/2.25))
    // = Math.round(1000.44), Math.round(600.44) = 1000, 600
    expect(fn(2251, 1351)).toEqual({ x: 1000, y: 600 });
    // physical (2252, 1352) → logical (Math.round(1000.89), Math.round(601.33)) = 1001, 601
    expect(fn(2252, 1352)).toEqual({ x: 1001, y: 601 });
  });
});

// ── 2. macOS exemption — darwin must ALWAYS be a no-op ───────────────────────
describe('physicalToMouse — macOS exemption (critical for #154 non-regression)', () => {
  it('darwin + dpiRatio>1 → identity (not double-corrected)', () => {
    // On macOS, callers (MCP computer path via cli.ts createToolContext) already
    // map image → logical via mouseScaleFactor = logicalWidth / LLM_TARGET_WIDTH.
    // If physicalToMouse also divided by dpiRatio here, we'd apply the Retina
    // scale TWICE. The darwin guard must fire BEFORE the dpiRatio<=1 check.
    const fn = makePhysicalToMouse(2.0, 'darwin');
    expect(fn(1280, 720)).toEqual({ x: 1280, y: 720 });
    expect(fn(2560, 1440)).toEqual({ x: 2560, y: 1440 });
  });

  it('darwin + dpiRatio=1 → identity (trivially correct)', () => {
    const fn = makePhysicalToMouse(1, 'darwin');
    expect(fn(1280, 720)).toEqual({ x: 1280, y: 720 });
  });

  it('darwin + dpiRatio=2.25 → identity (no conversion)', () => {
    const fn = makePhysicalToMouse(2.25, 'darwin');
    expect(fn(2250, 1350)).toEqual({ x: 2250, y: 1350 });
  });
});

// ── 3. Linux — dpiRatio follows same logic as win32 ─────────────────────────
describe('physicalToMouse — linux', () => {
  it('linux + dpiRatio=2 → divides by 2', () => {
    const fn = makePhysicalToMouse(2, 'linux');
    expect(fn(2560, 1440)).toEqual({ x: 1280, y: 720 });
  });

  it('linux + dpiRatio=1 → identity', () => {
    const fn = makePhysicalToMouse(1, 'linux');
    expect(fn(1920, 1080)).toEqual({ x: 1920, y: 1080 });
  });
});

// ── 4. Coordinate pipeline composition (MCP computer path) ──────────────────
describe('MCP computer path — coordinate composition on 225% Windows display', () => {
  // On a 225% Windows display:
  //   physicalWidth = 2880 (what screen.grab() returns)
  //   logicalWidth  = 1280 (what SWF.Screen returns — 2880/2.25 = 1280)
  //   dpiRatio      = 2.25
  //   screenshotScaleFactor = mouseScaleFactor = physicalWidth / LLM_TARGET_WIDTH = 2880/1280 = 2.25
  //
  // Desktop mouse tools (src/tools/desktop.ts):
  //   image (x) --[× mouseScaleFactor=2.25]--> physical (x*2.25)
  //              --[÷ dpiRatio=2.25 in physicalToMouse]--> logical (x)
  //
  // Net result: image (x) → logical (x). nut-js (DPI-unaware) drives in logical. CORRECT.

  const mouseScaleFactor = 2.25;  // physicalWidth(2880) / LLM_TARGET_WIDTH(1280)
  const dpiRatio = 2.25;          // physicalWidth(2880) / logicalWidth(1280)
  const physicalToMouse = makePhysicalToMouse(dpiRatio, 'win32');

  it('image (400, 300) → physical → logical on 225% Win display', () => {
    const imageX = 400, imageY = 300;
    const physX = Math.round(imageX * mouseScaleFactor); // 900
    const physY = Math.round(imageY * mouseScaleFactor); // 675
    const result = physicalToMouse(physX, physY);
    // Expected logical: (900/2.25, 675/2.25) = (400, 300)
    expect(result).toEqual({ x: 400, y: 300 });
  });

  it('image (640, 360) → physical → logical is the same image coords', () => {
    const imageX = 640, imageY = 360;
    const physX = Math.round(imageX * mouseScaleFactor); // 1440
    const physY = Math.round(imageY * mouseScaleFactor); // 810
    const result = physicalToMouse(physX, physY);
    // (1440/2.25, 810/2.25) = (640, 360)
    expect(result).toEqual({ x: 640, y: 360 });
  });

  it('msf === dpiRatio on Windows (both are physical/1280 vs physical/logical)', () => {
    // mouseScaleFactor = physicalWidth / LLM_TARGET_WIDTH = physicalWidth / 1280
    // dpiRatio = physicalWidth / logicalWidth
    // On a standard 225% display logicalWidth = 1280, so msf === dpiRatio.
    // The image → physical → logical round-trip collapses to identity.
    // This is the CORRECT behavior: MCP tools pass image coords, nut-js needs logical.
    expect(mouseScaleFactor).toBe(dpiRatio);
  });
});

// ── 5. a11y path — coordinate composition on 225% Windows display ─────────────
describe('a11y path — coordinate composition on 225% Windows display', () => {
  // a11y/UIA bounds are in LOGICAL pixels (same space as Win32 mouse).
  // a11yToMouse (src/tools/types.ts): physicalCoord / (ssf / msf)
  // On Windows ssf = msf = physicalWidth/image, so ssf/msf = 1 → a11yToMouse is identity.
  // Then physicalToMouse divides by dpiRatio.
  //
  // Correct chain: logical (a11y) → ÷1 via a11yToMouse → same logical
  //                logical → physicalToMouse (win32) → divides by dpiRatio = 2.25
  //
  // BUT WAIT: a11y bounds are already LOGICAL. physicalToMouse expects PHYSICAL input
  // and outputs LOGICAL. Passing LOGICAL input → LOGICAL/dpiRatio = sub-logical.
  //
  // This is the KNOWN ISSUE flagged in the a11yToMouse docstring:
  //   "NOTE: Empirical testing shows a11y bounds and nut-js mouseClick share the
  //    same coordinate system on most Windows configs (both use screen coords from
  //    the same DPI-awareness level). This function may divide unnecessarily on
  //    some setups."
  //
  // The net behavior: a11y logical (x) → ÷dpiRatio → sub-logical.
  // On systems where UIA is DPI-unaware (returns physical), the path IS correct.
  // On systems where UIA is DPI-aware (returns logical), the path under-shoots.
  //
  // This is a SEPARATE pre-existing ambiguity — NOT introduced by PR #170.
  // The test below documents the math that #170 produces for this path.

  const screenshotScaleFactor = 2.25; // physicalWidth / LLM_TARGET_WIDTH
  const mouseScaleFactor = 2.25;      // same on Windows
  const dpiRatio = 2.25;
  const physicalToMouse = makePhysicalToMouse(dpiRatio, 'win32');

  it('a11yToMouse ratio is 1 when ssf===msf (Windows)', () => {
    const a11yDpiRatio = screenshotScaleFactor / mouseScaleFactor;
    expect(a11yDpiRatio).toBe(1);
    // a11yToMouse divides by this ratio → identity
    const physCoord = 500;
    const a11yMouseCoord = Math.round(physCoord / a11yDpiRatio);
    expect(a11yMouseCoord).toBe(500);
  });

  it('physical UIA coord (500) → a11yToMouse (500) → physicalToMouse (222) on 225% win32', () => {
    // If UIA returns PHYSICAL coords (DPI-unaware UIA mode):
    //   physical (500) → a11yToMouse identity (500) → physicalToMouse ÷2.25 → 222
    //   nut-js receives 222 (logical). Correct for physical-UIA mode.
    const physCoord = 500;
    const a11yDpiRatio = screenshotScaleFactor / mouseScaleFactor; // = 1
    const afterA11yToMouse = Math.round(physCoord / a11yDpiRatio);
    const { x: final } = physicalToMouse(afterA11yToMouse, 0);
    expect(final).toBe(222); // Math.round(500/2.25)
  });
});

// ── 6. Source-level guards (implementation must match the contract) ────────────
describe('native-desktop.ts source guards', () => {
  it('physicalToMouse has darwin early-return before dpiRatio check', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'physicalToMouse(');
    // darwin guard must appear before the dpiRatio<=1 guard
    const darwinIdx = body.indexOf('darwin');
    const dpiIdx = body.indexOf('dpiRatio <= 1');
    expect(darwinIdx).toBeGreaterThanOrEqual(0);
    expect(dpiIdx).toBeGreaterThanOrEqual(0);
    expect(darwinIdx).toBeLessThan(dpiIdx);
  });

  it('physicalToMouse divides by dpiRatio (not multiplies)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'physicalToMouse(');
    expect(body).toContain('/ this.dpiRatio');
    expect(body).not.toContain('* this.dpiRatio');
  });

  it('physicalToMouse uses Math.round', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'physicalToMouse(');
    expect(body).toContain('Math.round');
  });

  it('mouseClick routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseClick(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseDoubleClick routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseDoubleClick(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseRightClick routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseRightClick(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseMove routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseMove(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseScroll routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseScroll(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseDown routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseDown(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseUp routes through placePointer (any monitor; physicalToMouse as fallback)', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseUp(');
    expect(body).toContain('this.placePointer(');
  });

  it('mouseDrag places every waypoint through placePointer', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'async mouseDrag(');
    const count = (body.match(/this\.placePointer\(/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('placePointer: bridge move-cursor on Windows (any monitor), physicalToMouse fallback', () => {
    const body = extractMethodBody(nativeDesktopSrc, 'private async placePointer(');
    expect(body).toContain("cmd: 'move-cursor'");
    expect(body).toContain('physicalToMouse');
  });

  it('dpiRatio is detected via System.Windows.Forms on Windows', () => {
    // The detection logic compares screen.grab() physical pixels to SWF logical pixels.
    // This is the same ratio that mouseScaleFactor uses on the MCP tool path, ensuring
    // the two paths see the same dpiRatio.
    expect(nativeDesktopSrc).toContain('System.Windows.Forms');
    expect(nativeDesktopSrc).toContain('this.screenWidth / logicalW');
  });
});

// ── Helper ────────────────────────────────────────────────────────────────────
/** Extract a method body from source text (stops at next async/private/public at indent 2). */
function extractMethodBody(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) return '';
  const after = src.slice(start + header.length);
  const next = after.search(/\n {2}(?:async |private |public |\/\*\*)/);
  return next === -1 ? after : after.slice(0, next);
}
