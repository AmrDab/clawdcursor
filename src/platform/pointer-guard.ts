/**
 * Runs before every synthetic mouse press, drag or scroll.
 *
 * clawdcursor's own "desktop control in progress" pill (top centre) is a real window that takes mouse events, so an agent's
 * click under it landed on the pill instead of the app — exactly where browsers keep their tab strip and address bar
 * (live macOS run 2026-10-19: a target under the pill got 0 clicks). The banner registers a hook that hides the pill for
 * the moment of the press; the platform layer only calls it, so it does not depend on the overlay.
 */
let hook: (() => Promise<void>) | null = null;

export function setBeforePointerPress(h: (() => Promise<void>) | null): void {
  hook = h;
}

/** Never throws: a failed dodge must not stop the click. */
export async function beforePointerPress(): Promise<void> {
  if (!hook) return;
  try { await hook(); } catch { /* cosmetic */ }
}

/**
 * Runs before every screen capture (screenshot, OCR). The pill and glow are for the person at the screen, never part of
 * what the agent sees: where the OS can exclude a window from capture (Windows, macOS) the overlay does so itself, and
 * the banner registers no hook; elsewhere (Linux) the hook hides the pill for the moment of the capture.
 */
let captureHook: (() => Promise<void>) | null = null;

export function setBeforeCapture(h: (() => Promise<void>) | null): void {
  captureHook = h;
}

/** Never throws: a failed hide must not stop the capture. */
export async function beforeCapture(): Promise<void> {
  if (!captureHook) return;
  try { await captureHook(); } catch { /* cosmetic */ }
}

/**
 * clawdcursor's own overlay processes (the pill, the glow) are the user's: never a window or app that a lookup by name, title
 * or pid resolves to. Window lookups match process names by substring, and on Windows and Linux the overlay runs under a
 * shared interpreter (powershell, python3), so `focus {processName:"powershell"}` could land on the pill. The banner
 * registers its live pids; the platform layer filters them out of its window and app lists.
 */
let ownUiPids: () => readonly number[] = () => [];

export function setOwnUiPids(f: () => readonly number[]): void {
  ownUiPids = f;
}

export function isOwnUiPid(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { return ownUiPids().includes(pid); } catch { return false; }
}
