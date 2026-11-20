/**
 * Which window a close / minimize / focus names. Every field the caller gives must match (AND), so
 * `{processName:"chrome", title:"Restore pages?"}` is the dialog, never "the first chrome window". One match is the
 * window to act on; none or several is said, with the candidates, instead of a guess.
 */
import type { WindowInfo } from './types';
import { processNamesOf } from './frame-host';
import { windowTextIncludes } from './window-text';

export interface WindowSelector { processName?: string; processId?: number; title?: string }

const given = (q: WindowSelector) => ({
  name: q.processName ? q.processName.toLowerCase() : undefined,
  pid: q.processId,
  title: q.title ? q.title : undefined,
});

/** The windows that match EVERY given field. A process name is its exact name first, then a part of it. */
export function matchWindows(windows: WindowInfo[], q: WindowSelector): WindowInfo[] {
  const g = given(q);
  if (g.name === undefined && g.pid === undefined && g.title === undefined) return [];
  const rest = (w: WindowInfo) => (g.pid === undefined || w.processId === g.pid) && (g.title === undefined || windowTextIncludes(w.title, g.title));
  const exact = windows.filter(w => rest(w) && (g.name === undefined || processNamesOf(w).includes(g.name)));
  if (exact.length || g.name === undefined) return exact;
  return windows.filter(w => rest(w) && processNamesOf(w).some(n => n.includes(g.name!)));
}

/** `"Untitled - Notepad" [notepad] pid:123`, the way a reply names the window it acted on. */
export function describeWindow(w: Pick<WindowInfo, 'title' | 'processName' | 'processId'>): string {
  return `"${w.title}" [${w.processName}] pid:${w.processId}`;
}

/** Why a selector did not pick one window: none matched, or the list of those that did. Null when exactly one matched. */
export function selectionProblem(q: WindowSelector, matches: WindowInfo[]): string | null {
  if (matches.length === 1) return null;
  const g = given(q);
  const by = [g.name !== undefined && `processName "${q.processName}"`, g.pid !== undefined && `processId ${g.pid}`, g.title !== undefined && `title "${q.title}"`]
    .filter(Boolean).join(' and ');
  if (matches.length === 0) return `No open window matches ${by}.`;
  return `${matches.length} windows match ${by}, so nothing was done: ${matches.map(describeWindow).join('; ')}. Narrow it with a longer title or a processId.`;
}
