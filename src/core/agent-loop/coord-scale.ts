/**
 * Shared screenshot↔screen coordinate scaling.
 *
 * Two coordinate spaces exist and MUST NOT be mixed:
 *   - SCREEN space — the coordinate system the OS mouse driver consumes.
 *     Accessibility-snapshot coords are already in this space.
 *   - IMAGE space — the downscaled screenshot the model sees, capped at
 *     LLM_TARGET_WIDTH (1280). A target read off the screenshot is in this
 *     space and must be multiplied by `imageScale` to reach screen space.
 *
 * The vision `mouse` compound tool always works in IMAGE space and scales. The
 * granular click/drag/scroll tools default to SCREEN space (a11y coords pass
 * through) but accept IMAGE-space coords when the agent had to read a target
 * off the screenshot (e.g. an empty-a11y webview). Centralising the factor
 * here keeps both paths identical — the earlier bug was the granular tools
 * NOT scaling image coords, so a 1280-space click landed at half-position.
 *
 * PLATFORM NOTE — macOS Retina / HiDPI (#154):
 *   nut-js on macOS drives the cursor in LOGICAL POINTS (Cocoa/CGEvent space),
 *   not physical pixels. On a 2× Retina panel the physical width is double the
 *   logical width (e.g. 4480 physical / 2240 logical), so if we scaled
 *   image → physical the click would land twice as far right as intended.
 *   The correct target for the mouse driver is LOGICAL coords:
 *
 *     mouseScale(macOS)  = logicalWidth  / LLM_TARGET_WIDTH
 *     mouseScale(others) = physicalWidth / LLM_TARGET_WIDTH
 *
 *   The SCREENSHOT coordinate space is unchanged — screenshots are captured at
 *   physical resolution and downscaled to LLM_TARGET_WIDTH regardless of OS.
 *   Only the MOUSE INPUT mapping differs.
 */

/** Longest edge (px) of the screenshot the model sees. Width-only capping let
 *  portrait / 4:3 screens send images the provider silently shrank again, so
 *  every coordinate the model read back drifted. */
export const LLM_TARGET_WIDTH = 1280;
/** Area cap — under every major provider's resize threshold (Anthropic ≈1.15 MP). */
export const LLM_MAX_PIXELS = 1_150_000;

/**
 * THE downscale factor (physical px per image px) for a w×h capture: the
 * smallest ≥1 that fits the long edge in LLM_TARGET_WIDTH and the area in
 * LLM_MAX_PIXELS. Every capture path must use this so the reported scale, the
 * image and the mouse mapping agree on any screen shape.
 */
export function llmScale(w: number, h: number, maxEdge = LLM_TARGET_WIDTH): number {
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.max(1, w / maxEdge, h / maxEdge, Math.sqrt((w * h) / LLM_MAX_PIXELS));
}

/** Image size + scale the model gets for a w×h capture. */
export function llmSize(w: number, h: number, maxEdge = LLM_TARGET_WIDTH): { scale: number; width: number; height: number } {
  const scale = llmScale(w, h, maxEdge);
  return { scale, width: Math.max(1, Math.round(w / scale)), height: Math.max(1, Math.round(h / scale)) };
}

/**
 * Factor to convert IMAGE-space (screenshot) coords to the OS mouse driver's
 * coordinate space.
 *
 * On macOS nut-js drives in LOGICAL POINTS, so we scale image → logical.
 * On Windows / Linux nut-js drives in PHYSICAL PIXELS, so we scale image → physical.
 * The image is always the physical capture downscaled by llmScale(), so the
 * macOS factor is logicalWidth / imageWidth — which may be < 1 (a 2560-px
 * panel shown at 1024 points gives a 1280-px image: factor 0.8).
 *
 * `ctx.screen.logicalWidth` is populated by MacOSAdapter.getScreenSize().
 * `ctx.screen.physicalWidth/Height` are populated by all adapters.
 */
export function imageScale(ctx: {
  screen?: { physicalWidth?: number; physicalHeight?: number; logicalWidth?: number; logicalHeight?: number };
  _platform?: string; // injectable for tests; defaults to process.platform
}): number {
  const platform = ctx._platform ?? process.platform;
  const s = ctx.screen ?? {};
  const pw = s.physicalWidth || 0;
  // Height unknown → assume 16:10 so old callers keep width-based behaviour.
  const ph = s.physicalHeight || Math.round(pw * 10 / 16);
  if (platform === 'darwin') {
    // macOS: nut-js mouse operates in logical points.
    const lw = s.logicalWidth || 0;
    if (lw > 0 && pw > 0) return lw / llmSize(pw, ph).width;
    if (lw > 0) return llmScale(lw, s.logicalHeight || Math.round(lw * 10 / 16));
    // logicalWidth unavailable: fall back to physical (best effort — will
    // still be wrong on Retina but avoids a silent ×1 regress).
    return llmScale(pw, ph);
  }
  // Windows / Linux: nut-js mouse operates in physical pixels.
  return llmScale(pw, ph);
}

/** Round a coordinate after scaling. */
export function scaleCoord(v: number, scale: number): number {
  return Math.round(v * scale);
}

/**
 * Screen-center point in the coordinate space the OS mouse driver consumes —
 * LOGICAL points on macOS, PHYSICAL pixels on Windows/Linux. Used by the
 * no-coordinate scroll fallback ("scroll at the center of the screen"). Using
 * physicalWidth/2 on a 2× Retina panel fed a logical-space driver a coord at
 * the far edge (#154 double-count), so the wheel fired in the wrong region.
 */
export function screenCenter(ctx: {
  screen?: { physicalWidth?: number; physicalHeight?: number; logicalWidth?: number; logicalHeight?: number };
  _platform?: string;
}): { x: number; y: number } {
  const platform = ctx._platform ?? process.platform;
  const s = ctx.screen ?? {};
  if (platform === 'darwin') {
    const w = s.logicalWidth || s.physicalWidth || 0;
    const h = s.logicalHeight || s.physicalHeight || 0;
    return { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  }
  return { x: Math.floor((s.physicalWidth ?? 0) / 2), y: Math.floor((s.physicalHeight ?? 0) / 2) };
}
