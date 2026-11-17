/**
 * A coordinate click must land in the window it was meant for. A system dialog on top of the target (macOS "Accessibility
 * Access" over a app's window) matched the label "settings" and was clicked, though the caller named the other app.
 * The check asks the platform which window is at the point (`windowAtPoint`, read-only); a platform that cannot say
 * (null, no such method, an error) allows the click — it fails open.
 */
import type { PlatformAdapter, WindowAtPoint } from '../platform/types';
import { quoteScreenText } from '../core/untrusted-screen-content';

/** `"Title" (process, pid N)` for a window found at a point: the title is screen text, so quoted. */
export function describeWindowAt(at: WindowAtPoint): string {
  const shown = at.hostedProcessName || at.processName;   // a Store app by its own name, not ApplicationFrameHost
  const name = shown ? shown.replace(/[^\w .+-]/g, '').slice(0, 60) : 'unknown app';
  return `${at.title ? quoteScreenText(at.title) : 'a window'} (${name}, pid ${at.processId})`;
}

/**
 * Does the window at a point belong to one of these processes? A Windows Store app's frame belongs to ApplicationFrameHost
 * and hosts the app's own process: window lists report the first as `processId` and the second as `hostedProcessId`, and a
 * caller may target either, so either matches (else every click in Calculator or Settings would read as another app's).
 */
export function ownsPoint(at: Pick<WindowAtPoint, 'processId' | 'hostedProcessId'> | null | undefined, ...pids: Array<number | undefined>): boolean {
  return !!at && pids.some(p => !!p && (p === at.processId || p === at.hostedProcessId));
}

/**
 * The refusal text when the window at (x, y) belongs to another process than `targetPid`, else null (go ahead).
 * `label` is what the point was matched by; `targetName` names the window the click was meant for.
 */
export async function foreignWindowRefusal(
  platform: Pick<PlatformAdapter, 'windowAtPoint'> | undefined,
  x: number, y: number,
  targetPid: number | undefined,
  label: string,
  targetName?: string,
): Promise<string | null> {
  if (!platform?.windowAtPoint || !targetPid) return null;
  const at = await platform.windowAtPoint(x, y).catch(() => null);
  if (!at || !at.processId || ownsPoint(at, targetPid)) return null;
  const target = targetName || `process ${targetPid}`;
  const what = describeWindowAt(at);
  return `refused: the point ${quoteScreenText(label)} matched is in ${what}, which is on top of ${target} — nothing was clicked. `
    + `Bring ${target} to the front or close the dialog, then try again`;
}
