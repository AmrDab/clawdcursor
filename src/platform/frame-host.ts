/**
 * Which app is a window? For a Store (UWP) app on Windows the answer is not the window's own process.
 *
 * Every Store app's top-level window belongs to ApplicationFrameHost.exe, ONE process for all of them; the app itself
 * owns the `Windows.UI.Core.CoreWindow` child inside the frame. Naming such a window by its process says "Application
 * Frame Host" for Calculator, for Settings and for Photos alike: the pill showed "Clicking in Application Frame Host",
 * the session log recorded that as the app, and anything that decides by process (the test fence, the benchmark's
 * watchdog) could not tell one Store app from another.
 *
 * This is the one place that resolves it. The window list, the foreground read, the fence and the app name shown on
 * the pill and written to the session log all go through `withHostedApp` / `hostedAppOf`.
 */

export interface HostedApp {
  processId: number;
  processName: string;
  /** The app's own display name (its exe's file description: "Calculator"), when it has one. */
  appName?: string;
}

/** What is needed of a window to say which app it is. */
export interface FrameWindow {
  processName?: string;
  handle?: number | string;
  hostedProcessId?: number;
  hostedProcessName?: string;
  hostedAppName?: string;
}

export const isFrameHost = (processName: string | undefined): boolean => /^applicationframehost(\.exe)?$/i.test(String(processName ?? '').trim());

/** Window handle → the app that frame hosts, for every Store app frame on the desktop (the bridge's Win32 window read). */
async function readFrames(): Promise<Map<string, HostedApp>> {
  const frames = new Map<string, HostedApp>();
  if (process.platform !== 'win32') return frames;
  const { psRunner } = await import('./ps-runner');
  const reply = await psRunner.run({ cmd: 'list-windows' }) as { windows?: Array<Record<string, unknown>> } | null;
  for (const w of reply?.windows ?? []) {
    const hosted = fromFields(w as FrameWindow);
    if (hosted && w.handle !== undefined) frames.set(String(w.handle), hosted);
  }
  return frames;
}

let reader: () => Promise<Map<string, HostedApp>> = readFrames;
/** Per window handle. A frame hosts the same app for as long as it lives; a handle can be reused, so an answer ages out. */
const cache = new Map<string, { at: number; app: HostedApp | null }>();
const KNOWN_MS = 5000;
/** A frame whose app has not come up yet is asked about again soon. */
const UNKNOWN_MS = 500;

export function __setFrameHostReaderForTests(r: (() => Promise<Map<string, HostedApp>>) | null): void {
  reader = r ?? readFrames;
  cache.clear();
}

function fromFields(w: FrameWindow): HostedApp | undefined {
  const pid = w.hostedProcessId;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  const appName = typeof w.hostedAppName === 'string' && w.hostedAppName.trim() ? w.hostedAppName.trim() : undefined;
  return { processId: pid, processName: String(w.hostedProcessName ?? ''), ...(appName ? { appName } : {}) };
}

/**
 * The app a frame-host window hosts; undefined for any other window, and when it cannot be told (no handle, the bridge
 * is down, the app has not come up). A window that already says what it hosts is taken at its word.
 */
export async function hostedAppOf(w: FrameWindow): Promise<HostedApp | undefined> {
  if (!isFrameHost(w.processName)) return undefined;
  const given = fromFields(w);
  const key = w.handle === undefined ? null : String(w.handle);
  if (given) {
    if (key) cache.set(key, { at: Date.now(), app: given });
    return given;
  }
  if (!key) return undefined;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.app ? KNOWN_MS : UNKNOWN_MS)) return hit.app ?? undefined;
  let frames: Map<string, HostedApp>;
  try { frames = await reader(); } catch { return undefined; }
  const now = Date.now();
  for (const [handle, app] of frames) cache.set(handle, { at: now, app });
  if (!frames.has(key)) cache.set(key, { at: now, app: null });
  return frames.get(key);
}

/**
 * The window with its app resolved. For a Store app frame: `hostedProcessId` / `hostedProcessName` say which process the
 * app is, and `appName` becomes the APP's name ("Calculator"), not its host's ("Application Frame Host"). `processId`
 * and `processName` stay the window's own: the window does belong to the host, and focus and input are tracked by it.
 * Any other window is returned as it is.
 */
export async function withHostedApp<T extends FrameWindow & { appName?: string }>(w: T): Promise<T> {
  const hosted = await hostedAppOf(w);
  if (!hosted) return w;
  const name = hosted.appName || prettyName(hosted.processName);
  return { ...w, hostedProcessId: hosted.processId, hostedProcessName: hosted.processName, ...(name ? { appName: name } : {}) };
}

/** "CalculatorApp" → "Calculator": a Store app's process is often its name with "App" on the end. Used only when the exe has no display name. */
function prettyName(processName: string): string {
  const base = processName.replace(/\.exe$/i, '').trim();
  return base.length > 3 && /App$/.test(base) ? base.slice(0, -3) : base;
}
