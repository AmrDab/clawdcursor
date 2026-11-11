/**
 * The fence: a test and automation limit on WHERE clawdcursor may act and read.
 *
 * With CLAWD_FENCE_PIDS set (comma-separated process ids), every tool call is checked BEFORE it does or reads anything:
 * its target must be a window of one of those processes or of a descendant of one. Everything else is refused with
 * `FENCED: ...` and nothing happens. With the variable unset, nothing here runs and clawdcursor behaves as always.
 *
 * It exists for the benchmark (bench/) and other unattended runs on a machine a person also uses: the harness starts
 * its fixture apps, fences the daemon to them, and the agent cannot touch, list, capture or read anything else, however
 * it asks (a top-level call, a compound action or a step of a batch: they all reach the one gate in `fenceTools`).
 *
 * It is an ALLOW list (FENCE_POLICY below): every tool is classified, and a tool that is not is refused.
 *   - free: touches no window (a wait, the clock, the screen size);
 *   - read / act: one window, which must be fenced: the handle or process it names, else the window in front;
 *   - window: focus / close / resize, only of a window identified as fenced;
 *   - capture: every image is built by `fenceImage`, which blacks out everything but the fenced window in front;
 *   - cdp: the browser driver, which attaches only to the agent's own debug port and launches nothing;
 *   - refuse: the window list, the clipboard, launches and URL openers, script injection, shortcuts, reports and logs,
 *     a pause for the user.
 * OCR (and the smart_* tools that fall back to it) is a read of one window: the engine's captures go through the same
 * mask, so text outside the fenced window is never recognised.
 * Below the tools, where input is sent: keys go only to a fenced window in front, and the pointer may only move, press
 * and release inside it. The platform's window list holds fenced windows only. Fenced windows must be wholly on the
 * primary display. Whatever cannot be decided (no foreground, no process table, no bounds, no pointer position) is refused.
 */
import { execFile } from 'child_process';
import * as os from 'os';
import type { ToolDefinition, ToolResult } from '../tools/types';

export const FENCE_ENV = 'CLAWD_FENCE_PIDS';
/** Every refusal starts with this: the result code FENCED is read from it. */
export const FENCED = 'FENCED: ';

/** The fenced root pids, or null when there is no fence. A value with no valid pid fences everything out. */
export function fenceRoots(env: NodeJS.ProcessEnv = process.env): number[] | null {
  const raw = env[FENCE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
}

export const fenceActive = (env: NodeJS.ProcessEnv = process.env): boolean => fenceRoots(env) !== null;

export function isFenceRefusal(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).startsWith(FENCED);
}

const refusal = (what: string) => `${FENCED}${what} is outside the test fence (${FENCE_ENV}) — nothing was done and nothing was read.`;

// ── which processes are inside ──────────────────────────────────────────────

/** pid → parent pid, for every process. */
type ProcessTable = Map<number, number>;

async function readProcessTable(): Promise<ProcessTable> {
  let cmd = 'ps';
  let args = ['-axo', 'pid=,ppid='];
  let opts: { timeout: number; maxBuffer: number; cwd?: string; windowsHide?: boolean } = { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, cwd: os.tmpdir() };
  if (process.platform === 'win32') {
    // Imported here: it resolves %SystemRoot%, which only exists on Windows.
    const { powershellExe, psOpts } = await import('../platform/ps-spawn');
    cmd = powershellExe();
    args = ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'];
    opts = psOpts({ timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  }
  const stdout = await new Promise<string>(resolve => execFile(cmd, args, opts, (_err, out) => resolve(String(out ?? ''))));
  const table: ProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(parent)) table.set(pid, parent);
  }
  return table;
}

let tableReader: () => Promise<ProcessTable> = readProcessTable;
let cached: { at: number; table: ProcessTable } | null = null;
const TABLE_TTL_MS = 2000;

export function __setFenceProcessTableForTests(reader: (() => Promise<Map<number, number>>) | null): void {
  tableReader = reader ?? readProcessTable;
  cached = null;
}

function within(pid: number, roots: number[], table: ProcessTable): boolean {
  const seen = new Set<number>();
  for (let p = pid; p > 0 && !seen.has(p); p = table.get(p) ?? 0) {
    if (roots.includes(p)) return true;
    seen.add(p);
  }
  return false;
}

