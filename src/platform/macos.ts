/**
 * macOS PlatformAdapter — all macOS-specific code lives here.
 *
 * Strategy:
 *   - Keystrokes: osascript + System Events (CGEvent from helper is blocked by TCC)
 *   - Mouse: nut-js (nut-js mouse events ARE delivered)
 *   - Screenshot: screenshot-helper Swift binary (avoids ReplayKit CPU spin)
 *   - Accessibility: osascript JXA for tree queries + permission-check binary for TCC
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { mouse, Point, Button } from '@nut-tree-fork/nut-js';
import type {
  PlatformAdapter,
  ScreenSize,
  ScreenshotResult,
  WindowInfo,
  UiElement,
  PermissionStatus,
  PortableKeyCombo,
  Display,
  InvokeAction,
  MouseButton,
  ScrollDirection,
  WaitForElementQuery,
  WindowState,
} from './types';
import { waitForLaunchedWindow, buildAppPredicate } from './launch-poll';
import { getPackageRoot } from '../paths';
import { llmSize } from '../core/agent-loop/coord-scale';
import { wheelUnitsPerNotch } from './wheel';
import { readMainScreenInfo, readDisplayList } from './mac-screen';
import { MacKeyboardGuard, hasNonAscii, refuseNonAsciiChord, runAppleScript, typeTextMac, utf8ClipboardEnv } from './mac-keyboard';
import {
  defaultMacAx, MacAxError,
  type AppState, type FrontmostInfo, type MacAx, type SkippedApp,
} from './mac-ax';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(getPackageRoot(), 'scripts', 'mac');

// Tunables (kept here, not magic numbers)
const OSASCRIPT_TIMEOUT_MS = 8_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const SCREENSHOT_TIMEOUT_MS = 10_000;
/** How long open_app waits for a launched app to show a window before calling it "still loading". */
const LAUNCH_CONFIRM_MS = 4_000;
const LAUNCH_POLL_MS = 250;

/** One line for the tools: which apps' windows a time-boxed window list is missing. */
function partialWindowListNote(skipped: readonly SkippedApp[]): string {
  const names = skipped.slice(0, 4).map(a => a.processName).join(', ');
  const more = skipped.length > 4 ? `, … +${skipped.length - 4} more` : '';
  return `(partial list: the time budget ran out before ${skipped.length} app${skipped.length === 1 ? '' : 's'} ` +
    `(${names}${more}) ${skipped.length === 1 ? 'was' : 'were'} read, so their windows are missing — call again)`;
}

export class MacOSAdapter implements PlatformAdapter {
  readonly platform = 'darwin' as const;

  private screenSize: ScreenSize | null = null;
  private screenshotHelperPath: string | null = null;
  private permissionCheckPath: string | null = null;
  private inputPermissionTested = false;
  private inputPermissionCached = false;
  private readonly ax: MacAx;
  private readonly keyboard: MacKeyboardGuard;
  private inputWarning: string | null = null;

  /** Why the last findElements / getUiTree came back short (see PlatformAdapter). */
  lastFindScope: PlatformAdapter['lastFindScope'] = null;
  lastFindError: PlatformAdapter['lastFindError'] = null;
  lastFindNote: string | null = null;
  lastTreeTruncated = false;
  lastWindowListPartial: string | null = null;

  constructor(opts: { ax?: MacAx } = {}) {
    this.ax = opts.ax ?? defaultMacAx();
    this.keyboard = new MacKeyboardGuard(this.ax);
  }

  async init(): Promise<void> {
    // Find the helper binaries shipped with the app bundle.
    this.screenshotHelperPath = this.findHelper('screenshot-helper');
    this.permissionCheckPath = this.findHelper('permission-check');

    // Build the accessibility helper in the background now, so the first window
    // list / tree read already has it (until then the osascript scripts answer).
    this.ax.prepare();

    // Pre-warm screen size so first capture is fast.
    await this.getScreenSize().catch(() => null);
  }

  async shutdown(): Promise<void> {
    // No long-lived processes to clean up — osascript and nut-js are stateless.
  }

  // ─── PERMISSIONS ──────────────────────────────────────────────────

  async checkPermissions(): Promise<PermissionStatus> {
    // Test what THIS process tree can actually do, not the app bundle's TCC entry.
    const [accessibility, screenRecording] = await Promise.all([
      this.probeAccessibility(),
      this.probeScreenRecording(),
    ]);
    return { input: accessibility, accessibility, screenRecording };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    // Spawn permission-check with prompt flags to trigger the native dialogs.
    if (this.permissionCheckPath && fs.existsSync(this.permissionCheckPath)) {
      try {
        await execFileAsync(this.permissionCheckPath, ['--prompt', '--request-screen-recording'], { timeout: 30_000 });
      } catch {
        // The binary may exit non-zero if perms denied — that's fine, dialogs were shown.
      }
    }
    return this.checkPermissions();
  }

  private async probeAccessibility(): Promise<boolean> {
    try {
      // Must test actual window access — process enumeration works without assistive access.
      await execFileAsync('osascript', ['-l', 'JavaScript', '-e',
        'var se = Application("System Events"); var p = se.processes.whose({frontmost: true})[0]; p.windows.length; true',
      ], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async probeScreenRecording(): Promise<boolean> {
    // Use the Swift screenshot-helper as the probe — it's what ClawdCursor actually uses.
    if (!this.screenshotHelperPath || !fs.existsSync(this.screenshotHelperPath)) return false;
    return new Promise((resolve) => {
      const tmp = `/tmp/.clawdcursor-probe-${process.pid}.png`;
      const proc = spawn(this.screenshotHelperPath!, ['--fullscreen', tmp]);
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 5_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        try {
          if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 100) {
            fs.unlinkSync(tmp);
            return resolve(true);
          }
        } catch { /* fallthrough */ }
        try { fs.unlinkSync(tmp); } catch { /* */ }
        resolve(false);
      });
    });
  }

