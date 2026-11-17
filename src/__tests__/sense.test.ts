/**
 * Sense-layer tests: snapshot capture.
 */

import { describe, it, expect } from 'vitest';
import { captureSnapshot } from '../core/sense/snapshot';
import type { PlatformAdapter } from '../platform/types';

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