/** Is this process a fenced root or a descendant of one? False when there is no fence to be inside of, or no answer. */
export async function inFence(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const roots = fenceRoots(env);
  if (!roots || !pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (roots.includes(pid)) return true;
  try {
    if (!cached || Date.now() - cached.at > TABLE_TTL_MS) cached = { at: Date.now(), table: await tableReader() };
    if (within(pid, roots, cached.table)) return true;
    // A process started since the table was read (a dialog's helper, a browser's new renderer): read once more.
    if (Date.now() - cached.at > 200) cached = { at: Date.now(), table: await tableReader() };
    return within(pid, roots, cached.table);
  } catch {
    return false;
  }
}

// ── windows, the desktop, geometry ──────────────────────────────────────────

export interface Rect { x: number; y: number; width: number; height: number }

export interface FenceWindow {
  processId: number;
  /** Windows: the app a Store app's frame window hosts. The frame itself belongs to ApplicationFrameHost. */
  hostedProcessId?: number;
  processName?: string;
  title?: string;
  handle?: number | string;
  bounds?: Rect;
}

const windowInFence = async (w: FenceWindow, env: NodeJS.ProcessEnv) =>
  await inFence(w.processId, env) || await inFence(w.hostedProcessId, env);

interface Desktop {
  foreground(): Promise<FenceWindow | null>;
  /** EVERY window, the ones outside the fence too: the gate needs them to see what a name or a pid could resolve to. */
  windows(): Promise<FenceWindow[]>;
  /** The primary display, in the unit of window bounds; null when it cannot be told. */
  primary(): Promise<Rect | null>;
  /** The pointer now, in the unit of window bounds; null when it cannot be told. */
  cursor(): Promise<{ x: number; y: number } | null>;
  /** Capture pixels per unit of window bounds: 1 on Windows and Linux, the primary display's scale on macOS (bounds are points there). */
  captureScale(): Promise<number>;
}

/** The adapter's own listWindows, kept when `fencePlatform` replaces it with the fenced-only one. */
const RAW_WINDOWS = Symbol('clawdcursor.fence.rawListWindows');
let cursorReader: (() => Promise<{ x: number; y: number }>) | null = null;
/** The desktop driver says how to read the pointer (in the unit it moves it in, which is the unit of window bounds). */
export function setFenceCursorReader(reader: (() => Promise<{ x: number; y: number }>) | null): void { cursorReader = reader; }

const platformDesktop: Desktop = {
  foreground: async () => (await (await import('../platform')).getPlatform()).getActiveWindow(),
  windows: async () => {
    const p = await (await import('../platform')).getPlatform() as unknown as Record<symbol, (() => Promise<FenceWindow[]>) | undefined> & { listWindows(): Promise<FenceWindow[]> };
    return (p[RAW_WINDOWS] ?? p.listWindows.bind(p))();
  },
  primary: async () => {
    const displays = await (await (await import('../platform')).getPlatform()).listDisplays();
    return primaryRect(displays);
  },
  cursor: async () => (cursorReader ? cursorReader() : null),
  captureScale: async () => {
    if (process.platform !== 'darwin') return 1;
    const displays = await (await (await import('../platform')).getPlatform()).listDisplays();
    const ratio = Number(displays.find(d => d.primary)?.dpiRatio);
    return ratio > 0 ? ratio : 1;
  },
};
let desktop: Desktop = platformDesktop;
export function __setFenceDesktopForTests(d: Partial<Desktop> | null): void {
  desktop = d ? { primary: async () => ({ x: 0, y: 0, width: 100_000, height: 100_000 }), cursor: async () => null, foreground: async () => null, windows: async () => [], captureScale: async () => 1, ...d } : platformDesktop;
}

/**
 * The primary display as a rectangle in the unit of window bounds: physical pixels on Windows and Linux (its origin is
 * 0,0 and its size the physical size), points on macOS (the display's own logical bounds).
 */
export function primaryRect(displays: Array<{ primary: boolean; bounds: Rect; physicalSize?: { width: number; height: number } }>,
  platform: string = process.platform): Rect | null {
  const p = displays.find(d => d.primary);
  if (!p) return null;
  if (platform === 'darwin' || !p.physicalSize) return p.bounds;
  return { x: 0, y: 0, width: p.physicalSize.width, height: p.physicalSize.height };
}

const SLACK = 2;
const contains = (r: Rect, x: number, y: number) => x >= r.x - SLACK && y >= r.y - SLACK && x <= r.x + r.width + SLACK && y <= r.y + r.height + SLACK;
/** Is `inner` wholly inside `outer`? (A maximized window overhangs its display by its invisible border: 16 px of slack.) */
export const wholly = (inner: Rect, outer: Rect, slack = 16) => inner.width > 0 && inner.height > 0 && inner.x >= outer.x - slack && inner.y >= outer.y - slack
  && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

/**
 * The fenced window in front, with bounds that lie wholly on the PRIMARY display. Pointer checks and the screenshot mask
 * compare coordinates with window bounds; on a second monitor with another scale factor that comparison is not proven,
 * so a fenced window anywhere else is refused, not guessed at.
 */
async function fencedFront(what: string, env: NodeJS.ProcessEnv, known?: FenceWindow | null): Promise<FenceWindow & { bounds: Rect }> {
  const front = known === undefined ? await desktop.foreground().catch(() => null) : known;
  if (!front || !await windowInFence(front, env)) throw new Error(refusal(`${what}: the window in front`));
  const b = front.bounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) throw new Error(refusal(`${what}: the fenced window has no known bounds, so where it is`));
  const primary = await desktop.primary().catch(() => null);
  if (!primary || !wholly(b, primary)) throw new Error(refusal(`${what}: the fenced window is not wholly on the primary display, and a window there`));
  return front as FenceWindow & { bounds: Rect };
}

