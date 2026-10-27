import type { SnapshotElement } from './types';
import type { OcrElement } from '../../platform/ocr-engine';
import type { UIElement } from './ui-map-types';
import { normalizeRole, normText, inferCapabilities } from './ui-map-normalize';

// Confidence bases (see spec §3). a11y is structured/trustworthy; OCR is scaled
// by the recognizer's own score AND damped so a lone OCR hit never outranks a
// corroborated a11y element. 1-char OCR fragments are damped hard (stray-"O").
const A11Y_BASE = 0.85;
const OCR_SCALE = 0.6;

export function a11yToUI(se: SnapshotElement, id: string): UIElement {
  const role = normalizeRole(se.role);
  const caps = inferCapabilities({ role, source: 'a11y', enabled: se.interactive });
  return {
    id, role, text: se.name, normalized_text: normText(se.name),
    bounds: [se.x, se.y, se.width, se.height],
    confidence: A11Y_BASE, sources: ['a11y'], ...caps,
    state: { enabled: se.interactive !== false, value: se.secure ? undefined : se.value },
  };
}

export function ocrToUI(oe: OcrElement, id: string): UIElement {
  const role = 'text' as const;
  const caps = inferCapabilities({ role, source: 'ocr', enabled: true });
  // Single-char fragments are OCR noise — damp hard so they never win a match.
  const lenDamp = oe.text.trim().length <= 1 ? 0.4 : 1;
  // No engine score (Windows) is neutral, not doubt.
  const confidence = (oe.confidence ?? 1) * OCR_SCALE * lenDamp;
  return {
    id, role, text: oe.text, normalized_text: normText(oe.text),
    bounds: [oe.x, oe.y, oe.width, oe.height],
    confidence, sources: ['ocr'], ...caps,
  };
}
