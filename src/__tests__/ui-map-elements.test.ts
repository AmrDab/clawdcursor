import { describe, it, expect } from 'vitest';
import { a11yToUI, ocrToUI } from '../core/sense/ui-map-elements';
import type { SnapshotElement } from '../core/sense/types';
import type { OcrElement } from '../platform/ocr-engine';

describe('a11yToUI', () => {
  it('maps an a11y Button to a clickable element with base confidence', () => {
    const se: SnapshotElement = { name: 'Send', role: 'Button', x: 10, y: 20,
      width: 30, height: 12, source: 'a11y', interactive: true };
    const el = a11yToUI(se, 'el_5');
    expect(el).toMatchObject({
      id: 'el_5', role: 'button', text: 'Send', normalized_text: 'send',
      bounds: [10, 20, 30, 12], sources: ['a11y'], clickable: true, actionable: true,
    });
    expect(el.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('carries enabled/value into state', () => {
    const se: SnapshotElement = { name: 'To', role: 'Edit', x: 0, y: 0, width: 5,
      height: 5, source: 'a11y', interactive: true, value: 'a@b.com' };
    const el = a11yToUI(se, 'el_6');
    expect(el.editable).toBe(true);
    expect(el.state?.value).toBe('a@b.com');
  });
});

describe('ocrToUI', () => {
  it('maps an OCR token to a text element with confidence scaled below a11y', () => {
    const oe: OcrElement = { text: 'Send', x: 1, y: 2, width: 20, height: 8,
      confidence: 0.9, line: 3 };
    const el = ocrToUI(oe, 'el_7');
    expect(el).toMatchObject({ id: 'el_7', role: 'text', text: 'Send',
      normalized_text: 'send', sources: ['ocr'], clickable: false, actionable: false });
    expect(el.confidence).toBeLessThan(0.8);  // OCR-only is weaker than a11y
  });
  it('a 1-char OCR fragment lands below the actionable confidence floor', () => {
    const oe: OcrElement = { text: 'O', x: 1, y: 2, width: 4, height: 8,
      confidence: 0.9, line: 1 };
    const el = ocrToUI(oe, 'el_8');
    expect(el.confidence).toBeLessThan(0.4);   // the stray-"O" regression, structural
    expect(el.actionable).toBe(false);
  });
  it('no engine score (Windows) is neutral: the same as a sure read, never 0 (#275)', () => {
    const base = { text: 'Send', x: 1, y: 2, width: 20, height: 8, line: 3 };
    expect(ocrToUI(base, 'el_9').confidence).toBe(ocrToUI({ ...base, confidence: 1 }, 'el_10').confidence);
  });
});