/**
 * THE check for a target the caller already knows or the window in front. Throws the FENCED refusal unless it is inside
 * the fence; a no-op with no fence.
 */
export async function fenceCheck(what: string, target: { pid: number | undefined } | { foreground: true },
  env: NodeJS.ProcessEnv = process.env): Promise<FenceWindow | undefined> {
  if (!fenceActive(env)) return undefined;
  if ('pid' in target) {
    if (!await inFence(target.pid, env)) throw new Error(refusal(`${what}: process ${target.pid ?? '(unknown)'}`));
    return undefined;
  }
  const front = await desktop.foreground().catch(() => null);
  if (!front || !await windowInFence(front, env)) throw new Error(refusal(`${what}: the window in front`));
  return front;
}

/** Keys and text are about to go to the window in front (`front`, read by the input guard): it must be fenced. A no-op with no fence. */
export async function fenceInput(front: FenceWindow | null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!fenceActive(env)) return;
  if (!front || !await windowInFence(front, env)) throw new Error(refusal('input: the window in front'));
}

// ── the pointer ─────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Every absolute point a pointer method names: (x, y), (x1, y1, x2, y2), an action object's x/y, endX/endY, toX/toY, and
 * every point of a path given as an array of {x, y} or [x, y], anywhere in the arguments.
 */
export function pointerPoints(method: string, args: unknown[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const fromObject = (o: Record<string, unknown>) => {
    for (const [kx, ky] of [['x', 'y'], ['endX', 'endY'], ['toX', 'toY'], ['x1', 'y1'], ['x2', 'y2']]) if (isNum(o[kx]) && isNum(o[ky])) points.push({ x: o[kx] as number, y: o[ky] as number });
    for (const v of Object.values(o)) if (Array.isArray(v)) fromArray(v);
  };
  const fromArray = (a: unknown[]) => {
    for (const p of a) {
      if (Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1])) points.push({ x: p[0], y: p[1] });
      else if (p && typeof p === 'object') fromObject(p as Record<string, unknown>);
    }
  };
  if (method !== 'mouseMoveRelative') {
    // Leading numbers come in pairs: (x, y) or (x1, y1, x2, y2). A lone number is a button or an amount.
    let n = 0;
    while (n < args.length && isNum(args[n])) n++;
    const pairs = method === 'mouseDrag' ? Math.min(2, Math.floor(n / 2)) : n >= 2 ? 1 : 0;
    for (let i = 0; i < pairs; i++) points.push({ x: args[i * 2] as number, y: args[i * 2 + 1] as number });
  }
  for (const a of args) {
    if (Array.isArray(a)) fromArray(a);
    else if (a && typeof a === 'object') fromObject(a as Record<string, unknown>);
  }
  return points;
}

