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
import { isBrowserProcess } from '../../llm/browser-config';
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
/** `processId` reads that app's window instead of the focused one. */
export async function captureSnapshot(adapter: PlatformAdapter, processId?: number): Promise<Snapshot> {
  const capturedAt = Date.now();
  const platform = normPlatform(adapter.platform);
  const sources: Array<'a11y' | 'ocr' | 'cdp'> = [];

  let elements: SnapshotElement[] = [];
  let offscreen: SnapshotElement[] = [];
  let activeWindow: Snapshot['activeWindow'] | undefined = undefined;

  try {
    let aw = await adapter.getActiveWindow();
    if (processId && aw?.processId !== processId) {
      const wins = await adapter.listWindows().catch(() => []);
      aw = wins
        .filter(w => w.processId === processId && !w.isMinimized && w.bounds.width > 0 && w.bounds.height > 0)
        .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] ?? null;
    }
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
    const { tree } = await getUiTreeWithWake(adapter, processId ?? activeWindow?.processId,
      { isBrowser: () => isBrowserProcess(activeWindow?.processName) });
    if (tree && tree.length > 0) {
      sources.push('a11y');
      const toSnap = (el: typeof tree[number]): SnapshotElement => {
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
          processId: processId ?? activeWindow?.processId,
        };
      };
      elements = tree.filter(el => el.bounds.width > 0 && el.bounds.height > 0).map(toSnap);
      // Named elements scrolled out of view come back with empty bounds. Keep
      // them aside (read-only) so compile_ui can still show their text —
      // except copies of something already on screen (live 2026-10-15:
      // Settings → About's "Windows 11 Pro" / "25H2" were dropped entirely).
      const shown = new Set(elements.map(e => e.name));
      offscreen = tree
        .filter(el => !(el.bounds.width > 0 && el.bounds.height > 0) && (el.name ?? '').trim() !== '' && !shown.has(el.name))
        .map(toSnap);
    }
  } catch { /* a11y unavailable — snapshot stays empty */ }

  const fp = fingerprint(elements, activeWindow?.title);

  return {
    platform,
    activeWindow,
    elements,
    fingerprint: fp,
    ...(offscreen.length ? { offscreen } : {}),
    capturedAt,
    sources,
  };
}
