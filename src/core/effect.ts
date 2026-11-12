/**
 * What an act changed, said from reads taken around it (#357, #379): the window in front, by IDENTITY — its handle, else
 * its process — never by its title. A title is the document's or the page's to change (a tab switch, a saved file, a
 * page that loads), so a changed title says nothing about which window has the keyboard.
 */
import { quoteScreenText } from './result-codes';

export type WindowRead = { processId?: number; hostedProcessId?: number; handle?: number | string; title?: string; processName?: string;
  appName?: string; guessed?: boolean } | null | undefined;

/**
 * 'same-window': the same window (same handle). 'other-window': another window of the same app — a dialog it opened, or
 * one that closed back to its owner. 'same-app': the same app, and the reads carry no handle to tell its windows apart.
 * 'other-app': another app is in front. undefined: it cannot be told (a read failed, or the OS only guessed).
 */
export type WindowChange = 'same-window' | 'other-window' | 'same-app' | 'other-app';

/** The window's own handle. A handle that is only the process id (macOS has none; an older Windows bridge) names no window. */
const handleOf = (w: NonNullable<WindowRead>) => (w.handle === w.processId ? undefined : w.handle);

export function windowChange(before: WindowRead, after: WindowRead): WindowChange | undefined {
  if (!before || !after || before.guessed || after.guessed) return undefined;
  const hb = handleOf(before), ha = handleOf(after);
  // The same window of the same process is the same window, even when one read missed the app a Store frame hosts
  // (still starting) — unless both name their hosted app and the apps differ (a frame came to host another app).
  const hostsDiffer = before.hostedProcessId !== undefined && after.hostedProcessId !== undefined
    && before.hostedProcessId !== after.hostedProcessId;
  if (hb !== undefined && hb === ha && before.processId === after.processId && !hostsDiffer) return 'same-window';
  // A Store app's window belongs to the one frame process: the app is the process the frame hosts.
  const a = before.hostedProcessId ?? before.processId, b = after.hostedProcessId ?? after.processId;
  if (!a || !b) return undefined;
  if (a !== b) return 'other-app';
  return hb === undefined || ha === undefined ? 'same-app' : 'other-window';
}

const short = (s: string) => quoteScreenText(s.length > 40 ? `${s.slice(0, 39)}…` : s);

/**
 * One line saying what the window in front did across an act, or '' when it cannot be told:
 *   `effect: window same` · `effect: window same, title now "…"` · `effect: another window of the same app is in front: "…"`
 *   · `effect: another app is in front: "Notepad" "Untitled"`.
 */
export function effectLine(before: WindowRead, after: WindowRead): string {
  const c = windowChange(before, after);
  if (!c || !after) return '';
  const title = after.title ? short(after.title) : '';
  const retitled = !!after.title && after.title !== before?.title;
  switch (c) {
    case 'same-window': return `effect: window same${retitled ? `, title now ${title}` : ''}`;
    case 'same-app': return `effect: same app in front${retitled ? `, title now ${title}` : ''}`;
    case 'other-window': return `effect: another window of the same app is in front${title ? `: ${title}` : ''}`;
    case 'other-app': return `effect: another app is in front: ${short(after.appName || after.processName || `pid ${after.processId}`)}${title ? ` ${title}` : ''}`;
  }
}
