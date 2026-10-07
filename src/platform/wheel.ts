/**
 * nut-js scroll amount for ONE mouse-wheel notch on this OS.
 *
 * libnut passes its amount straight to the OS, and the unit differs:
 *   - Windows: MOUSEEVENTF_WHEEL mouseData, where WHEEL_DELTA = 120 is one
 *     notch. `scrollDown(3)` was 3/120 of a notch — a few pixels in Edge,
 *     so agents saw scrolling "barely move".
 *   - macOS: a PIXEL scroll event; ~40 px is one line in Cocoa/WebKit.
 *   - X11: one button-4/5 click per unit — already one notch.
 * Every scroll path multiplies its tick count by this, so "amount: 3" means
 * three notches everywhere.
 */
export function wheelUnitsPerNotch(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 120;
  if (platform === 'darwin') return 40;
  return 1;
}
