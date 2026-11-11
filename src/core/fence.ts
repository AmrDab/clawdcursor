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
 * One rule per kind of call:
 *   - calls that touch no window (a wait, the clock, the screen size): allowed;
 *   - calls with no single target, or that reach outside by nature (the window list, the clipboard, OCR and region
 *     captures of the screen, launches and URL openers, shortcuts, reports, a pause for the user): refused;
 *   - every other call: its target must be in the fence. The target is the `processId` it names, else the windows its
 *     `title` / `processName` match (all of them), else the window in front;
 *   - a full screenshot is allowed with a fenced window in front, and everything outside that window is blacked out;
 *   - the browser driver attaches only to the agent's own debug port, never to a browser on the user's port, and
 *     launches nothing.
 * Whatever cannot be decided (no foreground, no process table) is refused.
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

// ── the check ───────────────────────────────────────────────────────────────

export interface FenceWindow {
  processId: number;
  /** Windows: the app a Store app's frame window hosts. The frame itself belongs to ApplicationFrameHost. */
  hostedProcessId?: number;
  processName?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

const windowInFence = async (w: FenceWindow, env: NodeJS.ProcessEnv) =>
  await inFence(w.processId, env) || await inFence(w.hostedProcessId, env);

interface Desktop { foreground(): Promise<FenceWindow | null>; windows(): Promise<FenceWindow[]> }

const platformDesktop: Desktop = {
  foreground: async () => (await (await import('../platform')).getPlatform()).getActiveWindow(),
  windows: async () => (await (await import('../platform')).getPlatform()).listWindows(),
};
let desktop: Desktop = platformDesktop;
export function __setFenceDesktopForTests(d: Desktop | null): void { desktop = d ?? platformDesktop; }

/**
 * THE check, used at every site. Throws the FENCED refusal unless `target` is inside the fence; a no-op with no fence.
 *   { pid }         a process the caller already knows (the window an input is about to go to, an act by name's process)
 *   { foreground }  the window in front, read here
 * Returns the window that was checked when it was read here.
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

/** Where a pointer press is about to land, in the mouse's coordinates; `boundsPerMouse` converts window bounds to them. */
export interface PointerPress { points: Array<{ x: number; y: number }>; boundsPerMouse: number }

/**
 * Input is about to be sent to the window in front (`front`, already read by the input guard): it must be a fenced
 * window, and a pointer press must land inside it, or the click would reach whatever lies beside it. A no-op with no fence.
 */
export async function fenceInput(front: FenceWindow | null, press?: PointerPress, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!fenceActive(env)) return;
  if (!front || !await windowInFence(front, env)) throw new Error(refusal('input: the window in front'));
  if (!press?.points.length) return;
  const b = front.bounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) throw new Error(refusal('pointer input: the fenced window has no known bounds, so the point'));
  const k = press.boundsPerMouse > 0 ? press.boundsPerMouse : 1;
  const SLACK = 2;
  for (const pt of press.points) {
    const x = pt.x * k, y = pt.y * k;
    if (x < b.x - SLACK || y < b.y - SLACK || x > b.x + b.width + SLACK || y > b.y + b.height + SLACK) {
      throw new Error(refusal(`pointer input: the point (${Math.round(pt.x)}, ${Math.round(pt.y)}) is not inside the fenced window in front, and what lies there`));
    }
  }
}

// ── the gate on every tool ──────────────────────────────────────────────────

/** Calls that touch no window and reveal nothing about the desktop. CDP calls are limited by the driver itself (fenceCdpPort). */
const NO_TARGET = new Set(['wait', 'get_system_time', 'get_screen_size', 'list_displays', 'shortcuts_list', 'build_uri', 'batch',
  'computer', 'accessibility', 'window', 'system', 'browser']);
/** Calls with no single target, or that reach outside by nature. */
const OUTSIDE = new Set(['get_windows', 'read_clipboard', 'write_clipboard', 'open_app', 'open_file', 'open_url', 'open_uri',
  'navigate_browser', 'switch_tab_os', 'shortcuts_execute', 'relaunch_with_cdp', 'detect_webview_apps', 'session_report',
  'pause_for_user', 'desktop_screenshot_region']);
const isOutside = (name: string) => OUTSIDE.has(name) || name.startsWith('ocr_');
const isCdp = (name: string) => name.startsWith('cdp_');