/**
 * A pointer method is about to run (a move, a press, a release, a click, a drag, a scroll). Under the fence the pointer
 * may only be inside the fenced window in front:
 *   - every point the call names must be inside it (each point of a drag path too);
 *   - a relative move is checked at where it ends: the live pointer plus the offset;
 *   - a press or release that names no point happens where the pointer IS, so the live position is checked.
 * Without this, a move to another window followed by a bare press would click anything on screen. A no-op with no fence.
 */
export async function fencePointer(method: string, args: unknown[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!fenceActive(env)) return;
  const front = await fencedFront('pointer input', env);
  let points = pointerPoints(method, args);
  if (method === 'mouseMoveRelative' || !points.length) {
    const at = await desktop.cursor().catch(() => null);
    if (!at) throw new Error(refusal('pointer input: the pointer position cannot be read, so wherever it is'));
    points = method === 'mouseMoveRelative' ? [{ x: at.x + (isNum(args[0]) ? args[0] : 0), y: at.y + (isNum(args[1]) ? args[1] : 0) }] : [at];
  }
  for (const pt of points) {
    if (!contains(front.bounds, pt.x, pt.y)) {
      throw new Error(refusal(`pointer input: the point (${Math.round(pt.x)}, ${Math.round(pt.y)}) is not inside the fenced window in front, and what lies there`));
    }
  }
}

// ── the gate on every tool: an ALLOW list ───────────────────────────────────

/**
 * What a tool may do under the fence. A tool that is NOT in the table is refused: a tool added later is outside the
 * fence until someone classifies it here (a test lists every registered tool and every compact action against this table).
 *
 *   free     touches no window and reveals nothing about the desktop
 *   cdp      talks to the browser driver, which the fence limits to the agent's own debug port
 *   read     reads one window: the fenced process it names, else the fenced window in front
 *   act      acts on one window, the same way; pointer and key input are checked again where they are sent
 *   window   moves, closes or focuses a window: only a window that is identified as fenced
 *   capture  returns an image: only through `fenceImage`, which blacks out everything but the fenced window
 *   refuse   has no single target, or reaches outside by nature
 */
export type FenceKind = 'free' | 'cdp' | 'read' | 'act' | 'window' | 'capture' | 'refuse';

