/**
 * Snapshot builder — assembles a structured Snapshot from the PlatformAdapter.
 *
 * Blind-first scope: accessibility tree only. When a11y can describe the
 * screen, the text-agent reads this and picks an action. When a11y can't
 * (empty tree, canvas app, custom rendering), the text-agent emits
 * `cannot_read` and the vision-agent takes over with real pixels.
 *
 * OCR fusion on top of a11y (merging OCR hits with a11y bounds into a single
 * element list) is a cost-saving enhancement we can layer in later without
 * changing the `Snapshot` contract.
 */

import type { PlatformAdapter } from '../../platform/types';
import { getUiTreeWithWake } from '../../platform/a11y-wake';
import type { Snapshot, SnapshotElement, Platform } from './types';
import { fingerprint } from './fingerprint';

function normPlatform(p: 'darwin' | 'win32' | 'linux'): Platform {
  return p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : 'linux';
}

const SECURE_CONTROL_TYPES = new Set([
  // Windows UIA (post "ControlType." strip) and macOS AX (post "AX" strip).
  'edit', 'passwordbox', 'securefield',
  'securetextfield', 'passwordfield',
]);

function looksSecure(controlType?: string, name?: string, subrole?: string): boolean {
  // AX subrole is the authoritative macOS signal (role is the generic
  // "TextField"; the secureness is in subrole=AXSecureTextField). Strip any AX
  // prefix before the set test so "SecureTextField" matches (audit 2026-06-11, M2).
  if (subrole && /securetextfield/i.test(subrole)) return true;
  if (!controlType && !name) return false;
  const tLower = (controlType ?? '').replace(/^ax/i, '').toLowerCase();
  const nLower = (name ?? '').toLowerCase();
  if (SECURE_CONTROL_TYPES.has(tLower)) return true;
  if (/\b(password|passcode|pin|secret|token|api\s*key|credit\s*card|cvv|ssn)\b/.test(nLower)) return true;
  return false;
}

/**
 * Capture a structured snapshot. a11y-only for v0.8.1; OCR merge is a
 * future enhancement.
 */
export async function captureSnapshot(adapter: PlatformAdapter): Promise<Snapshot> {
  const capturedAt = Date.now();
  const platform = normPlatform(adapter.platform);
  const sources: Array<'a11y' | 'ocr' | 'cdp'> = [];

  let elements: SnapshotElement[] = [];
  let activeWindow: Snapshot['activeWindow'] | undefined = undefined;

  try {
    const aw = await adapter.getActiveWindow();
    if (aw) {
      activeWindow = {
        processId: aw.processId,
        processName: aw.processName,
        title: aw.title,
        bounds: aw.bounds,
      };
    }
  } catch { /* active window optional */ }

  try {
    // A thin tree may be a sleeping Electron / Chromium app: wake it, read again.
    const { tree } = await getUiTreeWithWake(adapter, activeWindow?.processId);
    if (tree && tree.length > 0) {
      sources.push('a11y');
      elements = tree
        .filter(el => el.bounds.width > 0 && el.bounds.height > 0)
        .map(el => {
          // Trust the adapter's explicit secure flag first (macOS AX subrole),
          // then fall back to control-type/name/subrole heuristics.
          const secure = el.secure === true || looksSecure(el.controlType, el.name, el.subrole);
          return {
            name: el.name ?? '',
            role: el.controlType,
            x: el.bounds.x,
            y: el.bounds.y,
            width: el.bounds.width,
            height: el.bounds.height,
            source: 'a11y' as const,
            interactive: el.enabled !== false,
            value: secure ? undefined : el.value,
            secure,
            processId: activeWindow?.processId,
          };
        });
    }
  } catch { /* a11y unavailable — snapshot stays empty */ }

  const fp = fingerprint(elements, activeWindow?.title);

  return {
    platform,
    activeWindow,
    elements,
    fingerprint: fp,
    capturedAt,
    sources,
  };
}