const lower = (s: unknown) => String(s ?? '').toLowerCase().replace(/\.(exe|app)$/, '');

/**
 * Decide one call. Returns the parameters to run it with (a window named by title or process name is pinned to the
 * fenced process that matched, so the tool cannot resolve the name to another window), or throws the refusal.
 */
export async function fenceGate(tool: Pick<ToolDefinition, 'name' | 'parameters'>, params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (!fenceActive(env) || NO_TARGET.has(tool.name) || isCdp(tool.name)) return params;
  if (isOutside(tool.name)) throw new Error(refusal(tool.name));

  if (typeof params.processId === 'number') {
    await fenceCheck(tool.name, { pid: params.processId }, env);
    return params;
  }
  const title = typeof params.title === 'string' && params.title ? lower(params.title) : null;
  const processName = typeof params.processName === 'string' && params.processName ? lower(params.processName) : null;
  // `title` / `processName` name a window only on tools that can also take a processId.
  if ((title || processName) && tool.parameters && 'processId' in tool.parameters) {
    const all = await desktop.windows().catch(() => [] as FenceWindow[]);
    const matched = all.filter(w => (title && lower(w.title).includes(title)) || (processName && lower(w.processName).includes(processName)));
    if (!matched.length) throw new Error(refusal(`${tool.name}: no open window matches that name, and whatever it would resolve to`));
    for (const w of matched) if (!await windowInFence(w, env)) throw new Error(refusal(`${tool.name}: a window matching that name`));
    const pids = new Set(matched.map(w => w.processId));
    if (pids.size !== 1) return params;   // several fenced processes match: any of them is inside
    const pinned: Record<string, unknown> = { ...params, processId: matched[0].processId };
    delete pinned.title;
    delete pinned.processName;
    return pinned;
  }
  await fenceCheck(tool.name, { foreground: true }, env);
  return params;
}

/**
 * Wrap every tool so the gate runs before its handler. Called once where the tool list is built: the MCP surface, the
 * compound tools and the steps of a batch all call these handlers. With no fence the tools are returned untouched.
 */
export function fenceTools(tools: ToolDefinition[], env: NodeJS.ProcessEnv = process.env): ToolDefinition[] {
  if (!fenceActive(env)) return tools;
  return tools.map(tool => ({
    ...tool,
    handler: async (params, ctx): Promise<ToolResult> => {
      let gated: Record<string, unknown>;
      try { gated = await fenceGate(tool, params ?? {}, env); }
      catch (e) { return { text: e instanceof Error ? e.message : String(e), isError: true }; }
      return tool.handler(gated, ctx);
    },
  }));
}

/** The browser driver may attach to this port only (its own), and may launch nothing. Undefined with no fence. */
export function fenceCdpOnly(agentPort: number, env: NodeJS.ProcessEnv = process.env): number | undefined {
  return fenceActive(env) ? agentPort : undefined;
}

/**
 * A full screenshot under the fence: everything outside the fenced window in front is blacked out. `frame` maps screen
 * coordinates to the image: image = (screen - origin) / scale. The image keeps its size, so coordinates read off it
 * still mean the same. Throws the refusal when no fenced window is in front. A no-op with no fence.
 */
export async function fenceMask(image: Buffer, frame: { originX: number; originY: number; scale: number },
  env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (!fenceActive(env)) return image;
  const front = await fenceCheck('desktop_screenshot', { foreground: true }, env);
  if (!front?.bounds) throw new Error(refusal('desktop_screenshot: the window in front has no known bounds, so the rest of the screen'));
  const sharp = (await import('sharp')).default;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const left = clamp((front.bounds.x - frame.originX) / frame.scale, W);
  const top = clamp((front.bounds.y - frame.originY) / frame.scale, H);
  const right = clamp((front.bounds.x + front.bounds.width - frame.originX) / frame.scale, W);
  const bottom = clamp((front.bounds.y + front.bounds.height - frame.originY) / frame.scale, H);
  if (right <= left || bottom <= top) throw new Error(refusal('desktop_screenshot: the fenced window is not on this display, so the screen'));
  const window = await sharp(image).extract({ left, top, width: right - left, height: bottom - top }).toBuffer();
  const out = sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite([{ input: window, left, top }]);
  return meta.format === 'png' ? out.png().toBuffer() : out.jpeg({ quality: 80 }).toBuffer();
}
