// The pass / fail rules of scripts/verify-macos.mjs that are worth testing on their own (src/__tests__/verify-macos-checks.test.ts).

/** The helper's window list must answer inside this. The osascript list it replaces took 9–11 s. */
export const WINDOW_LIST_FAST_MS = 3000;

/**
 * Verdict for "the helper's window list: fast, and nothing the old script saw is missing".
 *
 * `old` is the old osascript list, or null when that script failed or took over 90 s — which is exactly what happens on the
 * Macs the helper was written for. With nothing to compare against the check can only judge speed; counting "could not
 * compare" as a failure made the helper fail its own verification there.
 *
 * `lost` is how many of the old list's windows are missing from the helper's (null when `old` is null).
 */
export function windowListVerdict({ old, helperMs, lost }) {
  const fast = helperMs < WINDOW_LIST_FAST_MS;
  if (!old) {
    return { pass: fast, note: 'old osascript list failed or took over 90 s — not compared (that slowness is what the helper replaces)' };
  }
  return { pass: fast && lost === 0, note: lost ? `MISSING ${lost}` : '' };
}
