/**
 * A coordinate click must land in the window it was meant for. A system dialog on top of the target (macOS "Accessibility
 * Access" over a app's window) matched the label "settings" and was clicked, though the caller named the other app.
 * The check asks the platform which window is at the point (`windowAtPoint`, read-only); a platform that cannot say
 * (null, no such method, an error) allows the click — it fails open.
 */
import type { PlatformAdapter } from '../platform/types';
import { quoteScreenText } from '../core/untrusted-screen-content';

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
  if (!at || !at.processId || at.processId === targetPid) return null;
  const target = targetName || `process ${targetPid}`;
  const what = [at.title ? quoteScreenText(at.title) : 'a window', `(${at.processName ? at.processName.replace(/[^\w .+-]/g, '').slice(0, 60) : 'unknown app'}, pid ${at.processId})`].join(' ');
  return `refused: the point ${quoteScreenText(label)} matched is in ${what}, which is on top of ${target} — nothing was clicked. `
    + `Bring ${target} to the front or close the dialog, then try again`;
}
