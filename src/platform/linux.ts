/**
 * Linux PlatformAdapter — all Linux-specific code lives here.
 *
 * Strategy:
 *   - Mouse + keyboard: nut-js directly (same approach as Windows).
 *   - Screenshot: nut-js screen.grab() (X11) or grim (Wayland) → sharp for PNG encode / resize.
 *   - Screen size: xrandr --query; HiDPI via GDK_SCALE / QT_SCALE_FACTOR env.
 *   - Windows: wmctrl -lG for listing; xdotool for active-window detection.
 *   - A11y: AT-SPI bridge not yet implemented — graceful empty returns.
 *   - Clipboard: xclip -selection clipboard (X11 assumption).
 *   - openApp: spawn by name, falling back to xdg-open.
 *
 * All tool invocations tolerate missing binaries — if wmctrl/xclip/xdotool
 * are not installed the adapter still loads and methods return empty defaults.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import {
  mouse,
  keyboard,
  screen as nutScreen,
  Point,
  Button,
  Key,
} from '@nut-tree-fork/nut-js';
import { WaylandBackend } from './wayland-backend';
import { sharpFromGrab, type GrabImage } from './grab-image';
import { detectLinuxEnvironment, waylandScreenSize, grimGrab } from './wayland-screen';
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

const execFileAsync = promisify(execFile);

// Tunables
const TOOL_TIMEOUT_MS = 3_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
/**
 * AT-SPI tree walks can be slow on big apps — give them a longer budget
 * than the generic tool timeout. Python bridge caps its own traversal at
 * MAX_TREE_NODES to prevent runaway calls.
 */
const A11Y_TIMEOUT_MS = 10_000;

export class LinuxAdapter implements PlatformAdapter {
  readonly platform = 'linux' as const;
  /**
   * Wayland-vs-X11 detection runs at init(). Wayland blocks many X11-era
   * input primitives (global mouse coords, cross-window drag, synthetic
   * modifier injection) — callers use this flag to decide whether to
   * surface graceful "not supported on Wayland" errors instead of silently
   * misfiring through nut-js.
   */
  readonly environment: 'wayland' | 'x11' = detectLinuxEnvironment();

  private screenSize: ScreenSize | null = null;
  private binaryCache = new Map<string, boolean>();
  private lastCursor: { x: number; y: number } | null = null;
  /**
   * Wayland input backend. On X11 this stays `kind:'none'` and all input
   * flows through nut-js as before. On Wayland, ydotool takes over mouse +
   * keyboard (if present); wtype is a keyboard-only fallback. Without
   * either, we fall through to nut-js (which silently fails) and the
   * adapter's permission probe reports input=false.
   */
  private wayland: WaylandBackend = new WaylandBackend('none');
  /**
   * AT-SPI D-Bus a11y bridge state (Tranche 4b). The bridge is a
   * self-contained Python script (scripts/linux/atspi-bridge.py) that
   * wraps gi.repository.Atspi. We probe its availability at init —
   * requires python3 + python3-gi + gir1.2-atspi-2.0. When unavailable
   * every a11y method returns its pre-existing safe empty response so
   * nothing regresses on boxes without AT-SPI.
   */
  private atspiAvailable = false;
  private atspiScript = '';

  async init(): Promise<void> {
    // Tighten nut-js defaults (mirrors Windows path in legacy code).
    mouse.config.mouseSpeed = 2000;
    mouse.config.autoDelayMs = 0;
    keyboard.config.autoDelayMs = 0;

    // Warm binary presence cache (non-fatal if none present).
    await Promise.all([
      this.hasBinary('wmctrl'),
      this.hasBinary('xdotool'),
      this.hasBinary('xclip'),
      this.hasBinary('xrandr'),
      this.hasBinary('xdg-open'),
      // Wayland-era replacements — detected here so Tranche 4a's routing
      // decisions at init time are fast.
      this.hasBinary('ydotool'),
      this.hasBinary('wtype'),
      this.hasBinary('wl-copy'),
    ]);

    // If we're on Wayland, initialize the backend. No-op on X11.
    if (this.environment === 'wayland') {
      this.wayland = await WaylandBackend.detect(name => this.hasBinary(name));
    }

    // Probe the AT-SPI bridge (Tranche 4b). Two conditions must be met:
    // python3 must be on PATH, AND `from gi.repository import Atspi` must
    // succeed (requires python3-gi + gir1.2-atspi-2.0). We run the probe
    // with a short timeout so boots stay snappy when neither is installed.
    this.atspiScript = path.resolve(getPackageRoot(), 'scripts', 'linux', 'atspi-bridge.py');
    if (await this.hasBinary('python3')) {
      try {
        await execFileAsync(
          'python3',
          ['-c', 'import gi; gi.require_version("Atspi","2.0"); from gi.repository import Atspi'],
          { timeout: 2_000 },
        );
        this.atspiAvailable = true;
      } catch {
        // Probe failed — gi.repository.Atspi isn't installed. Keep stubs.
        this.atspiAvailable = false;
      }
    }

    // Pre-warm screen size so first capture is fast.
    await this.getScreenSize().catch(() => null);
  }

  async shutdown(): Promise<void> {
    // No long-lived processes to clean up.
  }

  // ─── PERMISSIONS ──────────────────────────────────────────────────

