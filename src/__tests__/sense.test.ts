/**
 * Sense-layer tests: fingerprint stagnation + snapshot capture.
 */

import { describe, it, expect } from 'vitest';
import { fingerprint, FingerprintHistory } from '../core/sense/fingerprint';
import { captureSnapshot } from '../core/sense/snapshot';
import type { SnapshotElement } from '../core/sense/types';
import type { PlatformAdapter } from '../platform/types';

describe('fingerprint', () => {
  const e = (name: string, x: number, y: number, role = 'button'): SnapshotElement => ({
    name,
    role,
    x,
    y,
    width: 80,
    height: 24,
    source: 'a11y',
  });

  it('is deterministic for the same input', () => {
    const els = [e('Send', 100, 200), e('Cancel', 200, 200)];
    expect(fingerprint(els)).toBe(fingerprint(els));
  });

  it('is order-insensitive', () => {
    const a = [e('Send', 100, 200), e('Cancel', 200, 200)];
    const b = [e('Cancel', 200, 200), e('Send', 100, 200)];
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('quantizes small coord jitter within a bucket', () => {
    // With quant=8 using Math.round(n/8)*8:
    //   100 → round(12.5)*8 = 13*8 = 104 (JS rounds half-up for positive)
    //   101..107 all → round(12.6..13.4)*8 = 13*8 = 104
    //   108 → round(13.5)*8 = 14*8 = 112 (different bucket)
    // So any jitter 100..107 on x and 200..207 on y produces the same fp.
    const a = [e('Send', 100, 200)];
    const b = [e('Send', 103, 202)];   // same 104/200 bucket
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('notices jitter that crosses a bucket boundary', () => {
    const a = [e('Send', 100, 200)];   // bucket 104/200
    const b = [e('Send', 108, 200)];   // bucket 112/200 — DIFFERENT
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('includes active window title so same UI in different app differs', () => {
    const els = [e('Send', 100, 200)];
    expect(fingerprint(els, 'Outlook')).not.toBe(fingerprint(els, 'Mail'));
  });

  it('different elements produce different fingerprints', () => {
    expect(fingerprint([e('Send', 100, 200)])).not.toBe(fingerprint([e('Done', 100, 200)]));
  });

  it('a changed field VALUE moves the fingerprint (typing is an observable change)', () => {
    // Value-blind fingerprints made every successful type/fill look like
    // "no observable change" (audit 2026-06-10, finding D2).
    const empty = [{ ...e('To', 100, 200, 'edit'), value: '' }];
    const typed = [{ ...e('To', 100, 200, 'edit'), value: 'amr@x.com' }];
    expect(fingerprint(empty as SnapshotElement[])).not.toBe(fingerprint(typed as SnapshotElement[]));
  });

  it('secure fields (value undefined) do not leak into the fingerprint', () => {
    const a = [{ ...e('Password', 100, 200, 'edit'), value: undefined }];
    const b = [{ ...e('Password', 100, 200, 'edit'), value: undefined }];
    expect(fingerprint(a as SnapshotElement[])).toBe(fingerprint(b as SnapshotElement[]));
  });
});

describe('captureSnapshot — macOS secure-field redaction (M2)', () => {
  // A macOS password field: role AXTextField (generic), secureness in the
  // subrole. The adapter sets secure=true + drops the value. The snapshot must
  // never surface the cleartext, even though the role is a plain text field and
  // the element name doesn't contain "password".
  const adapter = (el: Record<string, unknown>): PlatformAdapter => ({
    getActiveWindow: async () => ({ processId: 1, processName: 'Safari', title: 'Login', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    getUiTree: async () => [el],
  } as unknown as PlatformAdapter);

  it('redacts a value when the adapter flags secure=true (subrole AXSecureTextField)', async () => {
    const snap = await captureSnapshot(adapter({
      name: 'login field', controlType: 'TextField', subrole: 'AXSecureTextField', secure: true,
      value: undefined, enabled: true, bounds: { x: 10, y: 10, width: 100, height: 20 },
    }));
    const el = snap.elements[0];
    expect(el.secure).toBe(true);
    expect(el.value).toBeUndefined();
  });

  it('detects secureness from subrole even if the adapter forgot the secure flag', async () => {
    const snap = await captureSnapshot(adapter({
      name: '', controlType: 'TextField', subrole: 'AXSecureTextField',
      value: 'hunter2', enabled: true, bounds: { x: 10, y: 10, width: 100, height: 20 },
    }));
    const el = snap.elements[0];
    expect(el.secure).toBe(true);
    expect(el.value).toBeUndefined();
  });
});

describe('FingerprintHistory', () => {
  it('is not stagnant with <2 entries', () => {
    const h = new FingerprintHistory();
    expect(h.isStagnant()).toBe(false);
    h.push('a');
    expect(h.isStagnant()).toBe(false);
  });

  it('detects 2-in-a-row stagnation', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    expect(h.isStagnant(2)).toBe(true);
  });

  it('does not flag stagnation when values change', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('b');
    expect(h.isStagnant(2)).toBe(false);
  });

  it('respects custom n', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    h.push('a');
    expect(h.isStagnant(3)).toBe(true);
    expect(h.isStagnant(4)).toBe(false);
  });

  it('reset clears history', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    h.reset();
    expect(h.getHistory()).toEqual([]);
    expect(h.isStagnant()).toBe(false);
  });

  it('caps history to maxSize', () => {
    const h = new FingerprintHistory(3);
    h.push('a');
    h.push('b');
    h.push('c');
    h.push('d');
    expect(h.getHistory()).toEqual(['b', 'c', 'd']);
  });
});