  // ─── DISPLAY ──────────────────────────────────────────────────────

  async getScreenSize(): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;

    // Query NSScreen for logical (point) dimensions and the backing scale, through
    // the one shared probe (mac-screen.ts). The inline `size of frame` script that
    // lived here threw on macOS 26, the error was swallowed, and logicalWidth
    // silently fell back to the PHYSICAL width — so dpiRatio was 1, the mouse
    // scale was physical/1280 instead of logical/1280, and every Retina click
    // landed 2× off (#154). OCR reported physical pixels as screen coords too.
    const main = await readMainScreenInfo();
    let logicalWidth = main?.logicalWidth ?? 0, logicalHeight = main?.logicalHeight ?? 0;
    const backingScale = main?.backingScaleFactor ?? 1;

    // Capture a probe screenshot to learn physical (retina) dimensions.
    // If the screenshot-helper binary is missing (e.g. published npm install
    // before `cd native && ./build.sh`) or Screen Recording is not granted,
    // derive them from NSScreen's backing scale instead, so listDisplays(), the
    // mouse scale and the a11y pipeline still work. Callers that genuinely need
    // screenshots will get the actionable error from screenshot().
    let physicalWidth = Math.round(logicalWidth * backingScale);
    let physicalHeight = Math.round(logicalHeight * backingScale);
    let dpiRatio = backingScale;
    try {
      const probe = await this.screenshot();
      physicalWidth = probe.width * probe.scaleFactor;
      physicalHeight = probe.height * probe.scaleFactor;
      if (!logicalWidth) logicalWidth = probe.width;
      if (!logicalHeight) logicalHeight = probe.height;
      dpiRatio = physicalWidth > logicalWidth ? physicalWidth / logicalWidth : 1;
    } catch (err) {
      // No probe. If NSScreen answered we already hold logical dims and the
      // scaled physical dims; if it did not, we have no dimensions at all —
      // surface a clear error.
      if (!logicalWidth || !logicalHeight) {
        throw err; // re-throw so init()'s .catch() swallows it, not an opaque crash
      }
    }