export const FENCE_POLICY: Readonly<Record<string, FenceKind>> = {
  // Nothing on the desktop is touched or read. The compound tools and batch only dispatch: each action and each step
  // runs the handler of a tool below, and is judged there.
  wait: 'free', get_system_time: 'free', get_screen_size: 'free', list_displays: 'free', shortcuts_list: 'free', build_uri: 'free',
  cursor_position: 'free', batch: 'free', computer: 'free', accessibility: 'free', window: 'free', system: 'free', browser: 'free',

  // The browser driver (the fixture's own browser, by port). Script injection is refused: a script can forge anything.
  cdp_connect: 'cdp', cdp_page_context: 'cdp', cdp_read_text: 'cdp', cdp_click: 'cdp', cdp_type: 'cdp', cdp_select_option: 'cdp',
  cdp_wait_for_selector: 'cdp', cdp_list_tabs: 'cdp', cdp_switch_tab: 'cdp', cdp_scroll: 'cdp',
  cdp_evaluate: 'refuse',

  // Reads of one window. The window list inside read_screen comes from the platform adapter, which lists fenced windows only.
  read_screen: 'read', find_element: 'read', a11y_get_element: 'read', a11y_get_value: 'read', a11y_list_children: 'read',
  get_element_state: 'read', get_focused_element: 'read', get_active_window: 'read', compile_ui: 'read', find_action_button: 'read',
  find_input_field: 'read', wait_for_element: 'read', copy_all_text: 'read',
  // OCR reads pixels: the engine masks every capture to the fenced window first (fenceOcrCapture), so these are reads of
  // one window too. smart_* fall back to that same OCR; a click they then make is checked like any other pointer press.
  ocr_read_screen: 'read', smart_read: 'read',

  // Acts on one window.
  invoke_element: 'act', focus_element: 'act', set_field_value: 'act', a11y_collapse: 'act', a11y_expand: 'act', a11y_select: 'act',
  a11y_toggle: 'act', smart_click: 'act', smart_type: 'act', type_text: 'act', key_press: 'act', key_down: 'act', key_up: 'act', undo_last: 'act',
  mouse_click: 'act', mouse_double_click: 'act', mouse_right_click: 'act', mouse_middle_click: 'act', mouse_triple_click: 'act',
  mouse_hover: 'act', mouse_move_relative: 'act', mouse_scroll: 'act', mouse_scroll_horizontal: 'act', mouse_drag: 'act',
  mouse_drag_stepped: 'act', mouse_down: 'act', mouse_up: 'act',

  focus_window: 'window', close_window: 'window', maximize_window: 'window', minimize_window: 'window',
  minimize_window_to_taskbar: 'window', restore_window: 'window', resize_window: 'window',

  desktop_screenshot: 'capture', screenshot_full: 'capture', desktop_screenshot_region: 'capture',

  // No single target, or outside by nature: the window list, the clipboard, launches and URL openers, shortcuts, reports and logs (they leave the machine or hold other sessions), the user's pause.
  get_windows: 'refuse', read_clipboard: 'refuse', write_clipboard: 'refuse',
  open_app: 'refuse', open_file: 'refuse', open_url: 'refuse', open_uri: 'refuse', navigate_browser: 'refuse', switch_tab_os: 'refuse',
  relaunch_with_cdp: 'refuse', detect_webview_apps: 'refuse', shortcuts_execute: 'refuse',
  session_report: 'refuse', submit_report: 'refuse', logs_recent: 'refuse', verify: 'refuse',
  pause_for_user: 'refuse', resume_task: 'refuse',
};

export const fenceKind = (tool: string): FenceKind => (Object.prototype.hasOwnProperty.call(FENCE_POLICY, tool) ? FENCE_POLICY[tool] : 'refuse');

/** Fields that name a target process or window. Present, each must be a positive integer (a numeric string is normalised). */
const ID_FIELDS = ['processId', 'pid', 'handle', 'windowId', 'hwnd'] as const;

/**
 * Normalise the target fields: "1234" becomes 1234 and is passed on, so the handler and the fence see the same target.
 * Anything else that is present and not a positive integer is refused: it would skip the check and be resolved by the
 * tool in its own way.
 */
export function normaliseTargets(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params };
  for (const k of ID_FIELDS) {
    const v = out[k];
    if (v === undefined || v === null) { delete out[k]; continue; }
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n <= 0) throw new Error(refusal(`${tool}: ${k} is not a positive integer, and whatever it would resolve to`));
    out[k] = n;
  }
  return out;
}

const lower = (s: unknown) => String(s ?? '').toLowerCase().replace(/\.(exe|app)$/, '');

/**
 * Decide one call. Returns the parameters to run it with, or throws the refusal. The target of a read / act / window
 * call, in this order:
 *   1. a window handle: that exact window must be fenced;
 *   2. a process id: the process must be fenced (a Store app's shared frame host never is);
 *   3. a title or process name (window tools): every window it matches must be fenced, and all in one process, which
 *      must own NO window outside the fence. The call is then pinned to that process and keeps its title;
 *   4. nothing: the window in front must be fenced.
 */
