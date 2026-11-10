import { untrusted } from '../core/miss-text';

/**
 * A find or invoke covers the FRONT window of an app (see scripts/ps-bridge.ps1 Get-ProcessScopeWindows; macOS key window,
 * Linux active window). A miss must say so: otherwise "no elements found" reads as "nothing in the app" when the element is
 * in another window of it.
 */
export async function narrowedScopeNote(
  platform: { listWindows(): Promise<Array<{ processId: number; title?: string }>> } | undefined,
  scopes: Array<{ processId?: number; title?: string }>,
): Promise<string> {
  const generic = ' — pass processId to target another app';
  const s = scopes.find(x => x.processId !== undefined);
  if (!s || !platform) return generic;
  try {
    const mine = (await platform.listWindows()).filter(w => w.processId === s.processId && (w.title ?? '').trim());
    const others = Math.max(0, mine.length - 1);
    if (others === 0) return generic;
    // The title is page text: inside an untrusted block, so classifyResult never reads it as clawdcursor's own words.
    return `; only the front window was searched; this app has ${others} other window${others === 1 ? '' : 's'}`
      + ' — window {"action":"focus","title":"…"} first to work in one'
      + (s.title ? `\n${untrusted(`front window: ${s.title}`)}` : '');
  } catch { return generic; }
}
