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
 * the pill and written to the session log all go through it, in one of two ways:
 *   - for DISPLAY (the pill's label, the session log's app name, the window list): `withHostedApp` / `hostedAppOf`,
 *     which remember an answer per window handle for a few seconds;
 *   - for a DECISION (the test fence allowing an act or a read): `freshHostedAppOf`, which asks the bridge every time
 *     and trusts nothing remembered and nothing the window object carries. A handle can be reused and a frame can
 *     come to host another app: an allow must never rest on what was true a moment ago.
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
/** Per window handle, for display only. A handle can be reused, so an answer ages out; a decision never reads this. */
const cache = new Map<string, { at: number; app: HostedApp | null }>();
const KNOWN_MS = 5000;
/** A frame whose app has not come up yet is asked about again soon. */
const UNKNOWN_MS = 500;

export function __setFrameHostReaderForTests(r: (() => Promise<Map<string, HostedApp>>) | null, o: { keepCache?: boolean } = {}): void {
  reader = r ?? readFrames;
  reading = null;
  if (!o.keepCache) cache.clear();
}

function fromFields(w: FrameWindow): HostedApp | undefined {
  const pid = w.hostedProcessId;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  const appName = typeof w.hostedAppName === 'string' && w.hostedAppName.trim() ? w.hostedAppName.trim() : undefined;
  return { processId: pid, processName: String(w.hostedProcessName ?? ''), ...(appName ? { appName } : {}) };
}

/**
 * FOR DISPLAY. The app a frame-host window hosts; undefined for any other window, and when it cannot be told (no handle, the bridge
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
  try { frames = await sharedRead(); } catch { return undefined; }
  remember(frames, key);
  return frames.get(key);
}

/**
 * The read in flight, for DISPLAY: every frame that asks while the bridge is being read waits for that one read. A
 * window list with five Store app frames is one read, not five. (A decision never shares: `freshHostedAppOf`.)
 */
let reading: Promise<Map<string, HostedApp>> | null = null;
function sharedRead(): Promise<Map<string, HostedApp>> {
  return reading ??= reader().finally(() => { reading = null; });
}

/** Keep what a read said, for display: every frame it listed, and "hosts nothing yet" for the handle asked about. */
function remember(frames: Map<string, HostedApp>, asked: string): void {
  const now = Date.now();
  for (const [handle, app] of frames) cache.set(handle, { at: now, app });
  if (!frames.has(asked)) cache.set(asked, { at: now, app: null });
}

/**
 * The app a frame-host window hosts NOW, read from the bridge for this call: for decisions. Nothing cached is used and
 * the window's own `hosted*` fields are ignored (they may have come from the cache). Undefined for any other window,
 * for a window with no handle, and when the bridge cannot say: a decision then has no hosted app to allow by.
 */
export async function freshHostedAppOf(w: FrameWindow): Promise<HostedApp | undefined> {
  if (!isFrameHost(w.processName) || w.handle === undefined) return undefined;
  let frames: Map<string, HostedApp>;
  try { frames = await reader(); } catch { return undefined; }
  // What was just read is also the newest thing to show.
  const key = String(w.handle);
  remember(frames, key);
  return frames.get(key);
}

/**
 * The window with its app resolved. For a Store app frame: `hostedProcessId` / `hostedProcessName` say which process the
 * app is, and `appName` becomes the APP's name ("Calculator"), not its host's ("Application Frame Host"). `processId`
 * and `processName` stay the window's own: the window does belong to the host, and focus and input are tracked by it.
 * Any other window is returned as it is.
 */
/**
 * A whole window list, resolved for display with at most ONE bridge read, and none when it holds no Store app frame or
 * every frame in it is already known. (Resolving each window by itself asked the bridge once per unresolved frame.)
 */
export async function withHostedApps<T extends FrameWindow & { appName?: string }>(windows: T[]): Promise<T[]> {
  const unknown = windows.filter(w => isFrameHost(w.processName) && !fromFields(w) && w.handle !== undefined && !fresh(String(w.handle)));
  if (unknown.length) {
    try {
      const frames = await sharedRead();
      for (const w of unknown) remember(frames, String(w.handle));
    } catch { /* no bridge: the frames keep their host's name this time */ }
  }
  // Everything is in the cache now (or cannot be known): no further read.
  return Promise.all(windows.map(w => withHostedApp(w)));
}

/** Is there a remembered answer for this handle that is still good for display? */
function fresh(key: string): boolean {
  const hit = cache.get(key);
  return !!hit && Date.now() - hit.at < (hit.app ? KNOWN_MS : UNKNOWN_MS);
}

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