export async function fenceGate(tool: Pick<ToolDefinition, 'name' | 'parameters'>, raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (!fenceActive(env)) return raw;
  const kind = fenceKind(tool.name);
  if (kind === 'refuse') throw new Error(refusal(tool.name));
  if (kind === 'free' || kind === 'cdp') return raw;
  const params = normaliseTargets(tool.name, raw);
  if (kind === 'capture') { await fencedFront(tool.name, env); return params; }

  const handle = params.handle ?? params.windowId ?? params.hwnd;
  const pid = (params.processId ?? params.pid) as number | undefined;
  const title = typeof params.title === 'string' && params.title ? lower(params.title) : null;
  const processName = typeof params.processName === 'string' && params.processName ? lower(params.processName) : null;

  if (handle !== undefined || (kind === 'window' && (pid !== undefined || title || processName))) {
    const all = await desktop.windows().catch(() => [] as FenceWindow[]);
    const matched = all.filter(w => (handle === undefined || Number(w.handle) === handle) && (pid === undefined || w.processId === pid)
      && (!title || lower(w.title).includes(title)) && (!processName || lower(w.processName).includes(processName)));
    if (!matched.length) throw new Error(refusal(`${tool.name}: no open window matches that target, and whatever it would resolve to`));
    for (const w of matched) if (!await windowInFence(w, env)) throw new Error(refusal(`${tool.name}: a window matching that target`));
    const owner = matched[0].processId;
    if (matched.some(w => w.processId !== owner)) throw new Error(refusal(`${tool.name}: that target matches windows of several processes, and which one it means`));
    // The tool resolves by process (and title). A process that also owns windows outside the fence (ApplicationFrameHost
    // hosts every Store app's window) could resolve to one of those: without an exact window identity it is refused.
    if (handle === undefined) {
      for (const w of all) if (w.processId === owner && !await windowInFence(w, env)) throw new Error(refusal(`${tool.name}: the process of that window also owns windows outside the fence, and a call by process`));
    }
    return { ...params, ...(tool.parameters && 'processId' in tool.parameters ? { processId: owner } : {}) };
  }
  if (pid !== undefined) {
    if (!await inFence(pid, env)) throw new Error(refusal(`${tool.name}: process ${pid}`));
    return params;
  }
  await fenceCheck(tool.name, { foreground: true }, env);
  return params;
}

// ── images ──────────────────────────────────────────────────────────────────

/** Images that went through `fenceImage` under the fence: any other image a tool returns is dropped. */
const masked = new WeakSet<object>();

/** Maps screen coordinates (the unit of a capture) to image pixels: image = (screen - origin) / scale. */
export interface CaptureFrame {
  originX: number; originY: number;
  /** Screen units per image pixel; or `screenWidth`, the width of the captured area, from which it follows. */
  scale?: number; screenWidth?: number;
  /** Capture units per unit of window bounds (macOS: pixels per point). Default 1. */
  boundsScale?: number;
}

/**
 * THE capture path: every tool that returns an image builds it here. With no fence it is the image as captured. Under
 * the fence everything outside the fenced window in front is blacked out (the image keeps its size, so coordinates read
 * off it mean the same), and the result is marked: an image that did not come through here never leaves the gate.
 */
export async function fenceImage(image: Buffer, mimeType: string, frame: CaptureFrame, env: NodeJS.ProcessEnv = process.env): Promise<{ data: string; mimeType: string }> {
  if (!fenceActive(env)) return { data: image.toString('base64'), mimeType };
  const out = { data: (await fenceMask(image, frame, env)).toString('base64'), mimeType };
  masked.add(out);
  return out;
}

/** The mask itself. Throws the refusal when no fenced window is in front, or none of it is in the image. A no-op with no fence. */
export async function fenceMask(image: Buffer, frame: CaptureFrame, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (!fenceActive(env)) return image;
  const front = await fencedFront('screen capture', env);
  const sharp = (await import('sharp')).default;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const k = frame.boundsScale && frame.boundsScale > 0 ? frame.boundsScale : 1;
  const scale = frame.scale ?? (frame.screenWidth && W ? frame.screenWidth / W : NaN);
  if (!(scale > 0)) throw new Error(refusal('screen capture: the image cannot be mapped to the screen, so the capture'));
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const b = front.bounds;
  const left = clamp((b.x * k - frame.originX) / scale, W);
  const top = clamp((b.y * k - frame.originY) / scale, H);
  const right = clamp(((b.x + b.width) * k - frame.originX) / scale, W);
  const bottom = clamp(((b.y + b.height) * k - frame.originY) / scale, H);
  if (right <= left || bottom <= top) throw new Error(refusal('screen capture: the fenced window is not in this capture, and the part of the screen that'));
  const window = await sharp(image).extract({ left, top, width: right - left, height: bottom - top }).toBuffer();
  const canvas = sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite([{ input: window, left, top }]);
  return meta.format === 'png' ? canvas.png().toBuffer() : canvas.jpeg({ quality: 80 }).toBuffer();
}