  async checkPermissions(): Promise<PermissionStatus> {
    // X11: implicit user-level input access. Wayland: synthetic-input APIs
    // are blocked by compositors unless the user runs ydotool (kernel
    // uinput daemon).
    // Accessibility: now reflects whether the AT-SPI bridge (Tranche 4b)
    // is available — true when python3 + python3-gi + gir1.2-atspi-2.0
    // are installed and the probe at init() succeeded.
    if (this.environment === 'wayland') {
      const canInject = await this.hasBinary('ydotool');
      return { input: canInject, accessibility: this.atspiAvailable, screenRecording: true };
    }
    return { input: true, accessibility: this.atspiAvailable, screenRecording: true };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    return this.checkPermissions();
  }

  // ─── DISPLAY ──────────────────────────────────────────────────────

  async getScreenSize(): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;

    // Prefer xrandr for logical geometry — matches mouse coordinate space.
    let logicalWidth = 0;
    let logicalHeight = 0;
    try {
      const { stdout } = await execFileAsync('xrandr', ['--query'], {
        timeout: TOOL_TIMEOUT_MS,
      });
      // Match "primary AxB" first; else the first "connected AxB+x+y" entry.
      const primary = stdout.match(/\bconnected\s+primary\s+(\d+)x(\d+)/);
      const first = stdout.match(/\bconnected(?:\s+primary)?\s+(\d+)x(\d+)/);
      const m = primary ?? first;
      if (m) {
        logicalWidth = parseInt(m[1], 10) || 0;
        logicalHeight = parseInt(m[2], 10) || 0;
      }
    } catch {
      /* xrandr missing or failed — fall through to nut-js */
    }

    // Physical dimensions — nut-js screen.grab returns hardware pixels.
    let physicalWidth = logicalWidth;
    let physicalHeight = logicalHeight;
    if (this.environment === 'wayland') {
      // nut-js screen calls are fatal on Wayland (see wayland-screen.ts) —
      // ask the compositor instead when XWayland's xrandr gave nothing.
      if (!logicalWidth) {
        const ws = await waylandScreenSize();
        if (ws) {
          logicalWidth = ws.logicalWidth;
          logicalHeight = ws.logicalHeight;
          physicalWidth = ws.physicalWidth;
          physicalHeight = ws.physicalHeight;
        }
      }
    } else {
      try {
        const w = await nutScreen.width();
        const h = await nutScreen.height();
        if (w > 0 && h > 0) {
          physicalWidth = w;
          physicalHeight = h;
        }
      } catch {
        /* nut-js unavailable — keep logical dims as physical */
      }
    }

    // If xrandr gave us nothing, assume physical == logical.
    if (!logicalWidth) logicalWidth = physicalWidth;
    if (!logicalHeight) logicalHeight = physicalHeight;

    // HiDPI hints from desktop environment env vars.
    const gdkScale = parseInt(process.env.GDK_SCALE || '1', 10);
    const qtScale = parseFloat(process.env.QT_SCALE_FACTOR || '1');
    const envScale = Math.max(
      Number.isFinite(gdkScale) ? gdkScale : 1,
      Number.isFinite(qtScale) ? qtScale : 1,
      1,
    );

    let dpiRatio = 1;
    if (physicalWidth > 0 && logicalWidth > 0 && physicalWidth > logicalWidth) {
      dpiRatio = physicalWidth / logicalWidth;
    } else if (envScale > 1) {
      dpiRatio = envScale;
      // Derive physical dims from env scale when xrandr/nut didn't disagree.
      if (physicalWidth === logicalWidth) {
        physicalWidth = Math.round(logicalWidth * envScale);
        physicalHeight = Math.round(logicalHeight * envScale);
      }
    }

