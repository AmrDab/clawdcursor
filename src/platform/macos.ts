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

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(getPackageRoot(), 'scripts', 'mac');

// Tunables (kept here, not magic numbers)
const OSASCRIPT_TIMEOUT_MS = 8_000;
const A11Y_TREE_TIMEOUT_MS = 12_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;

export class MacOSAdapter implements PlatformAdapter {
  readonly platform = 'darwin' as const;

  private screenSize: ScreenSize | null = null;
  private screenshotHelperPath: string | null = null;
  private permissionCheckPath: string | null = null;
  private inputPermissionTested = false;
  private inputPermissionCached = false;

  async init(): Promise<void> {
    // Find the helper binaries shipped with the app bundle.
    this.screenshotHelperPath = this.findHelper('screenshot-helper');
    this.permissionCheckPath = this.findHelper('permission-check');

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

    // Query NSScreen for logical dimensions.
    let logicalWidth = 0, logicalHeight = 0;
    try {
      const out = await execFileAsync('osascript', ['-e',
        `use framework "AppKit"\n` +
        `set frame to current application's NSScreen's mainScreen's frame()\n` +
        `set sz to size of frame\n` +
        `return ((width of sz) as integer) & "," & ((height of sz) as integer) as text`,
      ], { timeout: 5_000 });
      const [w, h] = out.stdout.trim().split(',').map(s => parseInt(s, 10));
      logicalWidth = w || 0; logicalHeight = h || 0;
    } catch { /* fall through */ }

    // Capture a probe screenshot to learn physical (retina) dimensions.
    // If the screenshot-helper binary is missing (e.g. published npm install
    // before `cd native && ./build.sh`), degrade gracefully: assume 1x DPI
    // so that listDisplays() and the a11y pipeline still work.  callers that
    // genuinely need screenshots will get the actionable error from screenshot().
    let physicalWidth = logicalWidth;
    let physicalHeight = logicalHeight;
    let dpiRatio = 1;
    try {
      const probe = await this.screenshot();
      physicalWidth = probe.width * probe.scaleFactor;
      physicalHeight = probe.height * probe.scaleFactor;
      if (!logicalWidth) logicalWidth = probe.width;
      if (!logicalHeight) logicalHeight = probe.height;
      dpiRatio = physicalWidth > logicalWidth ? physicalWidth / logicalWidth : 1;
    } catch (err) {
      // Screenshot-helper absent or Screen Recording not granted.
      // logicalWidth/logicalHeight may already be set from NSScreen above;
      // if not, we have no dimensions at all — surface a clear error.
      if (!logicalWidth || !logicalHeight) {
        throw err; // re-throw so init()'s .catch() swallows it, not an opaque crash
      }
      // Usable logical dims from NSScreen — keep the physical = logical / 1x
      // fallback set at declaration (screenshot() is the first statement in the
      // try, so on this path physicalWidth/Height still hold the logical dims).
    }

    this.screenSize = { physicalWidth, physicalHeight, logicalWidth, logicalHeight, dpiRatio };
    return this.screenSize;
  }

