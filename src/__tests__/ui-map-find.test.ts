import { describe, it, expect } from 'vitest';
import { findActionButton, findInputField, associateLabel, MAX_CANDIDATES } from '../core/sense/ui-map-find';
import type { UIElement } from '../core/sense/ui-map-types';

const btn = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'normalized_text'>): UIElement => ({
  role: 'button', text: over.normalized_text, bounds: [0, 0, 40, 12], confidence: 0.9,
  sources: ['a11y'], clickable: true, actionable: true, ...over });

describe('findActionButton', () => {
  it('matches an intent to a synonym-labeled button (submit -> "Send")', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send' }), btn({ id: 'el_1', normalized_text: 'cancel' })], 'obs_1', 'submit');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.best.element_id).toBe('el_0'); expect(r.snapshot_id).toBe('obs_1'); }
  });

  it('ignores non-clickable elements', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send', clickable: false, actionable: false })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
  });

  it('exact literal match outranks a synonym on comparable confidence', () => {
    // exact 'post' = 1.0*0.9 = 0.90 ; synonym 'publish' = 0.9*0.85 = 0.765 ; gap 0.135 >= margin -> exact wins
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'post', confidence: 0.9 }), btn({ id: 'el_1', normalized_text: 'publish', confidence: 0.85 })], 'obs_1', 'post');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_0');
  });

  it('returns ambiguous when top two are within the margin', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'ok', confidence: 0.9 }), btn({ id: 'el_1', normalized_text: 'confirm', confidence: 0.9 })], 'obs_1', 'submit');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') { expect(r.candidates.length).toBe(2); expect(r.reason).toMatch(/margin/i); }
  });

  it('returns none with candidates when nothing clears the threshold', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'weather widget' })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
    if (r.status === 'none') expect(Array.isArray(r.candidates)).toBe(true);
  });

  it('caps candidates at MAX_CANDIDATES', () => {
    const els = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => btn({ id: `el_${i}`, normalized_text: 'send' }));
    const r = findActionButton(els, 'obs_1', 'send');
    expect(r.candidates.length).toBe(MAX_CANDIDATES);
  });
});

const field = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'bounds'>): UIElement => ({
  role: 'input', normalized_text: '', text: '', confidence: 0.85, sources: ['a11y'],
  editable: true, actionable: true, clickable: false, ...over });
const text = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'normalized_text' | 'bounds'>): UIElement => ({
  role: 'text', text: over.normalized_text, confidence: 0.8, sources: ['a11y'], ...over });

describe('findInputField', () => {
  it('matches a field by its OWN name when present', () => {
    const els = [field({ id: 'el_0', normalized_text: 'subject', text: 'Subject', bounds: [200, 50, 400, 24] })];
    const r = findInputField(els, 'obs_1', 'subject');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_0');
  });

  it('ignores non-editable elements', () => {
    const els = [text({ id: 'el_0', normalized_text: 'to', bounds: [10, 50, 30, 20] })];
    expect(findInputField(els, 'obs_1', 'recipient').status).toBe('none');
  });

  it('associates a LEFT label to a label-less field (To -> recipient)', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'to', bounds: [10, 50, 30, 20] }),     // label left
      field({ id: 'el_fld', bounds: [60, 48, 500, 24] }),                          // unnamed field to its right
    ];
    const r = findInputField(els, 'obs_1', 'recipient'); // recipient synonyms include 'to'
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.best.element_id).toBe('el_fld'); expect(r.best.label).toBe('to'); }
  });

  it('associates an ABOVE label when no left label exists', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'subject', bounds: [60, 20, 80, 18] }), // label above
      field({ id: 'el_fld', bounds: [60, 46, 500, 24] }),
    ];
    const r = findInputField(els, 'obs_1', 'subject');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_fld');
  });

  it('uses an OCR-sourced label (WebView field)', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'to', bounds: [10, 50, 30, 20], sources: ['ocr'] }),
      field({ id: 'el_fld', bounds: [60, 48, 500, 24], sources: ['a11y'] }),
    ];
    const r = findInputField(els, 'obs_1', 'recipient');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_fld');
  });
});

describe('associateLabel', () => {
  it('prefers a left label over an above label', () => {
    const fld = field({ id: 'f', bounds: [100, 100, 200, 24] });
    const all = [fld,
      text({ id: 'left', normalized_text: 'leftlabel', bounds: [40, 102, 50, 20] }),
      text({ id: 'above', normalized_text: 'abovelabel', bounds: [100, 70, 80, 18] })];
    expect(associateLabel(fld, all)).toBe('leftlabel');
  });
  it('returns empty when no label is within range', () => {
    const fld = field({ id: 'f', bounds: [100, 100, 200, 24] });
    const far = text({ id: 't', normalized_text: 'faraway', bounds: [2000, 2000, 50, 20] });
    expect(associateLabel(fld, [fld, far])).toBe('');
  });
});

describe('multi-word purpose (live Save-As regression, Windows VM 2026-10-15)', () => {
  const field = (id: string, label: string): UIElement => ({
    id, role: 'textbox', text: label, normalized_text: label, bounds: [0, 0, 200, 20], confidence: 0.85,
    sources: ['a11y'], clickable: true, editable: true, actionable: true,
  });

  it('"file name" picks the "File name:" box over the file list\'s "Name" column boxes', () => {
    const els = [field('el_43', 'name'), field('el_48', 'name'), field('el_53', 'name'), field('el_58', 'file name:')];
    const r = findInputField(els, 'obs_9', 'file name');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_58');
  });

  it('a single-word purpose still scores an exact label as before', () => {
    const r = findInputField([field('el_1', 'name'), field('el_2', 'file name:')], 'obs_9', 'name');
    expect(r.status === 'ok' || r.status === 'ambiguous').toBe(true);
    expect(r.candidates[0].element_id).toBe('el_1');
  });
});

describe('one field, two elements (live Save-As check, Windows VM 2026-10-15)', () => {
  it('a combo box and the edit nested in it, same label, are one candidate — not "ambiguous"', () => {
    const el = (id: string, label: string, bounds: [number, number, number, number]): UIElement => ({
      id, role: 'textbox', text: label, normalized_text: label, bounds, confidence: 0.85,
      sources: ['a11y'], clickable: true, editable: true, actionable: true,
    });
    const els = [
      el('el_43', 'name', [10, 100, 120, 20]),
      el('el_58', 'file name:', [100, 400, 500, 24]),   // the combo box
      el('el_59', 'file name:', [102, 402, 470, 20]),   // the edit inside it
    ];
    const r = findInputField(els, 'obs_2', 'file name');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(['el_58', 'el_59']).toContain(r.best.element_id);
  });
});