    this.screenSize = {
      physicalWidth,
      physicalHeight,
      logicalWidth,
      logicalHeight,
      dpiRatio,
    };
    return this.screenSize;
  }

  async listDisplays(): Promise<Display[]> {
    // xrandr --query lists every connected output with geometry.
    if (!(await this.hasBinary('xrandr'))) {
      const size = await this.getScreenSize();
      return [{
        index: 0,
        label: 'Primary',
        primary: true,
        bounds: { x: 0, y: 0, width: size.logicalWidth, height: size.logicalHeight },
        physicalSize: { width: size.physicalWidth, height: size.physicalHeight },
        dpiRatio: size.dpiRatio,
      }];
    }
    try {
      const { stdout } = await execFileAsync('xrandr', ['--query'], {
        timeout: TOOL_TIMEOUT_MS,
      });
      const displays: Display[] = [];
      // Match lines like: "HDMI-1 connected primary 1920x1080+0+0 ..."
      const re = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/gm;
      let m: RegExpExecArray | null;
      let idx = 0;
      const size = await this.getScreenSize();
      while ((m = re.exec(stdout)) !== null) {
        const [, name, primaryFlag, w, h, x, y] = m;
        const width = parseInt(w, 10);
        const height = parseInt(h, 10);
        displays.push({
          index: idx++,
          label: name,
          primary: !!primaryFlag,
          bounds: {
            x: parseInt(x, 10),
            y: parseInt(y, 10),
            width,
            height,
          },
          physicalSize: {
            width: Math.round(width * size.dpiRatio),
            height: Math.round(height * size.dpiRatio),
          },
          dpiRatio: size.dpiRatio,
        });
      }
      if (displays.length === 0) {
        // xrandr present but parsed nothing — single-display fallback.
        return [{
          index: 0,
          label: 'Primary',
          primary: true,
          bounds: { x: 0, y: 0, width: size.logicalWidth, height: size.logicalHeight },
          physicalSize: { width: size.physicalWidth, height: size.physicalHeight },
          dpiRatio: size.dpiRatio,
        }];
      }
      // Ensure exactly one primary — prefer xrandr's flag; fallback to index 0.
      if (!displays.some(d => d.primary)) displays[0].primary = true;
      return displays;
    } catch {
      const size = await this.getScreenSize();
      return [{
        index: 0,
        label: 'Primary',
        primary: true,
        bounds: { x: 0, y: 0, width: size.logicalWidth, height: size.logicalHeight },
        physicalSize: { width: size.physicalWidth, height: size.physicalHeight },
        dpiRatio: size.dpiRatio,
      }];
    }
  }

  async screenshot(opts?: { maxWidth?: number; displayIndex?: number }): Promise<ScreenshotResult> {
    const img = await this.grabScreen();
    let pipeline = sharpFromGrab(img);

    let width = img.width;
    let height = img.height;
    let scaleFactor = 1;

    // Display index → crop to that display's bounds (xrandr geometry).
    if (opts?.displayIndex !== undefined && opts.displayIndex > 0) {
      const displays = await this.listDisplays();
      const target = displays[opts.displayIndex];
      if (target) {
        const r = target.dpiRatio || 1;
        const left = Math.max(0, Math.round(target.bounds.x * r));
        const top = Math.max(0, Math.round(target.bounds.y * r));
        const w = Math.max(1, Math.min(Math.round(target.bounds.width * r), img.width - left));
        const h = Math.max(1, Math.min(Math.round(target.bounds.height * r), img.height - top));
        pipeline = pipeline.extract({ left, top, width: w, height: h });
        width = w;
        height = h;
      }
    }

    if (opts?.maxWidth && width > opts.maxWidth) {
      scaleFactor = width / opts.maxWidth;
      const newH = Math.round(height / scaleFactor);
      pipeline = pipeline.resize(opts.maxWidth, newH, { fit: 'fill' });
      width = opts.maxWidth;
      height = newH;
    }

    const buffer = await pipeline.png().toBuffer();
    // Release raw RGBA buffer now that sharp has consumed it.
    (img as any).data = null;
    return { buffer, width, height, scaleFactor };
  }

  async screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult> {
    const img = await this.grabScreen();
    try {
      // Clamp to image bounds so sharp doesn't throw.
      const left = Math.max(0, Math.min(x, img.width - 1));
      const top = Math.max(0, Math.min(y, img.height - 1));
      const width = Math.max(1, Math.min(w, img.width - left));
      const height = Math.max(1, Math.min(h, img.height - top));
      const buffer = await sharpFromGrab(img)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      return { buffer, width, height, scaleFactor: 1 };
    } finally {
      (img as any).data = null;
    }
  }

  private async grabScreen(): Promise<GrabImage> {
    // Wayland: nut-js would open X11 and die (see wayland-screen.ts); grim or an honest error.
    if (this.environment === 'wayland') {
      return await this.withTimeout(grimGrab(), SCREENSHOT_TIMEOUT_MS, 'grim');
    }
    return await this.withTimeout(
      nutScreen.grab() as unknown as Promise<GrabImage>,
      SCREENSHOT_TIMEOUT_MS,
      'nut-js screen.grab',
    );
  }

  // ─── WINDOWS ──────────────────────────────────────────────────────

  async listWindows(): Promise<WindowInfo[]> {
    if (!(await this.hasBinary('wmctrl'))) return [];
    try {
      // -l -G -p: <id> <desktop> <pid> <x> <y> <w> <h> <host> <title...>
      const { stdout } = await execFileAsync('wmctrl', ['-l', '-G', '-p'], {
        timeout: TOOL_TIMEOUT_MS,
      });
      return this.parseWmctrlOutput(stdout);
    } catch {
      return [];
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    // xdotool gives us the active window id directly; we cross-reference wmctrl
    // for title/pid/bounds. Missing xdotool → fall back to first non-minimized.
    const all = await this.listWindows();
    if (!all.length) return null;

    if (await this.hasBinary('xdotool')) {
      try {
        const { stdout } = await execFileAsync('xdotool', ['getactivewindow'], {
          timeout: TOOL_TIMEOUT_MS,
        });
        const id = parseInt(stdout.trim(), 10);
        if (Number.isFinite(id)) {
          const match = all.find(w => typeof w.handle === 'number' && w.handle === id);
          if (match) return match;
        }
      } catch {
        /* fall through */
      }
    }
    return all[0] ?? null;
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    if (!(await this.hasBinary('wmctrl'))) return false;

    // Prefer pid-based focus when we know it (wmctrl -i -a expects window id,
    // not pid, so we find the matching id from the list first).
    try {
      const windows = await this.listWindows();
      const match = windows.find(w => {
        if (query.processId !== undefined && w.processId === query.processId) return true;
        if (query.processName && w.processName.toLowerCase() === query.processName.toLowerCase()) return true;
        if (query.title && w.title.toLowerCase().includes(query.title.toLowerCase())) return true;
        return false;
      });

      if (match?.handle !== undefined) {
        const handleHex = typeof match.handle === 'number'
          ? '0x' + match.handle.toString(16)
          : String(match.handle);
        await execFileAsync('wmctrl', ['-i', '-a', handleHex], { timeout: TOOL_TIMEOUT_MS });
        return true;
      }

      // Fallback: wmctrl -a <title substring>
      if (query.title) {
        await execFileAsync('wmctrl', ['-a', query.title], { timeout: TOOL_TIMEOUT_MS });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async maximizeWindow(): Promise<void> {
    if (!(await this.hasBinary('wmctrl'))) return;
    try {
      await execFileAsync(
        'wmctrl',
        ['-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz'],
        { timeout: TOOL_TIMEOUT_MS },
      );
    } catch {
      /* non-fatal */
    }
  }

  async setWindowState(
    state: WindowState,
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    if (!(await this.hasBinary('wmctrl'))) return false;
    const target = await this.resolveWindowHandle(query);
    if (!target) return false;

    try {
      if (state === 'maximize') {
        await execFileAsync('wmctrl', ['-i', '-r', target, '-b', 'add,maximized_vert,maximized_horz'], { timeout: TOOL_TIMEOUT_MS });
      } else if (state === 'minimize') {
        await execFileAsync('wmctrl', ['-i', '-r', target, '-b', 'add,hidden'], { timeout: TOOL_TIMEOUT_MS });
      } else if (state === 'normal') {
        // Remove maximize + hidden so the window returns to its original bounds.
        await execFileAsync('wmctrl', ['-i', '-r', target, '-b', 'remove,maximized_vert,maximized_horz,hidden'], { timeout: TOOL_TIMEOUT_MS });
      } else if (state === 'close') {
        // wmctrl -c sends _NET_CLOSE_WINDOW — the app can prompt / refuse.
        // wmctrl's -c takes a name-substring, not a window id, so we hand
        // it a title match where we can, else fall back to a generic match.
        if (query?.title) {
          await execFileAsync('wmctrl', ['-c', query.title], { timeout: TOOL_TIMEOUT_MS });
        } else {
          // xdotool lets us close by window id directly.
          if (await this.hasBinary('xdotool')) {
            await execFileAsync('xdotool', ['windowclose', target], { timeout: TOOL_TIMEOUT_MS });
          } else {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async setWindowBounds(
    bounds: { x?: number; y?: number; width?: number; height?: number },
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    if (!(await this.hasBinary('wmctrl'))) return false;
    const target = await this.resolveWindowHandle(query);
    if (!target) return false;

    try {
      // Read current bounds for fields not supplied.
      const windows = await this.listWindows();
      const current = windows.find(w => typeof w.handle === 'number' && '0x' + w.handle.toString(16) === target);
      const cur = current?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
      const x = bounds.x ?? cur.x;
      const y = bounds.y ?? cur.y;
      const w = bounds.width ?? cur.width;
      const h = bounds.height ?? cur.height;
      // wmctrl -e format: gravity,x,y,width,height — 0 = default gravity.
      await execFileAsync('wmctrl', ['-i', '-r', target, '-e', `0,${x},${y},${w},${h}`], { timeout: TOOL_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  private async resolveWindowHandle(query?: { processName?: string; processId?: number; title?: string }): Promise<string | null> {
    if (!query) {
      // Active window handle via xdotool.
      if (await this.hasBinary('xdotool')) {
        try {
          const { stdout } = await execFileAsync('xdotool', ['getactivewindow'], {
            timeout: TOOL_TIMEOUT_MS,
          });
          const id = parseInt(stdout.trim(), 10);
          if (Number.isFinite(id)) return '0x' + id.toString(16);
        } catch { /* fall through */ }
      }
      return null;
    }

    const windows = await this.listWindows();
    const match = windows.find(w => {
      if (query.processId !== undefined && w.processId === query.processId) return true;
      if (query.processName && w.processName.toLowerCase() === query.processName.toLowerCase()) return true;
      if (query.title && w.title.toLowerCase().includes(query.title.toLowerCase())) return true;
      return false;
    });
    if (match && typeof match.handle === 'number') {
      return '0x' + match.handle.toString(16);
    }
    return null;
  }

  // ─── ACCESSIBILITY ────────────────────────────────────────────────
  //
  // Tranche 4b — AT-SPI D-Bus bridge (READ-ONLY first pass).
  //
  // When the bridge is available (python3 + python3-gi + Atspi), we
  // spawn `atspi-bridge.py` to answer getUiTree / findElements /
  // getFocusedElement / waitForElement. The script emits JSON with the
  // same UiElement shape used on Windows / macOS.
  //
  // `invokeElement` stays stubbed — action dispatch (click / focus /
  // set-value / expand / ...) needs per-role handling via AT-SPI's
  // Action / EditableText / Value interfaces. Scoped out of this pass
  // so we can land READ support for Linux now and iterate. When the
  // bridge isn't available, every method falls back to the same safe
  // empty responses as before — zero regression on boxes without AT-SPI.

  async getUiTree(processId?: number): Promise<UiElement[]> {
    if (!this.atspiAvailable) return [];
    try {
      const args = ['--cmd', 'get-tree'];
      // Default to the active window's pid when the caller omits it, so an
      // unscoped read_screen targets the focused app (parity with the Windows
      // adapter) instead of walking the whole desktop tree.
      let pid = processId;
      if (typeof pid !== 'number') {
        const fg = await this.getActiveWindow().catch(() => null);
        if (fg?.processId) pid = fg.processId;
      }
      if (typeof pid === 'number') args.push('--process-id', String(pid));
      const { stdout } = await execFileAsync('python3', [this.atspiScript, ...args], {
        timeout: A11Y_TIMEOUT_MS,
      });
      const data = JSON.parse(stdout) as { elements?: any[] };
      const raw = Array.isArray(data.elements) ? data.elements : [];
      return raw.map(this.normalizeAtspiElement);
    } catch {
      return [];
    }
  }

  async findElements(query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]> {
    if (!this.atspiAvailable) return [];
    try {
      const args = ['--cmd', 'find'];
      if (query.name) args.push('--name', query.name);
      if (query.controlType) args.push('--role', query.controlType);
      if (typeof query.processId === 'number') args.push('--process-id', String(query.processId));
      const { stdout } = await execFileAsync('python3', [this.atspiScript, ...args], {
        timeout: A11Y_TIMEOUT_MS,
      });
      const data = JSON.parse(stdout) as { elements?: any[] };
      const raw = Array.isArray(data.elements) ? data.elements : [];
      return raw.map(this.normalizeAtspiElement);
    } catch {
      return [];
    }
  }

  async getFocusedElement(): Promise<UiElement | null> {
    if (!this.atspiAvailable) return null;
    try {
      const { stdout } = await execFileAsync('python3', [this.atspiScript, '--cmd', 'focused'], {
        timeout: A11Y_TIMEOUT_MS,
      });
      const data = JSON.parse(stdout) as { element?: any };
      return data.element ? this.normalizeAtspiElement(data.element) : null;
    } catch {
      return null;
    }
  }

  async invokeElement(_query: {
    name?: string;
    controlType?: string;
    processId?: number;
    action?: InvokeAction;
    value?: string;
  }): Promise<{
    success: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
    data?: Record<string, unknown>;
  }> {
    // Action dispatch is the next AT-SPI step — needs per-role AT-SPI
    // Action / Value / EditableText interface handling. Until then,
    // Linux agents use getUiTree + coord click as a coarse fallback.
    return { success: false };
  }

  async waitForElement(query: WaitForElementQuery, timeoutMs: number): Promise<UiElement | null> {
    if (!this.atspiAvailable) return null;
    const interval = query.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hits = await this.findElements({
        name: query.name, controlType: query.controlType, processId: query.processId,
      });
      if (hits.length > 0) return hits[0];
      await this.delay(interval);
    }
    return null;
  }

  /**
   * Normalize one element record from the Python bridge into the shared
   * UiElement shape used by the Windows + macOS adapters. Missing bounds
   * default to zero; missing state flags pass through as undefined.
   */
  private normalizeAtspiElement = (raw: any): UiElement => {
    const enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : undefined;
    return {
      name: raw?.name ?? '',
      controlType: raw?.controlType ?? '',
      bounds: raw?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      value: typeof raw?.value === 'string' ? raw.value : undefined,
      enabled,
      focused: raw?.focused,
      selected: raw?.selected,
      disabled: enabled === false ? true : undefined,
      busy: raw?.busy,
      offscreen: raw?.offscreen,
      automationId: raw?.automationId ?? undefined,
      processId: typeof raw?.processId === 'number' ? raw.processId : undefined,
    };
  };

  // ─── INPUT (mouse) ────────────────────────────────────────────────

  private toNutButton(button?: MouseButton): Button {
    if (button === 'right') return Button.RIGHT;
    if (button === 'middle') return Button.MIDDLE;
    return Button.LEFT;
  }

  async mouseClick(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<void> {
    const count = opts?.count ?? 1;
    const btn = opts?.button ?? 'left';
    // Wayland: ydotool handles both move + click.
    if (this.wayland.canMouse()) {
      await this.wayland.mouseMoveAbsolute(x, y);
      this.lastCursor = { x, y };
      await this.delay(30);
      await this.wayland.mouseClick(btn, count);
      return;
    }
    // X11 (or Wayland without ydotool): nut-js.
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
    await this.delay(30);
    const nutBtn = this.toNutButton(btn);
    for (let i = 0; i < count; i++) {
      if (nutBtn === Button.RIGHT) await mouse.rightClick();
      else if (nutBtn === Button.MIDDLE) {
        await mouse.pressButton(Button.MIDDLE);
        await this.delay(30);
        await mouse.releaseButton(Button.MIDDLE);
      } else {
        await mouse.click(Button.LEFT);
      }
      if (i < count - 1) await this.delay(50);
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (this.wayland.canMouse()) {
      await this.wayland.mouseMoveAbsolute(x, y);
      this.lastCursor = { x, y };
      return;
    }
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    if (this.wayland.canMouse()) {
      // ydotool supports relative move natively.
      await this.wayland.mouseMoveRelative(dx, dy);
      if (this.lastCursor) {
        this.lastCursor = { x: this.lastCursor.x + dx, y: this.lastCursor.y + dy };
      }
      return;
    }
    // On X11, nut-js getPosition() works. Without ydotool on Wayland it
    // returns (0,0) — we degrade to the cached target from our last
    // mouseMove / mouseClick.
    if (this.environment === 'x11') {
      try {
        const pos = await mouse.getPosition();
        const nx = Math.round(pos.x + dx);
        const ny = Math.round(pos.y + dy);
        await mouse.setPosition(new Point(nx, ny));
        this.lastCursor = { x: nx, y: ny };
        return;
      } catch { /* fall through */ }
    }
    if (this.lastCursor) {
      const nx = this.lastCursor.x + dx;
      const ny = this.lastCursor.y + dy;
      await mouse.setPosition(new Point(nx, ny));
      this.lastCursor = { x: nx, y: ny };
    }
    // No cache, no query — silently no-op rather than warp the cursor to (0,0).
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    if (this.wayland.canMouse()) {
      // Wayland: absolute move to start, down, interpolated moves, up.
      await this.wayland.mouseMoveAbsolute(x1, y1);
      this.lastCursor = { x: x1, y: y1 };
      await this.delay(50);
      await this.wayland.mouseDown('left');
      await this.delay(80);
      const steps = Math.max(8, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 18));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const nx = Math.round(x1 + (x2 - x1) * t);
        const ny = Math.round(y1 + (y2 - y1) * t);
        await this.wayland.mouseMoveAbsolute(nx, ny);
        this.lastCursor = { x: nx, y: ny };
        await this.delay(10);
      }
      await this.wayland.mouseUp('left');
      return;
    }
    // X11 path — unchanged nut-js.
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
    if (this.wayland.canMouse()) {
      await this.wayland.mouseMoveAbsolute(x, y);
      this.lastCursor = { x, y };
      await this.delay(30);
      await this.wayland.mouseScroll(direction, amount);
      return;
    }
    await mouse.setPosition(new Point(x, y));
    this.lastCursor = { x, y };
    await this.delay(30);
    if (direction === 'down') await mouse.scrollDown(amount);
    else if (direction === 'up') await mouse.scrollUp(amount);
    else {
      // Horizontal: xdotool uses buttons 6 (left) / 7 (right) for horizontal wheel.
      // Fall back to Shift+wheel where xdotool is missing.
      if (await this.hasBinary('xdotool')) {
        const btn = direction === 'left' ? '6' : '7';
        try {
          for (let i = 0; i < amount; i++) {
            await execFileAsync('xdotool', ['click', btn], { timeout: TOOL_TIMEOUT_MS });
          }
          return;
        } catch { /* fall through */ }
      }
      await keyboard.pressKey(Key.LeftShift);
      try {
        if (direction === 'left') await mouse.scrollUp(amount);
        else await mouse.scrollDown(amount);
      } finally {
        await keyboard.releaseKey(Key.LeftShift);
      }
    }
  }

  async mouseDown(button?: MouseButton): Promise<void> {
    if (this.wayland.canMouse()) {
      await this.wayland.mouseDown(button ?? 'left');
      return;
    }
    await mouse.pressButton(this.toNutButton(button));
  }

  async mouseUp(button?: MouseButton): Promise<void> {
    if (this.wayland.canMouse()) {
      await this.wayland.mouseUp(button ?? 'left');
      return;
    }
    await mouse.releaseButton(this.toNutButton(button));
  }

  // ─── INPUT (keyboard) ─────────────────────────────────────────────

  async typeText(text: string): Promise<void> {
    if (!text) return;
    if (this.wayland.canKeyboard()) {
      await this.wayland.typeText(text);
      return;
    }
    await keyboard.type(text);
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;
    if (this.wayland.canKeyboard()) {
      await this.wayland.keyPress(combo);
      return;
    }

    // Literal "+" — can't split on it.
    if (combo === '+') {
      await keyboard.type('+');
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    const keyName = parts[parts.length - 1];
    const modNames = parts.slice(0, -1);

    const modKeys = modNames.map(m => this.resolveModifier(m)).filter((k): k is Key => k !== null);
    const mainKey = this.resolveKey(keyName);

    if (mainKey === null) {
      // Unknown multi-char key — best-effort type as text.
      if (modKeys.length === 0 && keyName.length > 0) {
        await keyboard.type(keyName);
      }
      return;
    }

    try {
      if (modKeys.length > 0) {
        await keyboard.pressKey(...modKeys, mainKey);
        await keyboard.releaseKey(...modKeys, mainKey);
      } else {
        await keyboard.pressKey(mainKey);
        await keyboard.releaseKey(mainKey);
      }
    } catch {
      /* non-fatal — caller likely has a retry or fallback */
    }
  }

  async keyDown(key: PortableKeyCombo): Promise<void> {
    if (this.wayland.canKeyboard()) {
      await this.wayland.keyDown(key);
      return;
    }
    const lower = key.trim().toLowerCase();
    const modKey = this.resolveModifier(lower);
    if (modKey !== null) {
      await keyboard.pressKey(modKey).catch(() => {});
      return;
    }
    const k = this.resolveKey(lower.length === 1 ? lower : lower);
    if (k !== null) {
      await keyboard.pressKey(k).catch(() => {});
      return;
    }
    // Printable char without nut-js Key mapping — type it (no hold semantics).
    if (key.length === 1) {
      await keyboard.type(key).catch(() => {});
    }
  }

  async keyUp(key: PortableKeyCombo): Promise<void> {
    if (this.wayland.canKeyboard()) {
      await this.wayland.keyUp(key);
      return;
    }
    const lower = key.trim().toLowerCase();
    const modKey = this.resolveModifier(lower);
    if (modKey !== null) {
      await keyboard.releaseKey(modKey).catch(() => {});
      return;
    }
    const k = this.resolveKey(lower.length === 1 ? lower : lower);
    if (k !== null) {
      await keyboard.releaseKey(k).catch(() => {});
    }
    // Printable non-mapped: no-op — nothing was held.
  }

  private resolveModifier(name: string): Key | null {
    const m = name.toLowerCase();
    // "mod" on Linux → Control (brief §9).
    if (m === 'mod' || m === 'ctrl' || m === 'control') return Key.LeftControl;
    if (m === 'shift') return Key.LeftShift;
    if (m === 'alt' || m === 'option' || m === 'opt') return Key.LeftAlt;
    if (m === 'super' || m === 'cmd' || m === 'command' || m === 'meta' || m === 'win') return Key.LeftSuper;
    return null;
  }

  private resolveKey(name: string): Key | null {
    if (!name) return null;
    const lower = name.toLowerCase();

    // Special / named keys.
    const named = LINUX_SPECIAL_KEYS[lower];
    if (named !== undefined) return named;

    // Single printable char: letters a-z, digits 0-9, a few punctuation.
    if (name.length === 1) {
      const code = name.toUpperCase().charCodeAt(0);
      // Letters A-Z → Key.A .. Key.Z
      if (code >= 65 && code <= 90) {
        const keyName = name.toUpperCase() as keyof typeof Key;
        const k = Key[keyName];
        if (typeof k === 'number') return k as Key;
      }
      // Digits 0-9 → Key.Num0 .. Key.Num9
      if (code >= 0x30 && code <= 0x39) {
        const keyName = `Num${name}` as keyof typeof Key;
        const k = Key[keyName];
        if (typeof k === 'number') return k as Key;
      }
      // Common punctuation
      const punct = PUNCTUATION_KEYS[name];
      if (punct !== undefined) return punct;
    }

    return null;
  }

  // ─── CLIPBOARD ────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    // Prefer wl-paste on Wayland; xclip on X11. Fall through when neither
    // is installed — clipboard is best-effort, same contract as macOS.
    if (this.environment === 'wayland' && (await this.hasBinary('wl-paste'))) {
      try {
        const { stdout } = await execFileAsync('wl-paste', ['--no-newline'], { timeout: TOOL_TIMEOUT_MS });
        return stdout;
      } catch { return ''; }
    }
    if (!(await this.hasBinary('xclip'))) return '';
    try {
      const { stdout } = await execFileAsync(
        'xclip',
        ['-selection', 'clipboard', '-o'],
        { timeout: TOOL_TIMEOUT_MS },
      );
      return stdout;
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    const tool =
      this.environment === 'wayland' && (await this.hasBinary('wl-copy')) ? 'wl-copy'
      : (await this.hasBinary('xclip')) ? 'xclip' : null;
    if (!tool) return;
    const args = tool === 'wl-copy' ? [] : ['-selection', 'clipboard'];
    await new Promise<void>((resolve) => {
      try {
        const proc = spawn(tool, args);
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, TOOL_TIMEOUT_MS);
        proc.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.stdin.write(text);
        proc.stdin.end();
      } catch {
        resolve();
      }
    });
  }

  // ─── APPS ─────────────────────────────────────────────────────────

  /**
   * Thin shim — delegates straight to `launchApp` with no alias resolution.
   * The platform layer is alias-data-agnostic; cross-OS name mapping (e.g.
   * Windows-style "Notepad" → Linux "gedit") happens in the caller above
   * (the agent's `open_app` tool, the router's `handleOpenApp`).
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
    // uwpAppId is Windows-only — ignore on Linux. searchTerm currently has no
    // universal Linux launcher to drive (krunner / Activities / wmenu vary
    // by DE), so we simply accept it for interface parity.
    void opts?.uwpAppId;
    void opts?.searchTerm;
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars that could escape shell quoting
    if (/[\r\n\t\x00-\x1f]/.test(name)) {
      throw new Error('launchApp: illegal characters in app name');
    }
    // Snapshot windows BEFORE any spawn so the post-launch diff-and-poll
    // helper can ignore them. Reused for the idempotency check.
    let windowsBefore: readonly WindowInfo[] = [];
    try {
      windowsBefore = await this.listWindows();
    } catch {
      // Non-fatal — empty before-set is a safe default.
    }

    // v0.8.3 — idempotency. Check for an existing window before spawning.
    // Linux doesn't have macOS's "open -a" activation semantics, so a
    // second spawn of the same binary would normally create a second
    // instance. Focus the existing one and return its pid instead.
    if (!opts?.alwaysNewInstance && !opts?.url) {
      const target = name.trim().toLowerCase();
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

    // 1) Try the bare executable name directly (detached so it survives us).
    const directArgs: string[] = [];
    if (opts?.url) directArgs.push(opts.url);
    const direct = await this.spawnDetached(name, directArgs, opts?.cwd);
    if (direct.ok) {
      const match = await this.findSpawnedWindow(name, windowsBefore, direct.pid);
      return match ?? { pid: direct.pid };
    }

    // 2) Fallback to xdg-open (handles desktop-file names, URLs, file paths).
    const target = opts?.url ?? name;
    if (await this.hasBinary('xdg-open')) {
      const fallback = await this.spawnDetached('xdg-open', [target], opts?.cwd);
      if (fallback.ok) {
        // xdg-open's PID isn't the eventual app's PID — drop the spawn pid
        // and rely on the predicate.
        const match = await this.findSpawnedWindow(name, windowsBefore);
        return match ?? {};
      }
    }

    return {};
  }

  /**
   * After a launch, wait for the new window to surface using diff-and-poll.
   * Replaces the previous fixed-delay-then-single-scan, which lost slow-
   * starting apps (Electron-based apps, Java apps, Wine apps) and made the
   * agent fall back to keyboard shortcuts that are blocked by safety.
   *
   * Linux's `spawn(name, …)` directly produces the target app's PID (unlike
   * Windows / macOS where the spawn target is a launcher), so when `pid` is
   * supplied the helper will preferentially match it — fastest and most
   * reliable when the binary spawns its own window.
   */
  private async findSpawnedWindow(
    name: string,
    windowsBefore: readonly WindowInfo[],
    pid?: number,
  ): Promise<{ pid?: number; title?: string; handle?: number | string } | null> {
    const win = await waitForLaunchedWindow(
      windowsBefore,
      () => this.listWindows(),
      buildAppPredicate(name),
      { spawnPid: pid },
    );
    return win
      ? { pid: win.processId, title: win.title, handle: win.handle }
      : null;
  }

  private spawnDetached(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; pid?: number }> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd });
        let settled = false;

        // "error" fires synchronously-ish for ENOENT.
        proc.on('error', () => {
          if (!settled) {
            settled = true;
            resolve({ ok: false });
          }
        });

        // If it launches cleanly, we get a pid immediately.
        setImmediate(() => {
          if (settled) return;
          if (proc.pid) {
            settled = true;
            try { proc.unref(); } catch { /* */ }
            resolve({ ok: true, pid: proc.pid });
          } else {
            settled = true;
            resolve({ ok: false });
          }
        });
      } catch {
        resolve({ ok: false });
      }
    });
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  private async hasBinary(name: string): Promise<boolean> {
    const cached = this.binaryCache.get(name);
    if (cached !== undefined) return cached;
    try {
      await execFileAsync('command', ['-v', name], { timeout: 1_500, shell: '/bin/sh' });
      this.binaryCache.set(name, true);
      return true;
    } catch {
      // Fallback: try `which`.
      try {
        await execFileAsync('which', [name], { timeout: 1_500 });
        this.binaryCache.set(name, true);
        return true;
      } catch {
        this.binaryCache.set(name, false);
        return false;
      }
    }
  }

  private parseWmctrlOutput(stdout: string): WindowInfo[] {
    const results: WindowInfo[] = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // With -l -G -p: windowId desktop pid x y width height host title...
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const windowId = parseInt(parts[0], 16);
      const desktop = parseInt(parts[1], 10);
      const pid = parseInt(parts[2], 10);
      const x = parseInt(parts[3], 10);
      const y = parseInt(parts[4], 10);
      const w = parseInt(parts[5], 10);
      const h = parseInt(parts[6], 10);
      // parts[7] = host; title is everything after.
      const title = parts.slice(8).join(' ');

      if (!title || title === 'Desktop') continue;

      results.push({
        title,
        processName: '', // wmctrl doesn't expose process name
        processId: Number.isFinite(pid) ? pid : 0,
        bounds: {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          width: Number.isFinite(w) ? w : 0,
          height: Number.isFinite(h) ? h : 0,
        },
        // wmctrl -l -G -p doesn't report minimized state directly; desktop=-1 is "all",
        // not minimized. Minimized windows still appear in this list.
        isMinimized: desktop === -1 ? false : false,
        handle: Number.isFinite(windowId) ? windowId : undefined,
      });
    }
    return results;
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(v => { clearTimeout(timer); resolve(v); })
       .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// Named-key table — lowercase lookup, maps to nut-js Key enum.
const LINUX_SPECIAL_KEYS: Record<string, Key> = {
  'return': Key.Return, 'enter': Key.Enter,
  'tab': Key.Tab,
  'space': Key.Space,
  'backspace': Key.Backspace,
  'delete': Key.Delete,
  'escape': Key.Escape, 'esc': Key.Escape,
  'left': Key.Left, 'right': Key.Right, 'up': Key.Up, 'down': Key.Down,
  'home': Key.Home, 'end': Key.End,
  'pageup': Key.PageUp, 'pagedown': Key.PageDown,
  'insert': Key.Insert,
  'capslock': Key.CapsLock,
  'numlock': Key.NumLock,
  'scrolllock': Key.ScrollLock,
  'pause': Key.Pause,
  'print': Key.Print,
  'menu': Key.Menu,
  'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
  'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
  'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
};

// Punctuation keys — nut-js enum names differ from the character.
const PUNCTUATION_KEYS: Record<string, Key> = {
  '-': Key.Minus,
  '=': Key.Equal,
  '[': Key.LeftBracket,
  ']': Key.RightBracket,
  '\\': Key.Backslash,
  ';': Key.Semicolon,
  "'": Key.Quote,
  ',': Key.Comma,
  '.': Key.Period,
  '/': Key.Slash,
  '`': Key.Grave,
};
