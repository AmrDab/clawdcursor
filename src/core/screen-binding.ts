/**
 * Screenshot-bound pointer actions. Image-space coordinates only mean something on the screenshot they were read off.
 * Each full screenshot gets an id and remembers which windows existed when it was taken. An image-space click, drag or
 * scroll is refused when it names an older screenshot, when there is no screenshot at all, or when the window in front
 * now is one the screenshot did not have — a dialog, a popup or an app that opened since — because its coordinates
 * would land on something the caller never saw.
 *
 * Bringing a window that WAS on the screenshot to the front (clicking into it) is normal and allowed: a screenshot of
 * the desktop usually has the agent's own host in front. Limits: a page that changed inside the same window, or a sheet
 * attached to it, is the same window here; where the platform gives no window handles (macOS today), windows are told
 * apart by process only, so a new dialog of an app that was on the screenshot is not caught there.
 *
 * Pure state and logic — the caller supplies the windows through the platform adapter, the same on every OS.
 * Accessibility coordinates (`space:"screen"`) and actions by name never come here.
 */

export interface ShotWindow { processId?: number; title?: string; handle?: number | string }
interface Shot { id: string; windows: ShotWindow[]; at: number }

/** Whether the latest screenshot could record its windows (the list can fail, or be empty: Wayland). */
export function latestShotGuardsWindows(): boolean {
  return !!last && last.windows.length > 0;
}

let seq = 0;
let last: Shot | null = null;

const hasHandle = (w: ShotWindow) => w.handle !== undefined && w.handle !== null && w.handle !== '';

/**
 * Was this window on the screenshot? By handle when both sides have one; otherwise by process — an adapter may give a
 * handle in its window list but not for the active window. Titles are never compared: they churn on their own.
 */
function wasOnShot(front: ShotWindow, windows: ShotWindow[]): boolean {
  return windows.some(w => (hasHandle(front) && hasHandle(w)) ? String(w.handle) === String(front.handle) : w.processId === front.processId);
}

/** Record a full screenshot just taken, with the windows that existed at that moment. Returns its id. */
export function recordShot(windows: ShotWindow[]): string {
  seq += 1;
  last = { id: `s${seq}`, windows: windows.map(w => ({ processId: w.processId, handle: w.handle })), at: Date.now() };
  return last.id;
}

export function latestShotId(): string | null {
  return last?.id ?? null;
}

/**
 * Null when the image-space action may go ahead; otherwise why not. `shot`: the id the caller says its coordinates came
 * from (optional). `front`: the window in front now (null when unknown — then only the id is checked).
 */
export function checkImagePointer(shot: unknown, front: ShotWindow | null): string | null {
  if (!last) {
    return 'image coordinates refer to a screenshot, and none has been taken. Take a screenshot first, '
      + 'or pass space:"screen" for coordinates from accessibility.';
  }
  if (typeof shot === 'string' && shot && shot !== last.id) {
    return `these coordinates are from screenshot ${shot}, an older screenshot; the latest is ${last.id}. `
      + 'Take a new screenshot, or use coordinates from the latest one.';
  }
  // No windows recorded (the list failed): nothing to compare against.
  if (front && last.windows.length > 0 && !wasOnShot(front, last.windows)) {
    // No titles in the message: they are screen content.
    return `a window that was not on screenshot ${last.id} is in front now (a dialog or another app opened), so these `
      + 'coordinates may land on something the screenshot did not show. Take a new screenshot, or act on the element by name.';
  }
  return null;
}

export function __resetShotsForTests(): void { seq = 0; last = null; }
