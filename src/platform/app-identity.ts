/**
 * Which windows belong to an app — decided by IDENTITY, never by title text.
 *
 * The launch paths used to accept a window as "the app" on a substring of its process name or of its TITLE, and on
 * Windows on the last segment of the packaged-app id — "App" for nearly every Store app. So open_app "Calculator"
 * found a mail window whose title began "Application …", focused it and reported it as Calculator without launching
 * anything; open_app "Mail" would have taken a browser tab titled "Gmail". A title is whatever a document, a web page
 * or a mail subject says, so it proves nothing about the owner.
 *
 * A window is the app's only when:
 *   1. its process name EQUALS the launch name (extension dropped) or one of the app's known process names
 *      (the alias row: Calculator → CalculatorApp, Outlook → olk / OUTLOOK, Edge → msedge);
 *   2. Windows, packaged app: its process runs from the app's package — the exe path has a folder of the package
 *      family (`…\WindowsApps\Microsoft.WindowsCalculator_<version>_<arch>__8wekyb3d8bbwe\…`);
 *   3. Windows, a window owned by ApplicationFrameHost (the frame of a UWP app, whose own process the window list
 *      does not show): its title EQUALS the app's display name, or ends with " - <display name>".
 */
import type { WindowInfo } from './types';
import { normalizeWindowText } from '../tools/window-text';

export interface AppIdentityHints {
  /** The app's known process names (the alias row's `processNames`). */
  processNames?: readonly string[];
  /** The app's display name ("Calculator"), for rule 3. */
  displayName?: string;
  /** Windows packaged-app id `<PackageFamily>!<AppId>`, for rule 2. */
  uwpAppId?: string;
  /** `name` is only the launcher (explorer.exe opening a file): its own windows are not the result. */
  viaLauncher?: boolean;
}

export interface AppIdentity {
  /** Lower-case, extension dropped. */
  processNames: ReadonlySet<string>;
  /** Window-normalized (lower-case). */
  displayNames: readonly string[];
  /** Lower-case `<Name>_<PublisherId>`. */
  packageFamily?: string;
}

/** The frame process of every UWP app: it owns their windows, so its name identifies none of them. */
const FRAME_HOST = 'applicationframehost';

/** A launch or process name → the bare lower-case process name: path and .exe / .com / .app dropped. */
function bareName(s: string | undefined | null): string {
  const leaf = String(s ?? '').trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
  return leaf.toLowerCase().replace(/\.(exe|com|app)$/, '');
}

export function appIdentity(name: string, hints: AppIdentityHints = {}): AppIdentity {
  const processNames = new Set<string>();
  const displayNames = new Set<string>();
  const own = hints.viaLauncher ? '' : bareName(name);
  for (const n of [own, ...(hints.processNames ?? []).map(bareName)]) {
    if (n && n !== FRAME_HOST) processNames.add(n);
  }
  for (const d of [own, normalizeWindowText(hints.displayName)]) if (d) displayNames.add(d);
  const family = hints.uwpAppId?.split('!')[0].trim().toLowerCase();
  return { processNames, displayNames: [...displayNames], ...(family ? { packageFamily: family } : {}) };
}

/** Is `exePath` inside a package of `family` (`<Name>_<PublisherId>`)? The folder is the family, or the full name `<Name>_<version>_<arch>_<resource>_<PublisherId>`. */
export function pathInPackageFamily(exePath: string, family: string): boolean {
  const fam = family.toLowerCase();
  const cut = fam.lastIndexOf('_');
  if (cut <= 0) return false;
  const head = `${fam.slice(0, cut)}_`;
  const tail = `_${fam.slice(cut + 1)}`;
  return exePath.toLowerCase().split(/[\\/]/).some(seg =>
    seg === fam || (seg.length > head.length + tail.length && seg.startsWith(head) && seg.endsWith(tail)));
}

/** Does window `w` belong to the app? `processPath` is its process's exe path when the caller knows it (rule 2). */
export function ownsWindow(id: AppIdentity, w: WindowInfo, processPath?: string): boolean {
  const proc = bareName(w.processName);
  if (proc && id.processNames.has(proc)) return true;
  if (processPath && id.packageFamily && pathInPackageFamily(processPath, id.packageFamily)) return true;
  if (proc === FRAME_HOST) {
    const title = normalizeWindowText(w.title);
    return id.displayNames.some(d => title === d || title.endsWith(` - ${d}`));
  }
  return false;
}