// ── wiring ──────────────────────────────────────────────────────────────────

/**
 * Wrap every tool so the gate runs before its handler, and so no unmasked image leaves it. Called once where the tool
 * list is built: the MCP surface, the compound tools and the steps of a batch all call these handlers, so a batch step
 * is judged by the same table as a direct call. With no fence the tools are returned untouched.
 */
export function fenceTools(tools: ToolDefinition[], env: NodeJS.ProcessEnv = process.env): ToolDefinition[] {
  if (!fenceActive(env)) return tools;
  return tools.map(tool => ({
    ...tool,
    handler: async (params, ctx): Promise<ToolResult> => {
      let gated: Record<string, unknown>;
      try { gated = await fenceGate(tool, params ?? {}, env); }
      catch (e) { return { text: e instanceof Error ? e.message : String(e), isError: true }; }
      const result = await tool.handler(gated, ctx);
      if (result.image && !(fenceKind(tool.name) === 'capture' && masked.has(result.image))) {
        return { text: refusal(`${tool.name}: an image that did not go through the fenced capture`), isError: true };
      }
      return result;
    },
  }));
}

/**
 * The platform adapter under the fence: its window list holds fenced windows only, so every tool that prints or
 * searches "the open windows" sees the fixture's and no others. The adapter's own list stays reachable for the gate.
 * With no fence the adapter is returned untouched.
 */
export function fencePlatform<T extends { listWindows(): Promise<FenceWindow[]> }>(adapter: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!fenceActive(env)) return adapter;
  const rawList = adapter.listWindows.bind(adapter);
  (adapter as unknown as Record<symbol, unknown>)[RAW_WINDOWS] = rawList;
  adapter.listWindows = (async () => {
    const all = await rawList();
    const inside: FenceWindow[] = [];
    for (const w of all) if (await windowInFence(w, env)) inside.push(w);
    return inside;
  }) as T['listWindows'];
  return adapter;
}

/**
 * OCR under the fence, in two steps around the engine's one recognition call:
 *
 * `fenceOcrCapture`: the captured pixels go through the same mask as a screenshot before the OCR engine sees them, so
 * text outside the fenced window in front is not there to be read. `at` is where the capture's top-left pixel is on
 * screen; the capture is in real screen pixels.
 */
export async function fenceOcrCapture(png: Buffer, at: { x: number; y: number }, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (!fenceActive(env)) return png;
  return fenceMask(png, { originX: at.x, originY: at.y, scale: 1, boundsScale: await desktop.captureScale().catch(() => 1) }, env);
}

/**
 * `fenceOcrText`: of what the engine returned (in screen pixels), only the elements inside the fenced window are kept,
 * and the flat text is rebuilt from them. With the pixels masked nothing else should be there; this holds even if a
 * capture path forgot the mask. A no-op with no fence.
 */
export async function fenceOcrText<T extends { elements: Array<{ text: string; x: number; y: number; width: number; height: number; line: number }>; fullText: string }>(
  result: T, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!fenceActive(env)) return result;
  const front = await fencedFront('OCR', env);
  const k = await desktop.captureScale().catch(() => 1);
  const b = { x: front.bounds.x * k, y: front.bounds.y * k, width: front.bounds.width * k, height: front.bounds.height * k };
  const inside = result.elements.filter(e => contains(b, e.x + e.width / 2, e.y + e.height / 2));
  if (inside.length === result.elements.length) return result;
  const lines = new Map<number, string[]>();
  for (const e of inside) lines.set(e.line, [...(lines.get(e.line) ?? []), e.text]);
  return { ...result, elements: inside, fullText: [...lines.values()].map(words => words.join(' ')).join('\n') };
}

/** The browser driver may attach to this port only (its own), and may launch nothing. Undefined with no fence. */
export function fenceCdpOnly(agentPort: number, env: NodeJS.ProcessEnv = process.env): number | undefined {
  return fenceActive(env) ? agentPort : undefined;
}
