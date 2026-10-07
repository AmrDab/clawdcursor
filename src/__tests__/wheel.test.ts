/**
 * One scroll "tick" must be one wheel notch on every OS. libnut passes its
 * amount raw: Windows mouseData (120 = one notch), macOS pixels, X11 clicks.
 * Live regression (Windows, 2026-10): `scroll amount:3` sent 3/120 of a notch
 * — Notepad moved 0 lines; after the fix, ~9 lines (3 notches × 3 lines).
 */
import { describe, it, expect } from 'vitest';
import { wheelUnitsPerNotch } from '../platform/wheel';

describe('wheelUnitsPerNotch', () => {
  it('Windows: WHEEL_DELTA (120) per notch', () => expect(wheelUnitsPerNotch('win32')).toBe(120));
  it('macOS: ~one line of pixels per notch', () => expect(wheelUnitsPerNotch('darwin')).toBe(40));
  it('X11 / other: one button click per notch', () => expect(wheelUnitsPerNotch('linux')).toBe(1));
});