  async listDisplays(): Promise<Display[]> {
    try {
      const out = await execFileAsync('osascript', ['-e',
        `use framework "AppKit"\n` +
        `set output to ""\n` +
        `set idx to 0\n` +
        `set primaryScreen to current application's NSScreen's mainScreen()\n` +
        `repeat with s in (current application's NSScreen's screens())\n` +
        `  set frame to frame of s\n` +
        `  set isPrimary to (s as any) = primaryScreen\n` +
        `  set output to output & (idx as text) & "|" & (item 1 of item 1 of frame) & "," & (item 2 of item 1 of frame) & "," & (item 1 of item 2 of frame) & "," & (item 2 of item 2 of frame) & "|" & (isPrimary as text) & linefeed\n` +
        `  set idx to idx + 1\n` +
        `end repeat\n` +
        `return output`,
      ], { timeout: 5_000 });

      const lines = out.stdout.trim().split('\n').filter(Boolean);
      const primary = await this.getScreenSize();
      return lines.map((line, i) => {
        const [idx, bounds, primaryFlag] = line.split('|');
        const [x, y, w, h] = bounds.split(',').map(v => parseInt(v, 10) || 0);
        return {
          index: parseInt(idx, 10) || i,
          label: parseInt(idx, 10) === 0 ? 'Built-in Display' : `Display ${i + 1}`,
          primary: primaryFlag.trim() === 'true',
          bounds: { x, y, width: w, height: h },
          physicalSize: {
            width: Math.round(w * primary.dpiRatio),
            height: Math.round(h * primary.dpiRatio),
          },
          dpiRatio: primary.dpiRatio,
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

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-windows.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return Array.isArray(raw) ? raw.map(this.normalizeWindow) : [];
    } catch {
      return [];
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-foreground-window.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return raw ? this.normalizeWindow(raw) : null;
    } catch {
      return null;
    }
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    // focus-window.jxa accepts -processId <N> and/or -title <string>.
    // The old implementation passed -FocusedProcessId / -ProcessName / -WindowTitle
    // which the JXA run(argv) parser never matched, so ANY processId-only or
    // processName-only query silently fell to "no match" and returned false.
    //
    // Resolution strategy (matches Windows adapter behaviour):
    //   1. If processId is given, use it directly.
    //   2. Else if processName is given, resolve it to a processId via listWindows
    //      (avoids conflating process names with window titles — e.g. "Safari" is
    //      process name "Safari" but window title could be "Apple - iPhone 16").
    //   3. Pass title as the disambiguation hint when it is also provided.
    let processId = query.processId;
    if (processId === undefined && query.processName) {
      const target = query.processName.toLowerCase();
      const windows = await this.listWindows();
      const hit = windows.find(w => w.processName.toLowerCase() === target)
        ?? windows.find(w => w.processName.toLowerCase().includes(target));
      if (hit) processId = hit.processId;
    }

    const args: string[] = [];
    if (processId !== undefined) args.push('-processId', String(processId));
    if (query.title) args.push('-title', query.title);

    if (args.length === 0) return false; // nothing to match on

    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'focus-window.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath, ...args], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const result = JSON.parse(stdout);
      return result?.success === true;
    } catch {
      return false;
    }
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

  async getUiTree(processId?: number): Promise<UiElement[]> {
    try {
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'get-screen-context.jxa')];
      // Match the Windows adapter's depth (8). The JXA default is 2, which only
      // reaches window → group → child — far too shallow for real apps (Mail,
      // Safari chrome, System Settings nest controls deeper), so compile_ui/
      // el_NN saw a near-empty tree and named targets went missing on macOS
      // (audit 2026-06-11, M4). The legacy AccessibilityManager already drives
      // this same script at depth 8.
      const scriptArgs = ['-MaxDepth', '8'];
      // Default to the frontmost app's pid when the caller omits it, so an
      // unscoped read_screen targets the active window (parity with the Windows
      // adapter) instead of relying on the script's default scope.
      let pid = processId;
      if (pid === undefined) {
        const fg = await this.getActiveWindow().catch(() => null);
        if (fg?.processId) pid = fg.processId;
      }
      if (pid !== undefined) scriptArgs.push('-FocusedProcessId', String(pid));
      args.push('--', ...scriptArgs);
      const { stdout } = await execFileAsync('osascript', args, { timeout: A11Y_TREE_TIMEOUT_MS });
      const data = JSON.parse(stdout);
      return this.flattenTree(data?.uiTree);
    } catch {
      return [];
    }
  }

  async findElements(query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]> {
    try {
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'find-element.jxa'), '--'];
      // find-element.jxa parses '-ProcessId' (NOT '-FocusedProcessId' — that name
      // is only understood by get-screen-context.jxa). Passing the wrong flag
      // silently dropped pid scoping (review 2026-06-11).
      if (query.processId !== undefined) args.push('-ProcessId', String(query.processId));
      if (query.name) args.push('-Name', query.name);
      if (query.controlType) args.push('-ControlType', query.controlType);
      const { stdout } = await execFileAsync('osascript', args, { timeout: A11Y_TREE_TIMEOUT_MS });
      const raw = JSON.parse(stdout);
      return Array.isArray(raw) ? raw.map(this.normalizeElement) : [];
    } catch {
      return [];
    }
  }

  async getFocusedElement(): Promise<UiElement | null> {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'get-focused-element.jxa');
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', scriptPath], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      const raw = JSON.parse(stdout);
      return raw ? this.normalizeElement(raw) : null;
    } catch {
      return null;
    }
  }

  async invokeElement(query: {
    name?: string; controlType?: string; processId?: number;
    action?: InvokeAction; value?: string;
  }): Promise<{
    success: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
    data?: Record<string, unknown>;
  }> {
    try {
      // invoke-element.jxa requires a process; scope an unscoped call to the
      // foreground app like the Windows and Linux adapters (without this every
      // invoke / set_value by name failed on a live Mac).
      if (query.processId === undefined) {
        const fg = await this.getActiveWindow().catch(() => null);
        if (fg?.processId) query = { ...query, processId: fg.processId };
      }
      const args = ['-l', 'JavaScript', path.join(SCRIPTS_DIR, 'invoke-element.jxa'), '--'];
      // invoke-element.jxa parses '-ProcessId' (NOT '-FocusedProcessId' — that
      // name belongs to get-screen-context.jxa). The wrong flag made the JXA
      // fail its required-processId check, breaking every pid-scoped invoke /
      // get-value on macOS (review 2026-06-11). The '--' is always present so
      // later flags are never eaten by osascript when processId is omitted.
      if (query.processId !== undefined) args.push('-ProcessId', String(query.processId));
      if (query.name) args.push('-Name', query.name);
      if (query.controlType) args.push('-ControlType', query.controlType);
      if (query.action) args.push('-Action', query.action);
      if (query.value !== undefined) args.push('-Value', query.value);
      const { stdout } = await execFileAsync('osascript', args, { timeout: OSASCRIPT_TIMEOUT_MS });
      const result = JSON.parse(stdout);
      return {
        success: result?.success === true,
        // A click() miss reports the element's rect / centre so the caller
        // can coordinate-fallback (parity with the Windows adapter).
        bounds: result?.bounds
          ?? (result?.clickPoint ? { x: result.clickPoint.x, y: result.clickPoint.y, width: 1, height: 1 } : undefined),
        // get-value returns its payload at the TOP level ({success, action,
        // value, method}); consumers read res.data?.value — surface it
        // (review 2026-06-11; parity with the Windows adapter).
        data: result?.data ?? (result?.value !== undefined ? { value: result.value } : undefined),
      };
    } catch {
      return { success: false };
    }
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
    if (direction === 'down') await mouse.scrollDown(amount);
    else if (direction === 'up') await mouse.scrollUp(amount);
    else {
      // macOS horizontal scroll — hold Shift and scroll vertically. Most
      // apps interpret Shift+wheel as horizontal.
      const shiftScript = direction === 'left'
        ? 'tell application "System Events" to key down shift'
        : 'tell application "System Events" to key down shift';
      await execFileAsync('osascript', ['-e', shiftScript], { timeout: 2_000 }).catch(() => {});
      try {
        if (direction === 'left') await mouse.scrollUp(amount);
        else await mouse.scrollDown(amount);
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

  async typeText(text: string): Promise<void> {
    if (!text) return;
    // Escape backslashes and quotes for AppleScript string literal.
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await execFileAsync('osascript', ['-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ], { timeout: 15_000 });
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;

    // Literal "+" can't be split.
    if (combo === '+') {
      await execFileAsync('osascript', ['-e', 'tell application "System Events" to keystroke "+"']);
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

    // Special keys → key code; printable single chars → keystroke.
    const keyCode = MAC_KEY_CODES[key.toLowerCase()];
    let script: string;
    if (keyCode !== undefined) {
      script = `tell application "System Events" to key code ${keyCode}${usingClause}`;
    } else if (key.length === 1) {
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${escaped}"${usingClause}`;
    } else {
      throw new Error(`Unknown key: "${key}"`);
    }

    await execFileAsync('osascript', ['-e', script], { timeout: 6_000 });
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
      await execFileAsync('osascript', ['-e', script], { timeout: 3_000 }).catch(() => {});
      return;
    }
    const code = MAC_KEY_CODES[lower];
    if (code !== undefined) {
      const script = `tell application "System Events" to key down (key code ${code})`;
      await execFileAsync('osascript', ['-e', script], { timeout: 3_000 }).catch(() => {});
      return;
    }
    // Printable single char — no true "hold" semantics via keystroke; emit a tap.
    if (key.length === 1) {
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await execFileAsync('osascript', ['-e', script], { timeout: 3_000 }).catch(() => {});
    }
  }

  async keyUp(key: PortableKeyCombo): Promise<void> {
    const lower = key.trim().toLowerCase();
    const asMod = this.modToAppleScript(lower);
    if (asMod) {
      const script = `tell application "System Events" to key up ${asMod}`;
      await execFileAsync('osascript', ['-e', script], { timeout: 3_000 }).catch(() => {});
      return;
    }
    const code = MAC_KEY_CODES[lower];
    if (code !== undefined) {
      const script = `tell application "System Events" to key up (key code ${code})`;
      await execFileAsync('osascript', ['-e', script], { timeout: 3_000 }).catch(() => {});
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
      const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3_000 });
      return stdout;
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('pbcopy');
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

    // Snapshot windows BEFORE any spawn so the post-launch diff-and-poll
    // helper can ignore them. Reused for the idempotency check below to
    // save a redundant Apple Events round-trip.
    let windowsBefore: readonly WindowInfo[] = [];
    try {
      windowsBefore = await this.listWindows();
    } catch {
      // Non-fatal — empty before-set is a safe default.
    }

    // v0.8.3 — idempotency. On macOS `open -a AppName` is generally smart
    // about not spawning duplicates (it activates the existing app), but
    // we want a stable cross-OS contract: check first, focus-if-running,
    // launch only when needed. Prevents the "Outlook keeps opening" class
    // of bug from any retry loop in the pipeline.
    if (!opts?.alwaysNewInstance && !opts?.url) {
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

    try {
      const args = ['-a', name];
      if (opts?.alwaysNewInstance) args.unshift('-n');
      if (opts?.url) args.push(opts.url);
      await execFileAsync('open', args, {
        timeout: 5_000,
        cwd: opts?.cwd,
      });
      // Diff-and-poll the window list with a tighter primary budget, so the
      // Spotlight fallback below has time if `open -a` didn't surface a
      // window (e.g., bundle name typo, name-not-found at App registry).
      const win = await waitForLaunchedWindow(
        windowsBefore,
        () => this.listWindows(),
        buildAppPredicate(name),
        { timeoutMs: 4_000 },
      );
      if (win) return { pid: win.processId, title: win.title, handle: win.handle };
    } catch {
      // open -a failed outright — Spotlight fallback below is still worth
      // trying for apps the user can find by name.
    }

    // Spotlight fallback — universal launcher for anything macOS can find.
    // Mirrors the pattern Windows uses with the Start Menu and the same
    // shape the router's zero-LLM fast path already proves. Keyboard goes
    // through the platform's internal primitives; not gated by the safety
    // layer because this is an internal launch detail.
    return this.launchViaSpotlight(name, opts?.searchTerm, windowsBefore);
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
    windowsBefore: readonly WindowInfo[],
  ): Promise<{ pid?: number; title?: string; handle?: number | string }> {
    // Prefer the alias's curated `searchTerm` (or `macOSAppName`); fall back
    // to the stripped bundle name. Keeps the launcher app-agnostic — adding
    // apps still means a row in `aliases.ts`, not platform code.
    const searchText = (searchTermHint && searchTermHint.trim())
      ? searchTermHint.trim()
      : name.replace(/\.app$/i, '');

    try {
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
      // Keyboard layer flaky — fall through to the empty result.
    }

    const win = await waitForLaunchedWindow(
      windowsBefore,
      () => this.listWindows(),
      buildAppPredicate(name),
      { timeoutMs: 4_000 },
    );
    return win
      ? { pid: win.processId, title: win.title, handle: win.handle }
      : {};
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

  private normalizeWindow = (raw: any): WindowInfo => ({
    title: raw.title ?? '',
    processName: raw.processName ?? '',
    processId: raw.processId ?? 0,
    bounds: raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    isMinimized: raw.isMinimized ?? false,
    handle: raw.handle ?? raw.processId,
  });

  private normalizeElement = (raw: any): UiElement => {
    const enabled = raw.enabled;
    // AX secure fields (subrole AXSecureTextField) carry secure=true from the
    // JXA helper. Never surface their value — the helper already blanked it, but
    // drop it here too so a future helper change can't leak it (M2).
    const secure = raw.secure === true;
    return {
      name: raw.name ?? '',
      controlType: (raw.controlType ?? '').replace('AX', ''),
      subrole: raw.subrole,
      secure,
      bounds: raw.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      value: secure ? undefined : raw.value,
      enabled,
      focused: raw.focused,
      // Tranche 1A: state fields — the JXA helper surfaces these when set.
      selected: raw.selected,
      disabled: enabled === false ? true : undefined,
      busy: raw.busy,
      offscreen: raw.offscreen,
      expandable: raw.expandable,
      expanded: raw.expanded,
      automationId: raw.identifier ?? raw.automationId,
      processId: raw.processId,
    };
  };

  private flattenTree(node: any, acc: UiElement[] = []): UiElement[] {
    if (!node) return acc;
    if (node.controlType || node.name) acc.push(this.normalizeElement(node));
    if (Array.isArray(node.children)) {
      for (const child of node.children) this.flattenTree(child, acc);
    }
    return acc;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// macOS virtual keycodes for special keys (US ANSI keyboard).
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
