/**
 * Screenshot-bound pointer actions. Image-space coordinates only mean something on the screenshot they were read off;
 * once the screen behind them changed (a dialog opened, the page navigated, another app came to the front) the same
 * numbers point at something else. Each full screenshot gets an id and remembers the window in front; an image-space
 * click, drag or scroll is refused when it names an older screenshot, when there is no screenshot at all, or when a
 * different window is in front now.
 *
 * Pure state and logic — the caller supplies the window in front, through the platform adapter, so it is the same on
 * every OS. Accessibility coordinates (`space:"screen"`) and actions by name never come here.
 */

export interface ShotWindow { processId?: number; title?: string; handle?: number | string }
interface Shot { id: string; window: ShotWindow | null; at: number }

let seq = 0;
let last: Shot | null = null;

/** Record a full screenshot just taken, with the window in front at that moment. Returns its id. */
export function recordShot(window: ShotWindow | null): string {
  seq += 1;
  last = { id: `s${seq}`, window, at: Date.now() };
  return last.id;
}

export function latestShotId(): string | null {
  return last?.id ?? null;
}

/**
 * A title's own churn is not a different screen: an editor's unsaved marker ("*Untitled", "● file.ts") or an unread
 * count ("(3) Inbox"). A browser's title changing with the page is.
 */
function sameTitle(a = '', b = ''): boolean {
  const norm = (t: string) => t.replace(/^\s*[*•●]\s*/, '').replace(/^\(\d+\)\s*/, '').replace(/\s*[*•●]\s*$/, '').trim();
  return norm(a) === norm(b);
}

function sameWindow(a: ShotWindow, b: ShotWindow): boolean {
  if (a.processId !== b.processId) return false;
  if (a.handle !== undefined && b.handle !== undefined && a.handle !== b.handle) return false;
  return sameTitle(a.title, b.title);
}

/**
 * Null when the image-space action may go ahead; otherwise why not. `shot`: the id the caller says its coordinates came
 * from (optional). `now`: the window in front now (null when unknown — then only the id is checked).
 */
export function checkImagePointer(shot: unknown, now: ShotWindow | null): string | null {
  if (!last) {
    return 'image coordinates refer to a screenshot, and none has been taken. Take a screenshot first, '
      + 'or pass space:"screen" for coordinates from accessibility.';
  }
  if (typeof shot === 'string' && shot && shot !== last.id) {
    return `these coordinates are from screenshot ${shot}, an older screenshot; the latest is ${last.id}. `
      + 'Take a new screenshot, or use coordinates from the latest one.';
  }
  if (last.window && now && !sameWindow(last.window, now)) {
    // No titles in the message: they are screen content.
    return `the window in front changed since screenshot ${last.id}, so its coordinates may point at something else. `
      + 'Take a new screenshot, or act on the element by name.';
  }
  return null;
}

export function __resetShotsForTests(): void { seq = 0; last = null; }
