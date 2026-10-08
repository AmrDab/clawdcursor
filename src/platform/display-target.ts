/**
 * Which monitor a screenshot should show by default.
 *
 * On a multi-monitor desktop the agent's host (Claude, an editor, a terminal)
 * often sits on one monitor while the work happens on another — so "the
 * primary display" is the wrong default. clawdcursor remembers the last
 * point it acted on (a click / move in screen space, or a window it focused)
 * and the next screenshot shows the monitor containing it. Nothing is
 * configured per setup: positions, sizes and scaling come from the OS.
 */
import type { Display } from './types';

let workingPoint: { x: number; y: number } | null = null;

/** Remember where clawdcursor is working (mouse-space / screen coordinates). */
export function setWorkingPoint(x: number, y: number): void {
  if (Number.isFinite(x) && Number.isFinite(y)) workingPoint = { x: Math.round(x), y: Math.round(y) };
}
export function getWorkingPoint(): { x: number; y: number } | null { return workingPoint; }
export function resetWorkingPoint(): void { workingPoint = null; }

/** The display containing (x, y), or null. */
export function displayAt(displays: Display[], x: number, y: number): Display | null {
  return displays.find(d => x >= d.bounds.x && y >= d.bounds.y
    && x < d.bounds.x + d.bounds.width && y < d.bounds.y + d.bounds.height) ?? null;
}

/**
 * Pick the display to capture: an explicit index wins; otherwise the display
 * clawdcursor last worked on; otherwise the primary.
 */
export function pickDisplay(displays: Display[], explicit?: number): Display | null {
  if (!displays.length) return null;
  if (explicit !== undefined && Number.isFinite(explicit)) return displays.find(d => d.index === explicit) ?? null;
  if (workingPoint) {
    const d = displayAt(displays, workingPoint.x, workingPoint.y);
    if (d) return d;
  }
  return displays.find(d => d.primary) ?? displays[0];
}

/** One line telling the model which monitor it is looking at and how to see the others. */
export function displayNote(displays: Display[], shown: Display): string {
  if (displays.length < 2) return '';
  const others = displays.filter(d => d !== shown)
    .map(d => `#${d.index}${d.primary ? ' (primary)' : ''} ${d.bounds.width}x${d.bounds.height} at (${d.bounds.x},${d.bounds.y})`);
  return ` Showing display #${shown.index}${shown.primary ? ' (primary)' : ''} of ${displays.length}; ` +
    `others: ${others.join(', ')} — pass display:N to see one.`;
}