    this.screenSize = { physicalWidth, physicalHeight, logicalWidth, logicalHeight, dpiRatio };
    return this.screenSize;
  }

  async listDisplays(): Promise<Display[]> {
    try {
      // NSScreen.screens through mac-screen.ts: index 0 is the primary (menu-bar)
      // screen, frames are points, and each screen reports its own backing scale.
      // The inline script that was here did not compile (`(s as any) = primaryScreen`,
      // -2741), so macOS always fell through to the single-display fallback below.
      const rows = await readDisplayList();
      if (!rows) throw new Error('NSScreen enumeration unavailable');
      const primary = await this.getScreenSize();
      return rows.map((r, i) => {
        const scale = r.backingScaleFactor > 0 ? r.backingScaleFactor : primary.dpiRatio;
        return {
          index: r.index,
          label: r.index === 0 ? 'Built-in Display' : `Display ${i + 1}`,
          primary: r.primary,
          bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
          physicalSize: {
            width: Math.round(r.width * scale),
            height: Math.round(r.height * scale),
          },
          dpiRatio: scale,
        };
      });
    } catch {
      const size = await this.getScreenSize();
      return [{
        index: 0,
        label: 'Built-in Display',
        primary: true,
        bounds: { x: 0, y: 0, width: size.logicalWidth, height: size.logicalHeight },
        physicalSize: { width: size.physicalWidth, height: size.physicalHeight },
        dpiRatio: size.dpiRatio,
      }];
    }
  }

  async screenshot(opts?: { maxWidth?: number; displayIndex?: number }): Promise<ScreenshotResult> {
    if (!this.screenshotHelperPath) {
      // Build a human-readable list of the candidate paths that were searched
      // so the user knows exactly where the binary was expected.
      const root = getPackageRoot();
      const searched = [
        path.join(root, 'native', 'ClawdCursor.app', 'Contents', 'MacOS', 'screenshot-helper'),
        path.join(root, 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', 'screenshot-helper'),
        path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', 'screenshot-helper'),
      ].join('\n  ');
      throw new Error(
        `screenshot-helper not found. The native macOS helper binary was not built or installed.\n` +
        `Searched:\n  ${searched}\n\n` +
        `To fix: cd into the clawdcursor package root and run:\n` +
        `  cd native && ./build.sh\n` +
        `(Requires Xcode Command Line Tools — install with: xcode-select --install)\n\n` +
        `Or reinstall clawdcursor after installing the Command Line Tools:\n` +
        `  npm install -g clawdcursor`,
      );
    }

    const tmp = `/tmp/.clawdcursor-shot-${process.pid}-${Date.now()}.png`;
    try {
      // The Swift helper always captures the full screen. For non-primary
      // display selection we crop post-hoc from listDisplays bounds.
      await execFileAsync(this.screenshotHelperPath, ['--fullscreen', tmp], {
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      let buffer: Buffer = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch { /* */ }

      const meta = await sharp(buffer).metadata();
      let width = meta.width || 0;
      let height = meta.height || 0;
      let scaleFactor = 1;

      if (opts?.displayIndex !== undefined && opts.displayIndex > 0) {
        const displays = await this.listDisplays();
        const target = displays[opts.displayIndex];
        if (target) {
          const r = target.dpiRatio || 1;
          const left = Math.max(0, Math.round(target.bounds.x * r));
          const top = Math.max(0, Math.round(target.bounds.y * r));
          const w = Math.max(1, Math.min(Math.round(target.bounds.width * r), width - left));
          const h = Math.max(1, Math.min(Math.round(target.bounds.height * r), height - top));
          buffer = await sharp(buffer).extract({ left, top, width: w, height: h }).png().toBuffer();
          width = w;
          height = h;
        }
      }

      // maxWidth caps the LONG edge (and area) — see llmScale.
      const fit = opts?.maxWidth ? llmSize(width, height, opts.maxWidth) : null;
      if (fit && fit.scale > 1) {
        scaleFactor = fit.scale;
        const resized = await sharp(buffer).resize(fit.width, fit.height, { fit: 'fill' }).png().toBuffer();
        buffer = Buffer.from(resized);
        width = fit.width;
        height = fit.height;
      }

      return { buffer, width, height, scaleFactor };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      throw err;
    }
  }

  async screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult> {
    const full = await this.screenshot();
    const buffer = await sharp(full.buffer).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    return { buffer, width: w, height: h, scaleFactor: 1 };
  }

  // ─── WINDOWS ──────────────────────────────────────────────────────

  /**
   * Every titled window. A failure (timeout, locked screen) THROWS: it used to
   * be swallowed into `[]`, which the `window list` tool printed as "Windows (0)"
   * with fifteen windows open.
   */
  async listWindows(): Promise<WindowInfo[]> {
    this.lastWindowListPartial = null;
    const { windows, skipped } = await this.ax.listWindowsDetailed();
    if (skipped.length) this.lastWindowListPartial = partialWindowListNote(skipped);
    return windows;
  }

  /**
   * The window that has the keyboard: the frontmost app's focused window (per
   * NSWorkspace, so a system dialog counts), not "window 1" or the largest one.
   */
  async getActiveWindow(): Promise<WindowInfo | null> {
    return this.ax.activeWindow();
  }

  /** Why the last focusWindow returned false, when more is known than "no match". Taken once. */
  private focusFailure: string | null = null;
  takeFocusFailure(): string | null {
    const f = this.focusFailure;
    this.focusFailure = null;
    return f;
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    // The process is named by its PID wherever possible. System Events names an app's windows by process NAME, so with two
    // processes of one app (the user's Chrome and the agent's own) the script raised — or failed to find — the first one's
    // windows whatever pid it was given (found by the live blind run of 2026-10-19). The accessibility helper talks to the pid.
    //
    // Resolution strategy (matches Windows adapter behaviour):
    //   1. If processId is given, use it directly.
    //   2. Else if processName is given, resolve it to a processId via listWindows
    //      (avoids conflating process names with window titles — e.g. "Safari" is
    //      process name "Safari" but window title could be "Apple - iPhone 16").
    //   3. Else a title alone: the window list names the owner (a visible window before a minimized one).
    //   4. Pass title as the disambiguation hint when it is also provided.
    this.focusFailure = null;
    let processId = query.processId;
    if (processId === undefined && query.processName) {
      const target = query.processName.toLowerCase();
      // A failed list cannot resolve the name; fall through to "nothing to match on".
      const windows = await this.listWindows().catch(() => [] as WindowInfo[]);
      const hit = windows.find(w => w.processName.toLowerCase() === target)
        ?? windows.find(w => w.processName.toLowerCase().includes(target));
      if (hit) {
        processId = hit.processId;
      } else {
        // The list is the slow, fallible way to learn a pid: it can miss an app its time budget never reached (or fail
        // outright). The app is still a running process, and NSWorkspace names it in milliseconds.
        const app = await this.ax.appState(query.processName).catch(() => null);
        if (app) processId = app.processId;
      }
    } else if (processId === undefined && query.title) {
      const needle = query.title.toLowerCase();
      const windows = await this.listWindows().catch(() => [] as WindowInfo[]);
      const matches = windows.filter(w => w.title.toLowerCase().includes(needle));
      const hit = matches.find(w => !w.isMinimized) ?? matches[0];
      if (!hit) {
        this.focusFailure = `No window has a title containing "${query.title}".`;
        return false;
      }
      processId = hit.processId;
    }

    if (processId === undefined && !query.title) return false; // nothing to match on

    if (processId !== undefined) {
      try {
        if (await this.ax.focusWindow(processId, query.title)) return true;
        // null: no helper (not built yet, or switched off) — the script below is the fallback
      } catch (err) {
        this.focusFailure = err instanceof Error ? err.message : String(err);
        return false;
      }
    }

    const args: string[] = [];
    if (processId !== undefined) args.push('-processId', String(processId));
    if (query.title) args.push('-title', query.title);

    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'focus-window.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath, ...args], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const result = JSON.parse(stdout);
      if (result?.success !== true) return false;
      // The script says "focused" for whatever it raised; who really is frontmost decides.
      if (processId !== undefined) return await this.frontmostIs(processId);
      return true;
    } catch {
      return false;
    }
  }

  /** True when `processId` is frontmost within a moment (activation is not instant); otherwise records who is. */
  private async frontmostIs(processId: number): Promise<boolean> {
    let front: FrontmostInfo['app'] | null | undefined;
    for (let i = 0; i < 4; i++) {
      front = (await this.ax.frontmost().catch(() => null))?.app;
      if (!front || front.processId === processId) return true;      // unknown counts as fine: the script said it worked
      await sleep(120);
    }
    this.focusFailure = `Focus went to ${front!.name} (pid ${front!.processId}), not to pid ${processId}.`;
    return false;
  }

  async maximizeWindow(): Promise<void> {
    // macOS native fullscreen toggle.
    await this.keyPress('ctrl+mod+f').catch(() => { /* non-fatal */ });
  }

  async setWindowState(
    state: WindowState,
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    // Resolve target window. When query is omitted, we target the frontmost
    // app's frontmost window via System Events.
    const targetClause = this.buildMacWindowTargetClause(await this.resolveWindowQuery(query));
    try {
      let script: string;
      if (state === 'close') {
        // AX close action on the target window — matches UIA WindowPattern.Close semantics.
        script = `tell application "System Events" to tell ${targetClause} to click (first button whose subrole is "AXCloseButton")`;
      } else if (state === 'minimize') {
        script = `tell application "System Events" to tell ${targetClause} to set value of attribute "AXMinimized" to true`;
      } else if (state === 'maximize') {
        // macOS's closest equivalent is the zoom button (green traffic light).
        script = `tell application "System Events" to tell ${targetClause} to click (first button whose subrole is "AXZoomButton")`;
      } else {
        // normal: restore from minimized (maximize toggle is an app-level choice on mac).
        script = `tell application "System Events" to tell ${targetClause} to set value of attribute "AXMinimized" to false`;
      }
      await execFileAsync('osascript', ['-e', script], { timeout: OSASCRIPT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async setWindowBounds(
    bounds: { x?: number; y?: number; width?: number; height?: number },
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    const targetClause = this.buildMacWindowTargetClause(await this.resolveWindowQuery(query));
    try {
      // Read current bounds for fields not supplied, then assign AXPosition + AXSize.
      const readScript =
        `tell application "System Events" to tell ${targetClause}\n` +
        `  set p to position\n` +
        `  set s to size\n` +
        `  return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)\n` +
        `end tell`;
      const { stdout: cur } = await execFileAsync('osascript', ['-e', readScript], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const [cx, cy, cw, ch] = cur.trim().split(',').map(s => parseInt(s, 10) || 0);
      const x = bounds.x ?? cx;
      const y = bounds.y ?? cy;
      const w = bounds.width ?? cw;
      const h = bounds.height ?? ch;
      const setScript =
        `tell application "System Events" to tell ${targetClause}\n` +
        `  set position to {${Math.round(Number(x))}, ${Math.round(Number(y))}}\n` +
        `  set size to {${Math.round(Number(w))}, ${Math.round(Number(h))}}\n` +
        `end tell`;
      await execFileAsync('osascript', ['-e', setScript], { timeout: OSASCRIPT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A title-only query names a window, not its app. Resolve the owning process
   * from the window list so the AppleScript can address it directly — a nested
   * `whose` over every process is not valid AppleScript ("Can't make 0 into
   * type specifier" on a live Mac), and the frontmost app may not own it.
   */
  private async resolveWindowQuery(query?: { processName?: string; processId?: number; title?: string }) {
    if (!query?.title || query.processName || query.processId !== undefined) return query;
    const want = query.title.toLowerCase();
    const hit = (await this.listWindows().catch(() => [] as WindowInfo[]))
      .find(w => (w.title ?? '').toLowerCase().includes(want));
    return hit ? { processId: hit.processId, title: hit.title } : query;
  }

  private buildMacWindowTargetClause(query?: { processName?: string; processId?: number; title?: string }): string {
    if (!query) return 'window 1 of (first application process whose frontmost is true)';
    if (query.processName) {
      const safe = query.processName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (query.title) {
        const t = query.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `window "${t}" of application process "${safe}"`;
      }
      return `window 1 of application process "${safe}"`;
    }
    if (query.processId !== undefined) {
      const pid = Math.trunc(Number(query.processId));
      if (query.title) {
        const t = query.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `window "${t}" of (first application process whose unix id is ${pid})`;
      }
      return `window 1 of (first application process whose unix id is ${pid})`;
    }
    if (query.title) {
      const t = query.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // Reached only when the window list had no match (resolveWindowQuery).
      // The container must precede `whose` — `first window whose title
      // contains "X" of (process)` binds `of (process)` to "X" and never
      // resolves (every title-only resize/minimize/restore failed on a live Mac).
      return `(first window of (first application process whose frontmost is true) whose title contains "${t}")`;
    }
    return 'window 1 of (first application process whose frontmost is true)';
  }

  // ─── ACCESSIBILITY ────────────────────────────────────────────────

  /**
   * The key window's tree (the frontmost app's when `processId` is omitted).
   * A walk that hit its budget sets `lastTreeTruncated`; a timeout THROWS — it
   * used to come back as `[]`, which read_tree reported as "empty a11y tree —
   * app may be custom-canvas" for a perfectly ordinary Cocoa app.
   */
  async getUiTree(processId?: number): Promise<UiElement[]> {
    const { elements, truncated } = await this.ax.uiTree(processId);
    this.lastTreeTruncated = truncated;
    return elements;
  }

  async findElements(query: { name?: string; controlType?: string; automationId?: string; processId?: number }): Promise<UiElement[]> {
    this.lastFindError = null;
    this.lastFindNote = null;
    // Scope an unscoped query to the active window (as the Windows adapter and
    // invokeElement do) — otherwise a name that exists in every app matches
    // whichever the walk reaches first.
    let processId = query.processId;
    let scope: { processId?: number; processName?: string; title?: string } = { processId };
    if (processId === undefined) {
      const fg = await this.getActiveWindow().catch(() => null);
      if (fg?.processId) {
        processId = fg.processId;
        scope = { processId: fg.processId, processName: fg.processName, title: fg.title };
      }
    }
    this.lastFindScope = [scope];
    try {
      return await this.ax.find({ ...query, processId });
    } catch (err) {
      // A locked screen or a missing permission is not "nothing found" — say so.
      if (err instanceof MacAxError && (err.kind === 'locked' || err.kind === 'permission')) throw err;
      // A timeout is reported through lastFindError so the find tool can say
      // "TIMED OUT" instead of "(no elements found)" (parity with Windows).
      this.lastFindError = err instanceof MacAxError && err.kind === 'timeout' ? 'timeout' : err instanceof MacAxError && err.kind === 'partial' ? 'partial' : 'error';
      if (this.lastFindError === 'partial') this.lastFindNote = (err as MacAxError).message;
      return [];
    }
  }

  async getFocusedElement(): Promise<UiElement | null> {
    // Optional context for callers; a failed read is "nothing focused", as it always was.
    try {
      return await this.ax.focusedElement();
    } catch {
      return null;
    }
  }

  async invokeElement(query: {
    name?: string; controlType?: string; automationId?: string; processId?: number;
    action?: InvokeAction; value?: string;
  }): Promise<{
    success: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
    data?: Record<string, unknown>;
  }> {
    // The target needs a process; scope an unscoped call to the foreground app
    // like the Windows and Linux adapters (without this every invoke / set_value
    // by name failed on a live Mac).
    if (query.processId === undefined) {
      const fg = await this.getActiveWindow().catch(() => null);
      if (fg?.processId) query = { ...query, processId: fg.processId };
    }
    // A miss is `{success:false}`; a timeout / locked screen THROWS, because
    // "timed out" is not "element not found or not actionable".
    const res = await this.ax.invoke({ ...query, action: query.action ?? 'click' });
    // The agent loop reads the reason from `data.error` (the Linux adapter puts it there); the client reports it top-level,
    // so a refusal's explanation — "matches 2 elements: …" — used to read as "element not found or not actionable".
    return !res.success && res.error ? { ...res, data: { ...res.data, error: res.error } } : res;
  }

  async waitForElement(query: WaitForElementQuery, timeoutMs: number): Promise<UiElement | null> {
    const interval = query.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hits = await this.findElements({
        name: query.name,
        controlType: query.controlType,
        processId: query.processId,
      });
      if (hits.length > 0) return hits[0];
      await this.delay(interval);
    }
    return null;
  }

  // ─── INPUT (mouse) ────────────────────────────────────────────────

  private lastCursor: { x: number; y: number } | null = null;

  private toNutButton(button?: MouseButton): Button {
    if (button === 'right') return Button.RIGHT;
    if (button === 'middle') return Button.MIDDLE;
    return Button.LEFT;
  }

  async mouseClick(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
    await this.delay(40);
    const count = opts?.count ?? 1;
    const btn = this.toNutButton(opts?.button);
    for (let i = 0; i < count; i++) {
      if (btn === Button.RIGHT) await mouse.rightClick();
      else if (btn === Button.MIDDLE) {
        await mouse.pressButton(Button.MIDDLE);
        await this.delay(30);
        await mouse.releaseButton(Button.MIDDLE);
      } else {
        await mouse.click(Button.LEFT);
      }
      if (i < count - 1) await this.delay(60);
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    // nut-js getPosition() works reliably on macOS.
    try {
      const pos = await mouse.getPosition();
      const nx = Math.round(pos.x + dx);
      const ny = Math.round(pos.y + dy);
      await mouse.setPosition(new Point(nx, ny));
      this.lastCursor = { x: nx, y: ny };
    } catch {
      if (this.lastCursor) {
        const nx = this.lastCursor.x + dx;
        const ny = this.lastCursor.y + dy;
        await mouse.setPosition(new Point(nx, ny));
        this.lastCursor = { x: nx, y: ny };
      }
    }
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await mouse.setPosition(new Point(x1, y1));
    this.lastCursor = { x: x1, y: y1 };
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(80);
    const steps = Math.max(8, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 18));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = Math.round(x1 + (x2 - x1) * t);
      const ny = Math.round(y1 + (y2 - y1) * t);
      await mouse.setPosition(new Point(nx, ny));
      this.lastCursor = { x: nx, y: ny };
      await this.delay(10);
    }
    await mouse.releaseButton(Button.LEFT);
  }

  async mouseScroll(x: number, y: number, direction: ScrollDirection, amount: number = 3): Promise<void> {
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
    await this.delay(30);
    if (direction === 'down') await mouse.scrollDown(amount * wheelUnitsPerNotch());
    else if (direction === 'up') await mouse.scrollUp(amount * wheelUnitsPerNotch());
    else {
      // macOS horizontal scroll — hold Shift and scroll vertically. Most
      // apps interpret Shift+wheel as horizontal.
      const shiftScript = direction === 'left'
        ? 'tell application "System Events" to key down shift'
        : 'tell application "System Events" to key down shift';
      await execFileAsync('osascript', ['-e', shiftScript], { timeout: 2_000 }).catch(() => {});
      try {
        if (direction === 'left') await mouse.scrollUp(amount * wheelUnitsPerNotch());
        else await mouse.scrollDown(amount * wheelUnitsPerNotch());
      } finally {
        await execFileAsync('osascript', ['-e',
          'tell application "System Events" to key up shift',
        ], { timeout: 2_000 }).catch(() => {});
      }
    }
  }

  async mouseDown(button?: MouseButton): Promise<void> {
    await mouse.pressButton(this.toNutButton(button));
  }

  async mouseUp(button?: MouseButton): Promise<void> {
    await mouse.releaseButton(this.toNutButton(button));
  }

  // ─── INPUT (keyboard) ─────────────────────────────────────────────

  /**
   * Ask who owns the keyboard before sending keys (see MacKeyboardGuard). A refusal throws; a modal dialog of another app is
   * typed into, and the warning is kept for `takeInputWarning` so the tool result can say whose dialog got the keystrokes.
   */
  private async guardKeys(combo?: string): Promise<void> {
    const { warning } = await this.keyboard.assert(combo);
    if (warning) this.inputWarning = warning;
  }

  /** The warning from the keystrokes sent since it was last taken (or null). Tools call it right after typing / pressing keys. */
  takeInputWarning(): string | null {
    const w = this.inputWarning;
    this.inputWarning = null;
    return w;
  }

  async typeText(text: string): Promise<void> {
    if (!text) return;
    await this.guardKeys();
    // ASCII: System Events, its program on stdin (argv is readable by every process on the Mac). Anything else: the helper's
    // Unicode key events — `keystroke` would type "a" for it (#242).
    await typeTextMac(this.ax, text, 15_000);
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;
    // A bare Escape is never checked (see MacKeyboardGuard.assert).
    await this.guardKeys(combo);

    // Literal "+" can't be split.
    if (combo === '+') {
      await runAppleScript('tell application "System Events" to keystroke "+"', 6_000);
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    const key = parts[parts.length - 1];
    // Every token is interpolated into an AppleScript program, so anything
    // that isn't a known modifier/key is refused (like the Windows adapter)
    // rather than spliced in raw — a raw token can close the string literal
    // and run arbitrary AppleScript, including `do shell script`.
    const mods = parts.slice(0, -1).map(m => {
      const n = this.normalizeMod(m);
      if (!['command', 'shift', 'option', 'control'].includes(n)) throw new Error(`Unknown modifier: "${m}"`);
      return n;
    });

    const usingClause = mods.length ? ` using {${mods.map(m => `${m} down`).join(', ')}}` : '';

    // Special keys → key code; printable single chars → keystroke. A modifier on its own ("shift") is that modifier key, tapped.
    const bareModifier = mods.length === 0 ? MAC_MODIFIER_KEY_CODES[this.normalizeMod(key)] : undefined;
    const keyCode = bareModifier ?? MAC_KEY_CODES[key.toLowerCase()];
    // One character outside ASCII ("é", "日", an emoji): typed as itself, never as `keystroke` — that presses "a" (#242).
    if (keyCode === undefined && hasNonAscii(key) && [...key].length === 1) {
      refuseNonAsciiChord(key, mods.length > 0);
      await typeTextMac(this.ax, key, 6_000);
      return;
    }
    let script: string;
    if (keyCode !== undefined) {
      script = `tell application "System Events" to key code ${keyCode}${usingClause}`;
    } else if (key.length === 1) {
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${escaped}"${usingClause}`;
    } else {
      throw new Error(`Unknown key: "${key}"`);
    }

    await runAppleScript(script, 6_000);
  }

  private normalizeMod(mod: string): string {
    const m = mod.toLowerCase();
    if (m === 'mod' || m === 'cmd' || m === 'command' || m === 'super' || m === 'meta') return 'command';
    if (m === 'shift') return 'shift';
    if (m === 'alt' || m === 'option' || m === 'opt') return 'option';
    if (m === 'ctrl' || m === 'control') return 'control';
    return m;
  }

  async keyDown(key: PortableKeyCombo): Promise<void> {
    // macOS key down/up via System Events. Supports named modifiers
    // (shift/option/control/command) and arbitrary key codes. Non-modifier
    // single chars fall back to a brief keystroke.
    const lower = key.trim().toLowerCase();
    const asMod = this.modToAppleScript(lower);
    if (asMod) {
      const script = `tell application "System Events" to key down ${asMod}`;
      await runAppleScript(script, 3_000).catch(() => {});
      return;
    }
    const code = MAC_KEY_CODES[lower];
    if (code !== undefined) {
      const script = `tell application "System Events" to key down (key code ${code})`;
      await runAppleScript(script, 3_000).catch(() => {});
      return;
    }
    // Printable single char — no true "hold" semantics via keystroke; emit a tap (outside ASCII: as itself, #242).
    if ([...key].length === 1) {
      await typeTextMac(this.ax, key, 3_000).catch(() => {});
    }
  }

  async keyUp(key: PortableKeyCombo): Promise<void> {
    const lower = key.trim().toLowerCase();
    const asMod = this.modToAppleScript(lower);
    if (asMod) {
      const script = `tell application "System Events" to key up ${asMod}`;
      await runAppleScript(script, 3_000).catch(() => {});
      return;
    }
    const code = MAC_KEY_CODES[lower];
    if (code !== undefined) {
      const script = `tell application "System Events" to key up (key code ${code})`;
      await runAppleScript(script, 3_000).catch(() => {});
    }
    // Printable single char: no-op — keystroke doesn't hold.
  }

  private modToAppleScript(name: string): string | null {
    if (name === 'mod' || name === 'cmd' || name === 'command' || name === 'meta' || name === 'super') return 'command';
    if (name === 'shift') return 'shift';
    if (name === 'alt' || name === 'option' || name === 'opt') return 'option';
    if (name === 'ctrl' || name === 'control') return 'control';
    return null;
  }

  // ─── CLIPBOARD ────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3_000, env: utf8ClipboardEnv() });
      return stdout;
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('pbcopy', [], { env: utf8ClipboardEnv() });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('pbcopy timeout')); }, 3_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`pbcopy exit ${code}`));
      });
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  // ─── APPS ─────────────────────────────────────────────────────────

  /**
   * Thin shim — delegates straight to `launchApp` with no alias resolution.
   * The platform layer is alias-data-agnostic; cross-OS name mapping (e.g.
   * Windows "Notepad" → mac "TextEdit") happens in the caller above (the
   * agent's `open_app` tool, the router's `handleOpenApp`). Callers that
   * want bundle-name / searchTerm hints must pass them via `launchApp`.
   */
  async openApp(name: string, opts?: { alwaysNewInstance?: boolean }): Promise<{ pid?: number; title?: string }> {
    return this.launchApp(name, opts);
  }

  async launchApp(
    name: string,
    opts?: {
      alwaysNewInstance?: boolean;
      url?: string;
      cwd?: string;
      uwpAppId?: string;
      searchTerm?: string;
    },
  ): Promise<{ pid?: number; title?: string; handle?: number | string }> {
    // uwpAppId is Windows-only — ignore on macOS.
    void opts?.uwpAppId;
    // Reject shell-metachar input even though we use execFile (no shell expansion).
    // Keeps parity with Windows' stricter validator and avoids surprising `open`.
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars that could escape shell quoting
    if (/[\r\n\t\x00-\x1f]/.test(name)) {
      throw new Error('launchApp: illegal characters in app name');
    }

    // Ask NSWorkspace first: is the app already running, and does it have a
    // window? The old flow learned the pid only from a diff of the window list
    // (9 s on a busy Mac, and an 8 s timeout read as "no windows"), so launches
    // that had worked were reported as "Could not confirm … no window appeared",
    // and the Spotlight fallback then typed the name into Spotlight for an app
    // that was already up (live blind test, 2026-10-15). `undefined` means the
    // lookup itself failed — only then is the window-list diff the fallback.
    const before: AppState | null | undefined = await this.ax.appState(name).catch(() => undefined);

    let windowsBefore: readonly WindowInfo[] = [];
    if (before === undefined) windowsBefore = await this.listWindows().catch(() => [] as WindowInfo[]);

    // v0.8.3 — idempotency. On macOS `open -a AppName` is generally smart
    // about not spawning duplicates (it activates the existing app), but
    // we want a stable cross-OS contract: check first, focus-if-running,
    // launch only when needed. Prevents the "Outlook keeps opening" class
    // of bug from any retry loop in the pipeline.
    // Without the helper the process is known (lsappinfo) but its windows are not: ask the window list for them.
    let beforeWindows = before?.windows ?? [];
    if (before && !before.windowsKnown) {
      beforeWindows = (await this.listWindows().catch(() => [] as WindowInfo[]))
        .filter(w => w.processId === before.processId && !w.isMinimized);
    }
    if (!opts?.alwaysNewInstance && !opts?.url) {
      if (before && beforeWindows.length > 0) {
        await this.focusWindow({ processId: before.processId }).catch(() => {});
        return this.launchResult(before, beforeWindows[0]);
      }
      if (before === undefined) {
        const target = name.toLowerCase();
        const existing = windowsBefore.find(w =>
          w.processName.toLowerCase() === target ||
          w.processName.toLowerCase().includes(target) ||
          w.title.toLowerCase().includes(target),
        );
        if (existing) {
          await this.focusWindow({ processId: existing.processId }).catch(() => {});
          return { pid: existing.processId, title: existing.title, handle: existing.handle };
        }
      }
    }

    let opened = true;
    try {
      const args = ['-a', name];
      if (opts?.alwaysNewInstance) args.unshift('-n');
      if (opts?.url) args.push(opts.url);
      await execFileAsync('open', args, {
        timeout: 5_000,
        cwd: opts?.cwd,
      });
    } catch {
      // open -a failed outright — Spotlight fallback below is still worth
      // trying for apps the user can find by name.
      opened = false;
    }
    if (opened) {
      // Tighter primary budget, so the Spotlight fallback below has time if
      // `open -a` didn't surface the app (bundle name typo, name-not-found at
      // the App registry).
      const found = await this.confirmLaunch(name, before, windowsBefore, opts);
      if (found) return found;
    }

    // Spotlight fallback — universal launcher for anything macOS can find.
    // Mirrors the pattern Windows uses with the Start Menu and the same
    // shape the router's zero-LLM fast path already proves. Keyboard goes
    // through the platform's internal primitives; not gated by the safety
    // layer because this is an internal launch detail.
    const viaSpotlight = await this.launchViaSpotlight(name, opts?.searchTerm, before, windowsBefore, opts);
    if (viaSpotlight) return viaSpotlight;

    // Nothing confirmed. A system dialog or the lock screen owning the keyboard
    // is the likeliest reason — say so instead of the generic "no window appeared".
    const { error: blocked } = await this.keyboard.owner({ strict: true });
    if (blocked) throw blocked;
    return {};
  }

  private launchResult(app: AppState, win: WindowInfo): { pid: number; title: string; handle: number | string } {
    // Some windows (Calculator's) have no title; the app's own name is the honest label.
    return { pid: app.processId, title: win.title || app.name, handle: win.handle ?? app.processId };
  }

  /**
   * After `open -a` / Spotlight: wait for the app to register with NSWorkspace
   * and show a window. Running with no window yet is a launch in progress
   * ({pid} only — the tool says "still loading", not "failed"); null means it
   * never appeared at all.
   */
  private async confirmLaunch(
    name: string,
    before: AppState | null | undefined,
    windowsBefore: readonly WindowInfo[],
    opts: { alwaysNewInstance?: boolean } | undefined,
  ): Promise<{ pid?: number; title?: string; handle?: number | string } | null> {
    if (before === undefined) {
      // Process state is unreadable: the window-list diff is all there is.
      const win = await waitForLaunchedWindow(windowsBefore, () => this.listWindows(), buildAppPredicate(name), { timeoutMs: LAUNCH_CONFIRM_MS });
      return win ? { pid: win.processId, title: win.title, handle: win.handle } : null;
    }
    const deadline = Date.now() + LAUNCH_CONFIRM_MS;
    let running: AppState | null = null;
    for (;;) {
      const st = await this.ax.appState(name).catch(() => null);
      // With -n only a process other than the one we started from counts.
      if (st && (!opts?.alwaysNewInstance || st.processId !== before?.processId)) {
        running = st;
        let windows = st.windows;
        if (!st.windowsKnown) {
          // No helper: the process is known, its windows are not. Ask the list for this pid.
          windows = (await this.listWindows().catch(() => [] as WindowInfo[]))
            .filter(w => w.processId === st.processId && !w.isMinimized);
        }
        if (windows.length > 0) return this.launchResult(st, windows[0]);
      }
      if (Date.now() >= deadline) break;
      await this.delay(LAUNCH_POLL_MS);
    }
    return running ? { pid: running.processId } : null;
  }

  /**
   * Spotlight-driven launch fallback. Cmd+Space, type, Return, then poll.
   * The Cmd+Space combo is on the safety blocklist for agent-emitted keys,
   * but here the platform is calling its own keyboard primitives directly
   * to fulfill its own `launchApp` contract — the safety layer is for
   * agent actions, not internal platform plumbing.
   */
  private async launchViaSpotlight(
    name: string,
    searchTermHint: string | undefined,
    before: AppState | null | undefined,
    windowsBefore: readonly WindowInfo[],
    opts: { alwaysNewInstance?: boolean } | undefined,
  ): Promise<{ pid?: number; title?: string; handle?: number | string } | null> {
    // Prefer the alias's curated `searchTerm` (or `macOSAppName`); fall back
    // to the stripped bundle name. Keeps the launcher app-agnostic — adding
    // apps still means a row in `aliases.ts`, not platform code.
    const searchText = (searchTermHint && searchTermHint.trim())
      ? searchTermHint.trim()
      : name.replace(/\.app$/i, '');

    try {
      // Plumbing, not an agent request: with a system dialog up even the warm-up Escape stays unsent (keyPress lets Escape
      // through for an agent, but here it could answer "Don't Allow" to a permission prompt nobody asked to dismiss).
      await this.keyboard.assert(undefined, { strict: true });
      await this.keyPress('Escape').catch(() => {});
      await this.delay(120);
      await this.keyPress('cmd+Space');
      await this.delay(300);
      // Strip a trailing `.app` so Spotlight ranks the bundle correctly —
      // typing `Calculator.app` matches a Finder hit, `Calculator` matches
      // the app itself. Already handled in `searchText` above.
      await this.typeText(searchText);
      await this.delay(500);
      await this.keyPress('Return');
    } catch {
      // The keyboard is unavailable (a dialog owns it) or flaky: nothing was
      // launched, so there is nothing to wait for.
      return null;
    }
    return this.confirmLaunch(name, before, windowsBefore, opts);
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  private findHelper(name: string): string | null {
    const root = getPackageRoot();
    const candidates = [
      path.join(root, 'native', 'ClawdCursor.app', 'Contents', 'MacOS', name),
      path.join(root, 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', name),
      path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', name),
    ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// macOS virtual keycodes for special keys (US ANSI keyboard).
/** The left-hand modifier keys, for a modifier pressed on its own. */
const MAC_MODIFIER_KEY_CODES: Record<string, number> = { shift: 56, command: 55, option: 58, control: 59 };

const MAC_KEY_CODES: Record<string, number> = {
  'return': 36, 'enter': 36,
  'tab': 48,
  'space': 49,
  'delete': 51, 'backspace': 51,
  'escape': 53, 'esc': 53,
  'left': 123, 'right': 124, 'down': 125, 'up': 126,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
  'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
  'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  'forwarddelete': 117,
};
