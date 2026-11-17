/**
 * Two helps for a by-name search (find, invoke, smart_click) that matters most on a Mac:
 *  - an Electron / Chromium app builds its accessibility tree only after a client asks (AXManualAccessibility): read_tree
 *    wakes the app, a search by name did not, so it saw a thin tree and missed. The wake is sent once per process.
 *  - a miss because another app's window (a system dialog) covers the one being searched: the line says whose, and the
 *    processId to read it with.
 */
import type { PlatformAdapter } from '../platform/types';
import { wakeAccessibility } from '../platform/a11y-wake';
import { describeWindowAt } from './click-owner';

const woken = new Set<number>();

/** Test hook. */
export function resetNameSearchState(): void { woken.clear(); }

/** macOS: switch the app's accessibility on before its first by-name search (the pid is the caller's, else the focused window's). */
export async function wakeForNameSearch(
  platform: Pick<PlatformAdapter, 'getActiveWindow'> | undefined,
  pid?: number,
  os: NodeJS.Platform = process.platform,
): Promise<void> {
  if (os !== 'darwin') return;
  const target = pid ?? (await platform?.getActiveWindow().catch(() => null))?.processId;
  if (!target || woken.has(target)) return;
  woken.add(target);
  await wakeAccessibility(target, os);
}

/**
 * One line for a miss: another app's window is on top of the searched window's centre. Null when it is not, or cannot be
 * told. The title is screen text: quoted, and the line goes outside the untrusted block like the other result lines.
 */
export async function onTopOfLine(
  platform: Pick<PlatformAdapter, 'windowAtPoint' | 'listWindows' | 'getActiveWindow'> | undefined,
  pid?: number,
): Promise<string | null> {
  if (!platform?.windowAtPoint) return null;
  try {
    const target = pid === undefined
      ? await platform.getActiveWindow().catch(() => null)
      : (await platform.listWindows().catch(() => []))
        .filter(w => w.processId === pid && !w.isMinimized && w.bounds?.width > 0 && w.bounds?.height > 0)
        .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
    if (!target?.bounds || !target.processId) return null;
    const b = target.bounds;
    const at = await platform.windowAtPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
    if (!at || !at.processId || at.processId === target.processId) return null;
    return `→ ${describeWindowAt(at)} is on top of this window; pass processId:${at.processId} to read it`;
  } catch { return null; }
}
