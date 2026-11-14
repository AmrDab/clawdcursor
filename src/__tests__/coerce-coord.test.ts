/**
 * Tests for coerceCoord — the LLM-coordinate normaliser.
 *
 * Real failure mode this guards against (from a Kimi run + a Sonnet run):
 *   click(x="390, 79", y=79)   → Number("390, 79") = NaN
 *   tool dispatch: `Clicked left x1 at (NaN, 79)`
 *   downstream: stagnation (click went nowhere, OS rejected NaN coords)
 *
 * The helper splits the smushed form, emits a warning back to the LLM
 * so it learns the schema for next time, and returns clean numbers.
 */

import { describe, expect, it } from 'vitest';
import { coerceCoord } from '../tools/projected/tools';

describe('coerceCoord', () => {
  it('passes through clean number args unchanged', () => {
    const r = coerceCoord(390, 79);
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
    expect(r.warning).toBeUndefined();
  });

  it('parses numeric strings (LLM occasionally quotes a plain number)', () => {
    const r = coerceCoord('390', '79');
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
  });

  it('splits smushed "x, y" comma form and warns the LLM', () => {
    const r = coerceCoord('390, 79', 79);
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
    expect(r.warning).toMatch(/x came in as/);
    expect(r.warning).toMatch(/SEPARATE numeric/);
  });

  it('splits smushed "x y" space form', () => {
    const r = coerceCoord('390 79', undefined);
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
  });

  it('splits parenthesised "(x,y)" form', () => {
    const r = coerceCoord('(390,79)', undefined);
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
  });

  it('splits bracketed "[x, y]" form', () => {
    const r = coerceCoord('[390, 79]', undefined);
    expect(r.x).toBe(390);
    expect(r.y).toBe(79);
  });

  it('returns NaN for fully unparseable input so the tool can reject loudly', () => {
    const r = coerceCoord('center of the button', 'roughly here');
    expect(Number.isFinite(r.x)).toBe(false);
    expect(Number.isFinite(r.y)).toBe(false);
  });

  it('survives floating point coords (rare but Figma/web do it)', () => {
    const r = coerceCoord(390.5, 79.25);
    expect(r.x).toBe(390.5);
    expect(r.y).toBe(79.25);
  });

  it('handles negative coords (multi-monitor secondary-display case)', () => {
    const r = coerceCoord(-150, 200);
    expect(r.x).toBe(-150);
    expect(r.y).toBe(200);
  });
});
