/**
 * Which monitor a default screenshot shows — derived only from the layout the
 * OS reports and where clawdcursor last worked. No per-setup configuration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pickDisplay, displayAt, displayNote, setWorkingPoint, resetWorkingPoint } from '../platform/display-target';
import type { Display } from '../platform/types';

const D = (index: number, x: number, y: number, w: number, h: number, primary = false, dpiRatio = 1): Display =>
  ({ index, label: `D${index}`, primary, bounds: { x, y, width: w, height: h }, physicalSize: { width: w, height: h }, dpiRatio });

// laptop 3840x2400 @225% primary; big monitor 2560x1440 @100% LEFT of it, top-aligned
const layoutLeft = [D(0, 0, 0, 3840, 2400, true, 2.25), D(1, -2560, 0, 2560, 1440)];
// big monitor primary; laptop to the RIGHT and lower
const layoutRight = [D(0, 0, 0, 2560, 1440, true), D(1, 2560, 400, 3840, 2400, false, 2.25)];

beforeEach(() => resetWorkingPoint());

describe('pickDisplay', () => {
  it('no history → the primary', () => {
    expect(pickDisplay(layoutLeft)?.index).toBe(0);
    expect(pickDisplay(layoutRight)?.index).toBe(0);
  });
  it('follows where clawdcursor last worked — including a monitor at negative coordinates', () => {
    setWorkingPoint(-1200, 700);
    expect(pickDisplay(layoutLeft)?.index).toBe(1);
    setWorkingPoint(5000, 1500);
    expect(pickDisplay(layoutRight)?.index).toBe(1);
  });
  it('an explicit display wins; an unknown index is null', () => {
    setWorkingPoint(-1200, 700);
    expect(pickDisplay(layoutLeft, 0)?.index).toBe(0);
    expect(pickDisplay(layoutLeft, 7)).toBeNull();
  });
  it('a working point in a gap between monitors falls back to the primary', () => {
    setWorkingPoint(1000, 300); // above the lower-right laptop, right of nothing
    expect(displayAt(layoutRight, 3000, 100)).toBeNull();
    setWorkingPoint(3000, 100);
    expect(pickDisplay(layoutRight)?.index).toBe(0);
  });
});

describe('displayNote', () => {
  it('names the other monitors and how to see them; silent on one monitor', () => {
    const note = displayNote(layoutLeft, layoutLeft[0]);
    expect(note).toMatch(/Showing display #0 \(primary\) of 2; others: #1 2560x1440 at \(-2560,0\)/);
    expect(note).toMatch(/display:N/);
    expect(displayNote([layoutLeft[0]], layoutLeft[0])).toBe('');
  });
});
