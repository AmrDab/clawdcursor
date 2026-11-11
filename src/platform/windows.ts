/**
 * Windows PlatformAdapter — all Windows-specific code lives here.
 *
 * Strategy:
 *   - Mouse + keyboard: nut-js directly (no TCC blocking as on macOS)
 *   - Screenshot: nut-js screen.grab() — no special helper binary
 *   - Screen size + DPI: System.Windows.Forms.Screen via PowerShell for logical px,
 *                        compared with nut-js physical px to derive dpiRatio
 *   - Windows + A11y: persistent PSRunner (../../ps-runner.ts) driving UI Automation
 *   - Clipboard: Get-Clipboard / Set-Clipboard via PowerShell
 *   - App launch: Start-Process via PowerShell
 *
 * Permissions: Windows has no TCC-style gate — returns all-true.
 */

import { beforePointerPress, isOwnUiPid } from './pointer-guard';
import { resolveInstalledWindowsApp } from './win-app-resolve';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import {
  mouse,
  keyboard,
  screen,
  Point,
  Button,
  Key,
} from '@nut-tree-fork/nut-js';

import { psRunner } from './ps-runner';
import { setWindowsClipboard } from './ps-input';
import { normalizeKey } from './keys';
import { sharpFromGrab } from './grab-image';
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
  FocusActivation,
} from './types';
import { waitForLaunchedWindow, within, TIMED_OUT } from './launch-poll';
import { findWindowsProcesses } from './win-processes';
import { appIdentity, ownsWindow, type AppIdentity } from './app-identity';
import { llmSize } from '../core/agent-loop/coord-scale';
import { setWorkingPoint, onAnyDisplay } from './display-target';
import { wheelUnitsPerNotch } from './wheel';
import { windowTextIncludes } from '../tools/window-text';
import { structuredMissFields } from '../core/miss-text';
import { psOpts, powershellExe, windowsDirExe } from './ps-spawn';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// Tunables
const PS_TIMEOUT_MS = 8_000;
const CLIPBOARD_TIMEOUT_MS = 3_000;

/**
 * UIA control types the PowerShell bridge's $ctMap accepts (ps-bridge.ps1).
 * Keep in sync with that table.
 */
const UIA_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'Button', 'CheckBox', 'ComboBox', 'Custom', 'DataGrid', 'DataItem', 'Document',
  'Edit', 'Group', 'Hyperlink', 'Image', 'List', 'ListItem', 'Menu', 'MenuBar',
  'MenuItem', 'Pane', 'RadioButton', 'ScrollBar', 'Slider', 'Spinner',
  'SplitButton', 'Tab', 'TabItem', 'Text', 'ToolBar', 'Tree', 'TreeItem', 'Window',
]);

/**
 * Normalize a caller-supplied control type to the bridge's vocabulary.
 *
 * The bridge keys $ctMap on BARE names ("CheckBox"), but everything the agent
 * READS is normalized the other way — normalizeElement strips the prefix — and
 * the tool schema's own example says to send the prefixed form
 * ("ControlType.Button"). So the documented input was the one form the bridge
 * could not match: `ContainsKey` failed, no role condition was added, and the
 * search silently ran UNFILTERED. With no role filter the bridge falls back to
 * bidirectional substring name matching, so asking for a CheckBox named
 * "Allow npm publish" could return a Text element named "npm".
 *
 * Spelling is matched case- and space-insensitively: UIA itself reports a role
 * as "ControlType.MenuItem" (ProgrammaticName) AND "menu item"
 * (LocalizedControlType), and agents copy whichever they saw. Only the exact
 * PascalCase bare name used to pass, so `controlType:"menu item"` failed closed
 * on a menu item the unfiltered invoke found (live 2026-10-14).
 *
 * Returns null for a type the bridge cannot honor, so callers can fail closed
 * rather than silently searching without the filter they asked for.
 */
const UIA_CONTROL_TYPE_BY_KEY: ReadonlyMap<string, string> =
  new Map([...UIA_CONTROL_TYPES].map(t => [t.toLowerCase(), t]));
function normalizeControlType(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;          // no filter requested
  const key = raw.replace(/^ControlType\./i, '').replace(/\s+/g, '').toLowerCase();
  return UIA_CONTROL_TYPE_BY_KEY.get(key) ?? null;  // null = unhonorable
}

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = 'win32' as const;

  private screenSize: ScreenSize | null = null;

  /** Window clawdcursor most recently focused via focusWindow — the retry
   *  scope for an unscoped findElements when the live foreground is empty. */
  private lastFocused: { processId: number; processName?: string; title?: string } | null = null;
  lastFindScope: PlatformAdapter['lastFindScope'] = null;
  lastFindError: PlatformAdapter['lastFindError'] = null;
  lastTreeTruncated = false;

  // Cached physical/logical ratio, populated by getScreenSize(). nut-js mouse
  // input and the (DPI-unaware) WindowFromPoint bridge both live in LOGICAL
  // space on Windows, but callers hand us PHYSICAL coords (a11y/OCR/screenshot).
  // Every mouse entry point divides by this before touching nut-js. See #170.
  private dpiRatio = 1;
  // physical / nut-js mouse px, measured IN THIS PROCESS. Equals dpiRatio in a
  // DPI-unaware node; 1 in a DPI-aware host (Claude Desktop's Electron utility
  // process), where nut-js already drives physical px. The PowerShell bridge is
  // always DPI-unaware, so WindowFromPoint keeps using dpiRatio.
  private mouseRatio = 1;

  async init(): Promise<void> {
    // Configure nut-js for snappy input; same tuning as native-desktop.ts.
    mouse.config.mouseSpeed = 2000;
    mouse.config.autoDelayMs = 0;
    keyboard.config.autoDelayMs = 0;

    // Kick off the PowerShell bridge so the ~800ms UIA assembly load happens
    // in the background. Errors surface on first real a11y call.
    psRunner.start().catch(() => { /* non-fatal — retried on first use */ });

    // Pre-warm screen size so the first capture / first click isn't paying for it.
    await this.getScreenSize().catch(() => null);
  }

  async shutdown(): Promise<void> {
    try { psRunner.stop(); } catch { /* */ }
  }

  // ─── PERMISSIONS ──────────────────────────────────────────────────

  async checkPermissions(): Promise<PermissionStatus> {
    // Windows doesn't gate any of these behind TCC-style prompts. If the
    // user can run the binary at all, they can do input / capture / a11y.
    return { input: true, accessibility: true, screenRecording: true };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    return this.checkPermissions();
  }

  // ─── DISPLAY ──────────────────────────────────────────────────────

  async getScreenSize(): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;

    // nut-js screen.grab() returns PHYSICAL pixels on Windows.
    let physicalWidth = 0, physicalHeight = 0;
    try {
      const img = await screen.grab();
      physicalWidth = img.width;
      physicalHeight = img.height;
      (img as any).data = null;
    } catch { /* fall through with zeros */ }

    // System.Windows.Forms.Screen returns LOGICAL (DPI-scaled) pixels on Win —
    // that's the coordinate space nut-js mouse API expects.
    let logicalWidth = physicalWidth;
    let logicalHeight = physicalHeight;
    try {
      const { stdout } = await execFileAsync(
        powershellExe(),
        [
          '-NoProfile',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; ' +
          '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
          '"$($s.Width),$($s.Height)"',
        ],
        psOpts({ timeout: PS_TIMEOUT_MS }),
      );
      const [w, h] = stdout.trim().split(',').map(s => parseInt(s, 10));
      if (w > 0 && h > 0) {
        logicalWidth = w;
        logicalHeight = h;
      }
    } catch { /* non-fatal — fall back to physical */ }

    if (!physicalWidth) physicalWidth = logicalWidth;
    if (!physicalHeight) physicalHeight = logicalHeight;

    const dpiRatio = physicalWidth > logicalWidth ? physicalWidth / logicalWidth : 1;
    this.dpiRatio = dpiRatio;
    this.mouseRatio = dpiRatio;
    try {
      const mouseW = await screen.width();
      if (mouseW > 0 && physicalWidth > 0) this.mouseRatio = physicalWidth > mouseW ? physicalWidth / mouseW : 1;
    } catch { /* keep dpiRatio */ }

    this.screenSize = {
      physicalWidth,
      physicalHeight,
      logicalWidth,
      logicalHeight,
      dpiRatio,
    };
    return this.screenSize;
  }

  /**
   * The monitors as the bridge enumerates them, under per-monitor-v2
   * awareness: bounds are PHYSICAL virtual-desktop pixels (the space clicks
   * and UIA rects use) and each monitor reports its OWN scaling — any layout,
   * negative origins included. Primary is index 0. Empty when the bridge fails.
   */
  private async bridgeDisplays(): Promise<Display[]> {
    try {
      const r = await psRunner.run({ cmd: 'list-displays' }) as {
        success?: boolean;
        displays?: Array<{ name: string; primary: boolean; x: number; y: number; width: number; height: number; scale: number }>;
      };
      if (r?.success && r.displays?.length) {
        return [...r.displays]
          .sort((a, b) => Number(b.primary) - Number(a.primary))
          .map((d, i) => ({
            index: i,
            label: d.name || `Display ${i + 1}`,
            primary: !!d.primary,
            bounds: { x: d.x, y: d.y, width: d.width, height: d.height },
            physicalSize: { width: d.width, height: d.height },
            dpiRatio: d.scale || 1,
          }));
      }
    } catch { /* the caller decides what a missing list means */ }
    return [];
  }

  async listDisplays(): Promise<Display[]> {
    const fromBridge = await this.bridgeDisplays();
    if (fromBridge.length) return fromBridge;
    // System.Windows.Forms.Screen.AllScreens enumerates every connected
    // display with bounds + primary flag. We call it via the PS UIA path
    // we already have warmed up.
    try {
      const { stdout } = await execFileAsync(
        powershellExe(),
        [
          '-NoProfile',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; ' +
          '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
          '  $b = $_.Bounds; ' +
          '  [pscustomobject]@{ ' +
          '    name = $_.DeviceName; ' +
          '    primary = $_.Primary; ' +
          '    x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height ' +
          '  } ' +
          '} | ConvertTo-Json -Compress',
        ],
        psOpts({ timeout: PS_TIMEOUT_MS }),
      );
      const raw = JSON.parse(stdout.trim() || '[]');
      const arr: any[] = Array.isArray(raw) ? raw : [raw];
      // Physical pixel dimensions: we can only confidently compute these for
      // the primary display (via our cached ScreenSize). For secondaries we
      // assume the same dpiRatio — accurate on homogeneous setups, a safe
      // approximation on mixed-DPI (caller can override per-monitor later).
      const size = await this.getScreenSize();
      return arr.map((s: any, i: number) => {
        const w = Number(s.w) || 0;
        const h = Number(s.h) || 0;
        return {
          index: i,
          label: String(s.name || `Display ${i + 1}`),
          primary: !!s.primary,
          bounds: { x: Number(s.x) || 0, y: Number(s.y) || 0, width: w, height: h },
          physicalSize: {
            width: Math.round(w * size.dpiRatio),
            height: Math.round(h * size.dpiRatio),
          },
          dpiRatio: size.dpiRatio,
        };
      });
    } catch {
      // Fallback to single display so callers don't have to special-case.
      const size = await this.getScreenSize();
      return [{
        index: 0,
        label: 'Display 1',
        primary: true,
        bounds: { x: 0, y: 0, width: size.logicalWidth, height: size.logicalHeight },
        physicalSize: { width: size.physicalWidth, height: size.physicalHeight },
        dpiRatio: size.dpiRatio,
      }];
    }
  }

  async screenshot(opts?: { maxWidth?: number; displayIndex?: number; region?: { x: number; y: number; width: number; height: number } }): Promise<ScreenshotResult> {
    // A region, or any display other than the primary: nut-js can only grab
    // the PRIMARY display, so capture through the bridge (per-monitor-v2,
    // physical pixels — any monitor, any position, any scaling).
    let rect = opts?.region ?? null;
    if (!rect && opts?.displayIndex !== undefined) {
      const target = (await this.listDisplays()).find(d => d.index === opts.displayIndex);
      if (target && !target.primary) rect = target.bounds;
    }
    if (rect) {
      const r = await psRunner.run({ cmd: 'capture-rect', x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }) as { success?: boolean; png?: string; width: number; height: number };
      if (!r?.success || !r.png) throw new Error('screenshot: capturing that area failed');
      let pipe = sharp(Buffer.from(r.png, 'base64'));
      let width = r.width, height = r.height, scaleFactor = 1;
      const fit = opts?.maxWidth ? llmSize(r.width, r.height, opts.maxWidth) : null;
      if (fit && fit.scale > 1) {
        scaleFactor = fit.scale; width = fit.width; height = fit.height;
        pipe = pipe.resize(fit.width, fit.height, { fit: 'fill', kernel: 'lanczos3' });
      }
      return { buffer: await pipe.png().toBuffer(), width, height, scaleFactor, origin: { x: Math.round(rect.x), y: Math.round(rect.y) } };
    }
    const img = await screen.grab();
    let srcWidth = img.width;
    let srcHeight = img.height;
    // ReturnType<typeof sharp> instead of the `sharp.Sharp` namespace type:
    // sharp 0.35 reshaped its type exports and the default-import namespace
    // access (`sharp.Sharp`) stopped resolving. The instance type is exactly
    // what sharp() returns, so this is version-agnostic.
    let pipeline: ReturnType<typeof sharp>;

    pipeline = sharpFromGrab(img);

    let width = srcWidth;
    let height = srcHeight;
    let scaleFactor = 1;

    // maxWidth caps the LONG edge (and area) — see llmScale — so portrait
    // and 4:3 screens don't send images the provider shrinks again.
    const fit = opts?.maxWidth ? llmSize(srcWidth, srcHeight, opts.maxWidth) : null;
    if (fit && fit.scale > 1) {
      scaleFactor = fit.scale;
      pipeline = pipeline.resize(fit.width, fit.height, { fit: 'fill', kernel: 'lanczos3' });
      width = fit.width;
      height = fit.height;
    }

    const buffer = await pipeline.png().toBuffer();
    (img as any).data = null;

    return { buffer, width, height, scaleFactor };
  }

  async screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult> {
    const img = await screen.grab();
    const rx = Math.max(0, Math.min(x, img.width - 1));
    const ry = Math.max(0, Math.min(y, img.height - 1));
    const rw = Math.min(w, img.width - rx);
    const rh = Math.min(h, img.height - ry);

    const buffer = await sharpFromGrab(img)
      .extract({ left: rx, top: ry, width: rw, height: rh })
      .png()
      .toBuffer();
    (img as any).data = null;

    return { buffer, width: rw, height: rh, scaleFactor: 1 };
  }

  // ─── WINDOWS ──────────────────────────────────────────────────────

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const result = await psRunner.run({ cmd: 'get-screen-context', maxDepth: 0 }) as any;
      const raw = Array.isArray(result?.windows) ? result.windows : [];
      return raw.map(this.normalizeWindow).filter((w: WindowInfo) => !isOwnUiPid(w.processId));
    } catch {
      return [];
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const fg = await psRunner.run({ cmd: 'get-foreground-window' }) as any;
      if (!fg || fg.success === false) return null;

      // What only this answer carries: the window class, and the app's own display name.
      const extra = {
        ...(typeof fg.className === 'string' && fg.className ? { className: fg.className } : {}),
        ...(typeof fg.appName === 'string' && fg.appName ? { appName: fg.appName } : {}),
      };
      // The bridge answers with the focused window's own bounds / minimized
      // state: no need to enumerate every window (200+ ms) and, unlike the
      // first same-process match below, it IS the window that has focus.
      if (fg.bounds && Number(fg.bounds.width) > 0) {
        return {
          ...this.normalizeWindow({
            title: fg.title ?? '',
            processName: fg.processName ?? '',
            processId: fg.processId ?? 0,
            handle: fg.handle,
            bounds: fg.bounds,
            isMinimized: !!fg.isMinimized,
          }),
          ...extra,
        };
      }

      // Older bridge / no bounds: find the same window in the full list.
      const all = await this.listWindows();
      const match = all.find(w => w.processId === fg.processId);
      if (match) return { ...match, ...extra };

      return {
        ...this.normalizeWindow({
          title: fg.title ?? '',
          processName: fg.processName ?? '',
          processId: fg.processId ?? 0,
          handle: fg.handle,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          isMinimized: false,
        }),
        ...extra,
      };
    } catch {
      return null;
    }
  }

  /** Why the last focusWindow returned false. Taken once. */
  private focusFailure: string | null = null;
  takeFocusFailure(): string | null {
    const f = this.focusFailure;
    this.focusFailure = null;
    return f;
  }

  async focusWindow(query: { processName?: string; processId?: number; title?: string }): Promise<boolean> {
    // The PSRunner focus-window command takes title and/or processId. Look up by
    // processName first so callers can pass just that.
    this.focusFailure = null;
    let processId = query.processId;
    let title = query.title;

    if (processId === undefined && query.processName) {
      const target = query.processName.toLowerCase();
      const windows = await this.listWindows();
      const hit = windows.find(w => w.processName.toLowerCase() === target)
        ?? windows.find(w => w.processName.toLowerCase().includes(target));
      if (hit) processId = hit.processId;
      else if (title === undefined) {
        this.focusFailure = `No open window belongs to a process matching "${query.processName}".`;
        return false;
      }
    }

    try {
      const result = await psRunner.run({
        cmd: 'focus-window',
        restore: true,
        ...(title !== undefined ? { title } : {}),
        ...(processId !== undefined ? { processId } : {}),
      }) as any;
      // The PS script reports `success` (target window was found and SetFocus
      // was attempted) and `foreground` (Win32 SetForegroundWindow actually
      // promoted the window). We need foreground=true for subsequent keystroke
      // tools to land on the right app, so treat foreground=false as a focus
      // failure even if SetFocus succeeded. This is the difference between
      // "a11y-focused" and "will receive global SendInput keystrokes".
      if (result?.success !== true) {
        this.focusFailure = typeof result?.error === 'string' ? result.error : null;
        return false;
      }
      if (result?.foreground === false) {
        this.focusFailure = `Found "${result.title ?? title ?? ''}" but Windows did not bring it to the front, so keys would land elsewhere.`;
        return false;
      }
      const focusedPid = typeof result.processId === 'number' ? result.processId : processId;
      if (focusedPid !== undefined) {
        this.lastFocused = { processId: focusedPid, processName: query.processName, title: typeof result.title === 'string' ? result.title : title };
      }
      // The next default screenshot shows the monitor this window is on (a
      // launch lands here too, via foregroundLaunched).
      const b = result.bounds;
      if (b && b.width > 0 && b.height > 0) setWorkingPoint(b.x + b.width / 2, b.y + b.height / 2);
      return true;
    } catch (err) {
      this.focusFailure = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async maximizeWindow(): Promise<void> {
    // Win+Up is the portable Windows maximize shortcut.
    await this.keyPress('super+up').catch(() => { /* non-fatal */ });
  }

  async setWindowState(
    state: WindowState,
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    // Resolve the target: either the caller-supplied window or the
    // foreground one. We drive the transition through a single PowerShell
    // call that wraps Win32 ShowWindow / PostMessage so we don't depend
    // on focus timing of a key-press chord.
    let pid: number | undefined;
    let hwnd: number | undefined;

    if (query) {
      // The pid is written into the script below. A tool step (batch) can hand over any JSON, so anything but an integer is
      // refused rather than written there (GHSA-9ppf-38v8-h97v).
      if (query.processId !== undefined && !Number.isInteger(query.processId)) return false;
      // Prefer pid resolution when we can — cheaper than listWindows.
      pid = query.processId;
      if (pid === undefined) {
        const match = await this.resolveWindow(query);
        if (match) {
          pid = match.processId;
          const handle = (match as any).handle;
          if (typeof handle === 'number') hwnd = handle;
        }
      }

      // FAIL CLOSED. A caller that named a window and whose name matched
      // NOTHING used to fall through to GetForegroundWindow() below, so
      // `close` on a window that isn't open posted WM_CLOSE to whatever
      // happened to be in front — the user's unsaved document, or the
      // agent's own host. Asking for a specific window and silently getting
      // a different one is never the right answer; return false and let the
      // caller see it failed.
      const hadSelector =
        query.processId !== undefined ||
        (query.title !== undefined && query.title !== '') ||
        (query.processName !== undefined && query.processName !== '');
      if (hadSelector && pid === undefined && hwnd === undefined) return false;
    }

    const showCmd = state === 'maximize' ? 3       // SW_MAXIMIZE
      : state === 'minimize' ? 6                   // SW_MINIMIZE
      : state === 'normal'   ? 9                   // SW_RESTORE
      : null;

    const target = hwnd !== undefined
      ? `[IntPtr]${hwnd}`
      : pid !== undefined
        ? `(Get-Process -Id ${pid}).MainWindowHandle`
        : '[NativeMethods]::GetForegroundWindow()';

    try {
      if (state === 'close') {
        // WM_CLOSE — polite close request. App may prompt, we return true
        // when the message was posted, not when the window actually closed.
        const ps =
          // Single-quoted -MemberDefinition (not a here-string) — a here-string header
          // is illegal in a single-line `-Command` and fails to parse (see #153).
          "Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition '" +
          '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
          '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam);' +
          "' -PassThru | Out-Null;" +
          `$h = ${target};` +
          'if ($h -ne [System.IntPtr]::Zero) { [Win32.NativeMethods]::PostMessage($h, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null; "ok" } else { "no-window" }';
        const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-Command', ps], psOpts({ timeout: PS_TIMEOUT_MS }));
        return stdout.trim() === 'ok';
      }

      if (showCmd !== null) {
        // UWP windows hosted by ApplicationFrameHost ignore a cross-process
        // Win32 ShowWindow(SW_MINIMIZE) — it silently no-ops (#153: minimize
        // failed for Calculator/Settings while maximize/restore worked). Drive
        // the transition through the UIA WindowPattern (the supported
        // cross-process way, and what we already use for restore), which works
        // for UWP *and* Win32. Fall back to ShowWindowAsync (plus SW_FORCEMINIMIZE
        // for the minimize case) only if the pattern isn't available.
        const visualState = state === 'maximize' ? 'Maximized'
          : state === 'minimize' ? 'Minimized'
          : 'Normal';
        const forceMin = state === 'minimize'
          ? ' [Win32.NativeMethods]::ShowWindowAsync($nwh, 11) | Out-Null;'
          : '';
        const ps =
          // NB: a here-string header (@"...) is illegal in a single-line `-Command`
          // ("No characters are allowed after a here-string header before the end of
          // the line") — it fails to PARSE, so the whole script silently produced no
          // output and minimize returned false (#153). Use a PS single-quoted
          // -MemberDefinition instead: the C# double-quotes are literal inside it, and
          // Node handles the wire-escaping of those quotes for us.
          'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes | Out-Null;' +
          "Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition '" +
          '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
          '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);' +
          "' -PassThru | Out-Null;" +
          // [string]: an empty env var reads as $null, which is -ne "".
          '$title = [string]$env:CLAWD_PS_TITLE;' +
          `$h = ${target};` +
          '$el = $null;' +
          // Strategy A — find the top-level window by title via UIA. This is the
          // ONLY reliable handle for UWP / ApplicationFrameHost apps, whose
          // visible window is owned by ApplicationFrameHost (so pid→MainWindowHandle
          // is 0/wrong) and whose cross-process ShowWindow(SW_MINIMIZE) no-ops (#153).
          'if ($title -ne "") {' +
          '  $root = [System.Windows.Automation.AutomationElement]::RootElement;' +
          '  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window);' +
          '  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {' +
          '    $n = $w.Current.Name; if ($n -and $n.ToLower().Contains($title.ToLower())) { $el = $w; break }' +
          '  }' +
          '}' +
          // Strategy B — the caller-resolved handle. Strategy C — foreground.
          'if ($el -eq $null -and $h -ne [System.IntPtr]::Zero) { try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch {} }' +
          'if ($el -eq $null) { $fg = [Win32.NativeMethods]::GetForegroundWindow(); if ($fg -ne [System.IntPtr]::Zero) { try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($fg) } catch {} } }' +
          'if ($el -eq $null) { "no-window" } else {' +
          '  $ok = $false;' +
          `  try { $wp = $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::${visualState}); $ok = $true } catch { $ok = $false }` +
          '  if (-not $ok) { $nwh = [System.IntPtr]$el.Current.NativeWindowHandle; if ($nwh -ne [System.IntPtr]::Zero) {' +
          `    [Win32.NativeMethods]::ShowWindowAsync($nwh, ${showCmd}) | Out-Null;${forceMin}` +
          '    $ok = $true } }' +
          '  if ($ok) { "ok" } else { "no-window" } }';
        const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-Command', ps],
          psOpts({ timeout: PS_TIMEOUT_MS, env: { ...process.env, CLAWD_PS_TITLE: query?.title ?? '' } }));
        return stdout.trim() === 'ok';
      }

      return false;
    } catch {
      return false;
    }
  }

  async setWindowBounds(
    bounds: { x?: number; y?: number; width?: number; height?: number },
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean> {
    // SetWindowPos takes hwnd + x/y/w/h. Use SWP_NOZORDER to keep z-order.
    let hwnd: number | undefined;
    if (query) {
      const match = await this.resolveWindow(query);
      if (match && typeof (match as any).handle === 'number') hwnd = (match as any).handle;
      // FAIL CLOSED, like setWindowState: a named window that matched nothing
      // used to fall through to GetForegroundWindow() and resize whatever was
      // in front — live 2026-10, a resize aimed at a window that hadn't opened
      // yet moved the user's Notepad instead.
      const hadSelector =
        query.processId !== undefined ||
        (query.title !== undefined && query.title !== '') ||
        (query.processName !== undefined && query.processName !== '');
      if (hadSelector && hwnd === undefined) return false;
    }
    const handleExpr = hwnd !== undefined
      ? `[IntPtr]${hwnd}`
      : '[Win32.NativeMethods]::GetForegroundWindow()';

    try {
      // Callers pass SCREEN px — physical, the same units listWindows and the
      // a11y bounds report. SetWindowPos runs in the DPI-unaware PowerShell,
      // which takes logical px, so divide by the bridge ratio. (Passing
      // physical straight through made 1700x1060 fill a 225% screen.)
      await this.getScreenSize();
      const r = this.dpiRatio > 1 ? this.dpiRatio : 1;
      const toLogical = (v: number | undefined) => (v === undefined ? -1 : Math.round(v / r));
      const x = toLogical(bounds.x);
      const y = toLogical(bounds.y);
      const w = toLogical(bounds.width);
      const h = toLogical(bounds.height);
      // When a dim is -1, we read the current rect and preserve it.
      const ps =
        // Single-quoted -MemberDefinition (not a here-string) — a here-string header
        // is illegal in a single-line `-Command` and fails to parse (see #153).
        "Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition '" +
        '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
        '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out System.Drawing.Rectangle rect);' +
        '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndAfter, int X, int Y, int cx, int cy, uint uFlags);' +
        '[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hWnd);' +
        '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);' +
        "' -ReferencedAssemblies System.Drawing -PassThru | Out-Null;" +
        `$h = ${handleExpr};` +
        'if ($h -eq [System.IntPtr]::Zero) { "no-window"; exit }' +
        // A maximized window keeps its maximized state through SetWindowPos;
        // an explicit resize means "this size", so restore it first.
        'if ([Win32.NativeMethods]::IsZoomed($h)) { [Win32.NativeMethods]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 150 }' +
        '$r = New-Object System.Drawing.Rectangle;' +
        '[Win32.NativeMethods]::GetWindowRect($h, [ref] $r) | Out-Null;' +
        `$nx = ${x}; $ny = ${y}; $nw = ${w}; $nh = ${h};` +
        'if ($nx -lt 0) { $nx = $r.X }' +
        'if ($ny -lt 0) { $ny = $r.Y }' +
        'if ($nw -lt 0) { $nw = $r.Width - $r.X }' +
        'if ($nh -lt 0) { $nh = $r.Height - $r.Y }' +
        '[Win32.NativeMethods]::SetWindowPos($h, [System.IntPtr]::Zero, $nx, $ny, $nw, $nh, 0x0004) | Out-Null;' +
        '"ok"';
      const { stdout } = await execFileAsync(powershellExe(), ['-NoProfile', '-Command', ps], psOpts({ timeout: PS_TIMEOUT_MS }));
      return stdout.trim() === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Internal helper — resolve a focusWindow-style query to a single
   * WindowInfo. Same precedence the public `focusWindow` uses.
   */
  private async resolveWindow(query: { processName?: string; processId?: number; title?: string }): Promise<WindowInfo | null> {
    const windows = await this.listWindows();
    return windows.find(w => {
      if (query.processId !== undefined && w.processId === query.processId) return true;
      if (query.processName && w.processName.toLowerCase() === query.processName.toLowerCase()) return true;
      if (query.title && windowTextIncludes(w.title, query.title)) return true;
      return false;
    }) ?? null;
  }

  // ─── ACCESSIBILITY ────────────────────────────────────────────────

  async getUiTree(processId?: number): Promise<UiElement[]> {
    // Default to the foreground window's pid when the caller omits it — exactly
    // as findElements does below. Without this, get-screen-context is called
    // with focusedPid=0 and the bridge returns NO tree (Cmd-GetScreenContext
    // only walks a window when focusedPid>0), so read_screen over MCP came back
    // "(empty a11y tree)" for EVERY app — a regression once the pid-resolving
    // System-A read_screen was projected away in favor of this path.
    let pid = processId;
    if (pid === undefined) {
      const fg = await this.getActiveWindow().catch(() => null);
      if (fg?.processId) pid = fg.processId;
    }
    try {
      const result = await psRunner.run({
        cmd: 'get-screen-context',
        maxDepth: 8,
        ...(pid !== undefined ? { focusedProcessId: pid } : {}),
      }) as any;
      this.lastTreeTruncated = !!result?.truncated;
      const tree = result?.uiTree;
      if (!tree) return [];
      const nodes = Array.isArray(tree) ? tree : [tree];
      const flat: UiElement[] = [];
      for (const n of nodes) this.flattenTree(n, flat);
      // A rect on no monitor (a minimized window's -32000, a gap between monitors) is not a position: flag the
      // element offscreen instead, as the Linux adapter does. Both sides are physical virtual-desktop pixels —
      // so only the bridge's list will do: listDisplays' fallback is DPI-unaware (a 3840-wide primary reads 1707).
      const displays = await this.bridgeDisplays();
      if (displays.length) {
        for (const el of flat) {
          if (onAnyDisplay(displays, el.bounds)) continue;
          el.bounds = { x: 0, y: 0, width: 0, height: 0 };
          el.offscreen = true;
        }
      }
      return flat;
    } catch {
      return [];
    }
  }

  async findElements(query: { name?: string; controlType?: string; processId?: number }): Promise<UiElement[]> {
    // Default to the foreground window's pid when caller omits processId.
    // Without this, the PSBridge searches from the desktop root across ALL
    // windows and hits its 20-element cap before finding deep targets. The
    // foreground window is almost always the right scope for an unscoped
    // "find me X" query coming from the agent.
    // Fail closed on a control type the bridge cannot honor: forwarding it
    // would drop the filter and fuzzy-match names instead, returning a
    // confidently wrong element.
    const ct = normalizeControlType(query.controlType);
    if (ct === null) return [];

    // Scopes tried, in order. An unscoped query searches the LIVE foreground
    // window; if that is empty and clawdcursor itself focused a different
    // window moments ago (the MCP host can be foreground at call time), retry
    // once against that window. Recorded on `lastFindScope` so a miss can say
    // where it looked (live 2026-10: "(no elements found)" right after a
    // successful `window focus`, found fine with an explicit processId).
    const scopes: NonNullable<PlatformAdapter['lastFindScope']> = [];
    if (query.processId !== undefined) {
      scopes.push({ processId: query.processId });
    } else {
      const fg = await this.getActiveWindow();
      if (fg?.processId) scopes.push({ processId: fg.processId, processName: fg.processName, title: fg.title });
      if (this.lastFocused && this.lastFocused.processId !== fg?.processId) scopes.push(this.lastFocused);
    }
    if (scopes.length === 0) scopes.push({});
    this.lastFindScope = scopes;
    this.lastFindError = null;

    for (const scope of scopes) {
      try {
        const result = await psRunner.run({
          cmd: 'find-element',
          ...(query.name !== undefined ? { name: query.name } : {}),
          ...(ct !== undefined ? { controlType: ct } : {}),
          ...(scope.processId !== undefined ? { processId: scope.processId } : {}),
        }) as any;
        const raw = Array.isArray(result) ? result : [];
        if (raw.length > 0) return raw.map(this.normalizeElement);
      } catch (err) {
        this.lastFindError = /timeout/i.test(String((err as Error)?.message ?? err)) ? 'timeout' : 'error';
        return [];
      }
    }
    return [];
  }

  async getFocusedElement(): Promise<UiElement | null> {
    try {
      const result = await psRunner.run({ cmd: 'get-focused-element' }) as any;
      if (!result || result.success === false) return null;
      return this.normalizeElement(result);
    } catch {
      return null;
    }
  }

  /** The foreground window's document text through UIA TextPattern — no keystrokes, no selection, no clipboard. */
  async getPageText(): Promise<{ text: string; name?: string } | null> {
    try {
      const result = await psRunner.run({ cmd: 'get-page-text' }) as any;
      if (!result || result.success === false || typeof result.text !== 'string') return null;
      return { text: result.text, name: typeof result.name === 'string' ? result.name : undefined };
    } catch {
      return null;
    }
  }

  async invokeElement(query: {
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
    // The underlying PS bridge requires a processId for invoke-element.
    // Resolution order when caller omits processId:
    //   1. Foreground window (the agent's usual implicit scope).
    //   2. Fall back to find-element scan if the foreground window has no match.
    // Without this, find-element ran from the desktop root and could miss
    // deeply-nested targets due to the PSBridge 20-result cap.
    // Same controlType contract as findElements: bare name for the bridge,
    // fail closed on one it cannot honor (a raw "ControlType.Button" silently
    // dropped the role filter — live 2026-10).
    const ct = normalizeControlType(query.controlType);
    if (ct === null) return { success: false };

    let processId = query.processId;
    if (processId === undefined && query.name) {
      const fg = await this.getActiveWindow();
      if (fg?.processId) {
        processId = fg.processId;
      } else {
        const candidates = await this.findElements({
          name: query.name,
          controlType: ct,
        });
        if (candidates.length === 0) return { success: false };
        processId = (candidates[0] as any).processId
          ?? (candidates[0] as any).pid;
        // If still no pid but we have bounds, caller can fall back to a coord click.
        if (processId === undefined) {
          return {
            success: false,
            bounds: candidates[0].bounds,
          };
        }
      }
    }

    if (processId === undefined) return { success: false };

    try {
      const result = await psRunner.run({
        cmd: 'invoke-element',
        processId,
        action: query.action ?? 'click',
        ...(query.name !== undefined ? { name: query.name } : {}),
        ...(ct !== undefined ? { controlType: ct } : {}),
        ...(query.value !== undefined ? { value: query.value } : {}),
      }) as any;
      return {
        success: result?.success === true,
        // On a "found but no invoke/toggle/select pattern" miss the bridge
        // hands back the element's rect (and its centre as clickPoint) so the
        // caller can coordinate-fallback; dropping it made invoke miss an
        // element `find` could see (live 2026-10).
        bounds: result?.bounds
          ?? (result?.clickPoint ? { x: result.clickPoint.x, y: result.clickPoint.y, width: 1, height: 1 } : undefined),
        // The bridge returns get-value's payload at the TOP level
        // ({success, action, value, method}), not nested under .data — but
        // every consumer reads res.data?.value. Surface it so a11y_get_value /
        // element_value_contains actually see the value (review 2026-06-11).
        // The miss's reason and a late failure of an earlier invoke ride in data too: the tools read res.data.error /
        // res.data.lateInvokeError to tell the agent WHY, instead of "not found or not actionable".
        data: (result?.data || result?.value !== undefined || result?.error || result?.reason || result?.lateInvokeError || result?.unverified === true) ? {
          ...(result?.data ?? {}),
          // The miss's machine-readable reason and its screen-derived values, as fields (see core/miss-text.ts).
          ...structuredMissFields(result),
          // `method` tells a real value from the bridge's last resort (get-value "Name": the element's own name).
          ...(result?.value !== undefined && !result?.data ? { value: result.value, method: result.method } : {}),
          ...(typeof result?.error === 'string' ? { error: result.error } : {}),
          ...(typeof result?.lateInvokeError === 'string' ? { lateInvokeError: result.lateInvokeError } : {}),
          // A keyboard set-value that typed into the right window but could not read the field back.
          ...(result?.unverified === true ? { unverified: true } : {}),
        } : undefined,
      };
    } catch {
      return { success: false };
    }
  }

  /** UIA ScrollItemPattern.ScrollIntoView (else SetFocus) on the element — see ps-bridge.ps1 `scroll-into-view`. */
  async scrollIntoView(query: {
    name?: string;
    processId?: number;
    windowHandle?: number | string;
    bounds?: { x: number; y: number; width: number; height: number };
  }): Promise<{
    success: boolean;
    method?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    name?: string;
    role?: string;
    error?: string;
  }> {
    const processId = query.processId ?? (await this.getActiveWindow().catch(() => null))?.processId;
    if (processId === undefined) return { success: false, error: 'no window to scroll in' };
    try {
      const result = await psRunner.run({
        cmd: 'scroll-into-view',
        processId,
        ...(query.windowHandle !== undefined ? { handle: Number(query.windowHandle) } : {}),
        ...(query.name ? { name: query.name } : {}),
        ...(query.bounds ? { bounds: query.bounds } : {}),
      }) as any;
      const b = result?.bounds;
      return {
        success: result?.success === true,
        ...(typeof result?.method === 'string' ? { method: result.method } : {}),
        ...(typeof result?.name === 'string' ? { name: result.name } : {}),
        ...(typeof result?.role === 'string' ? { role: result.role } : {}),
        ...(b && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? { bounds: b } : {}),
        ...(typeof result?.error === 'string' ? { error: result.error } : {}),
      };
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? 'the scroll call failed' };
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
  // All coords are LOGICAL pixels — nut-js mouse API lives in that space on Win.

  /** Cursor cache for mouseMoveRelative — last known target. */
  private lastCursor: { x: number; y: number } | null = null;

  /**
   * Ensure the window at (x, y) is the foreground window before clicking.
   *
   * Problem: On Windows, nut-js sends mouse input via SendInput which
   * delivers to whatever window is topmost at those coordinates — not
   * necessarily the foreground window. When a Save As dialog sits over a
   * File Explorer window (or any background window), a click intended for
   * the dialog's filename field can land on the Explorer window if the
   * dialog's owning process lost foreground between the screenshot and the
   * click (race) or if the click coords are slightly outside the dialog rect
   * due to DPI-related rounding.
   *
   * Fix: use Win32 WindowFromPoint (via the warm psRunner bridge) to
   * identify the window at the target coords. If it is not the current
   * foreground window, call SetForegroundWindow to bring it forward before
   * the click lands. Non-fatal — if the PS call fails we proceed anyway.
   */
  /**
   * Put the pointer at a PHYSICAL virtual-desktop point — any monitor, any
   * position (negative origins included), any per-monitor scaling. The bridge
   * does it under per-monitor-v2 awareness. nut-js normalises absolute moves
   * to the PRIMARY display only, so it is just the fallback (primary only).
   */
  private async placeCursor(x: number, y: number): Promise<void> {
    const px = Math.round(x), py = Math.round(y);
    try {
      const r = await psRunner.run({ cmd: 'move-cursor', x: px, y: py }) as { success?: boolean };
      if (r?.success) { this.lastCursor = { x: px, y: py }; setWorkingPoint(px, py); return; }
    } catch { /* bridge unavailable — fall back below */ }
    const p = this.physicalToLogical(px, py);
    await mouse.setPosition(new Point(p.x, p.y));
    this.lastCursor = { x: px, y: py };
    setWorkingPoint(px, py);
  }

  private async ensureForegroundAtPoint(x: number, y: number): Promise<FocusActivation | undefined> {
    try {
      // physical: the point is a physical virtual-desktop pixel (any monitor).
      const r = await psRunner.run({ cmd: 'activate-at-point', x: Math.round(x), y: Math.round(y), physical: true }) as {
        activated?: boolean; reason?: string; title?: string; processName?: string; action?: string;
      };
      // 'noop' reasons mean nothing to promote (no window, or already foreground)
      // — both are fine, treat as activated.
      const activated = r?.activated !== false;
      return { activated, title: r?.title, processName: r?.processName, reason: r?.reason, action: r?.action };
    } catch {
      // Non-fatal — click proceeds regardless. We do not want to block
      // mouse input if the foreground check fails. Undefined = unknown.
      return undefined;
    }
  }

  private toNutButton(button?: MouseButton): Button {
    if (button === 'right') return Button.RIGHT;
    if (button === 'middle') return Button.MIDDLE;
    return Button.LEFT;
  }

  /**
   * Convert PHYSICAL pixel coords (a11y/OCR/screenshot space) to the LOGICAL
   * coords nut-js and WindowFromPoint expect on Windows. This process is
   * DPI-unaware, so the OS virtualises both the mouse driver and the bridge's
   * WindowFromPoint to logical (96-DPI) space; feeding physical coords lands
   * clicks dpiRatio× off AND makes activate-at-point resolve the wrong window
   * (foreground theft). No-op at ratio ≤ 1 (100% scale / detection fallback).
   */
  private physicalToLogical(x: number, y: number, ratio = this.mouseRatio): { x: number; y: number } {
    if (ratio <= 1) return { x, y };
    return { x: Math.round(x / ratio), y: Math.round(y / ratio) };
  }

  async mouseClick(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<FocusActivation | void> {
    await beforePointerPress(); // clawdcursor's own pill must not be under the click
    // Convert ONCE per space from the same physical point — the foreground
    // check (DPI-unaware bridge) and the cursor move (nut-js) must agree or
    // activate-at-point promotes a different window than the click lands on.
    // Bring the window at the target to the foreground before sending any
    // button events. Without this, a click intended for a Save As dialog
    // can land on a background Explorer window when the dialog lost focus
    // between the screenshot and the click (z-order / activation race).
    // The activation verdict flows back to the caller so a FAILED raise
    // (foreground-lock) is visible instead of a silent wrong-window click.
    // Both the foreground check and the move use the same PHYSICAL point.
    const activation = await this.ensureForegroundAtPoint(x, y);
    await this.placeCursor(x, y);
    await this.delay(40);
    const count = opts?.count ?? 1;
    const btn = this.toNutButton(opts?.button);

    for (let i = 0; i < count; i++) {
      if (btn === Button.RIGHT) await mouse.rightClick();
      else if (btn === Button.MIDDLE) {
        // nut-js has no direct middleClick helper; press+release.
        await mouse.pressButton(Button.MIDDLE);
        await this.delay(30);
        await mouse.releaseButton(Button.MIDDLE);
      } else {
        await mouse.click(Button.LEFT);
      }
      if (i < count - 1) await this.delay(60);
    }
    return activation;
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.placeCursor(x, y);
  }

  async mouseMoveRelative(rawDx: number, rawDy: number): Promise<void> {
    // dx/dy arrive in PHYSICAL px like absolute coords (the MCP surface scales
    // image deltas by the mouse factor), but getPosition()/setPosition() live
    // in the driver's space — divide by the same ratio as absolute moves, or a
    // 100-px move overshoots to 225 px on a 225% display.
    // Physical path first (any monitor): read the cursor in physical px, add
    // the physical deltas, place it.
    try {
      const cur = await psRunner.run({ cmd: 'get-cursor' }) as { success?: boolean; x: number; y: number };
      if (cur?.success) { await this.placeCursor(cur.x + rawDx, cur.y + rawDy); return; }
    } catch { /* fall back to the driver-space path below */ }
    const dx = rawDx / this.mouseRatio;
    const dy = rawDy / this.mouseRatio;
    // nut-js `getPosition()` works reliably on Windows — prefer that over
    // the cache. Fall back to the cache if the query fails.
    // (lastCursor is PHYSICAL — set by placeCursor.)
    try {
      const pos = await mouse.getPosition();
      const nx = Math.round(pos.x + dx);
      const ny = Math.round(pos.y + dy);
      await mouse.setPosition(new Point(nx, ny));
      this.lastCursor = { x: Math.round(nx * this.mouseRatio), y: Math.round(ny * this.mouseRatio) };
    } catch {
      if (this.lastCursor) {
        const p = this.physicalToLogical(this.lastCursor.x + rawDx, this.lastCursor.y + rawDy);
        await mouse.setPosition(new Point(p.x, p.y));
        this.lastCursor = { x: Math.round(this.lastCursor.x + rawDx), y: Math.round(this.lastCursor.y + rawDy) };
      }
    }
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await beforePointerPress(); // clawdcursor's own pill must not be under the click
    // Interpolate in PHYSICAL space so every waypoint is exact on any monitor.
    const a = { x: x1, y: y1 };
    const b = { x: x2, y: y2 };
    await this.placeCursor(a.x, a.y);
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(80);
    const steps = Math.max(8, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 18));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.placeCursor(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      await this.delay(10);
    }
    await mouse.releaseButton(Button.LEFT);
  }

  async mouseScroll(x: number, y: number, direction: ScrollDirection, amount: number = 3): Promise<void> {
    await beforePointerPress(); // clawdcursor's own pill must not be under the click
    await this.placeCursor(x, y);
    await this.delay(30);
    // nut-js only exposes scrollUp/scrollDown natively. For horizontal,
    // fall back to Shift+scroll which most apps interpret as horizontal.
    if (direction === 'down') await mouse.scrollDown(amount * wheelUnitsPerNotch());
    else if (direction === 'up') await mouse.scrollUp(amount * wheelUnitsPerNotch());
    else {
      // Horizontal: hold Shift, scroll vertically.
      await keyboard.pressKey(Key.LeftShift);
      try {
        if (direction === 'left') await mouse.scrollUp(amount * wheelUnitsPerNotch());
        else await mouse.scrollDown(amount * wheelUnitsPerNotch());
      } finally {
        await keyboard.releaseKey(Key.LeftShift);
      }
    }
  }

  async mouseDown(button?: MouseButton): Promise<void> {
    await beforePointerPress(); // clawdcursor's own pill must not be under the click
    await mouse.pressButton(this.toNutButton(button));
  }

  async mouseUp(button?: MouseButton): Promise<void> {
    await mouse.releaseButton(this.toNutButton(button));
  }

  // ─── INPUT (keyboard) ─────────────────────────────────────────────

  async typeText(text: string): Promise<void> {
    if (!text) return;
    await keyboard.type(text);
  }

  async keyPress(combo: PortableKeyCombo): Promise<void> {
    if (!combo) return;

    // Literal "+" — can't split on "+" since it IS the separator.
    if (combo === '+') {
      await keyboard.type('+');
      return;
    }

    const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;

    // Convert "mod" → "ctrl" on Windows, leave the rest of the combo alone.
    const normalized = parts.map(p => {
      const l = p.toLowerCase();
      if (l === 'mod' || l === 'cmd' || l === 'command' || l === 'meta') return 'ctrl';
      return p;
    });

    // Map every part to a nut-js Key enum value, or 'TYPE_CHAR' for printable chars
    // like '*', '+', '.' that have no direct enum entry.
    const mapped: Array<Key | 'TYPE_CHAR'> = normalized.map(p => this.mapKey(p));

    // Single-key: either type it as a character or press+release the mapped key.
    if (mapped.length === 1) {
      if (mapped[0] === 'TYPE_CHAR') {
        await keyboard.type(normalized[0]);
      } else {
        await keyboard.pressKey(mapped[0] as Key);
        await this.delay(30);
        await keyboard.releaseKey(mapped[0] as Key);
      }
      return;
    }

    // Combo: press each modifier (or type the printable char), then release in reverse.
    for (let i = 0; i < mapped.length; i++) {
      const k = mapped[i];
      if (k === 'TYPE_CHAR') {
        await keyboard.type(normalized[i]);
      } else {
        await keyboard.pressKey(k as Key);
      }
      await this.delay(30);
    }
    for (let i = mapped.length - 1; i >= 0; i--) {
      const k = mapped[i];
      if (k !== 'TYPE_CHAR') {
        await keyboard.releaseKey(k as Key);
      }
      await this.delay(30);
    }
  }

  async keyDown(key: PortableKeyCombo): Promise<void> {
    const mapped = this.mapKey(key);
    if (mapped === 'TYPE_CHAR') {
      // Single printable char without modifier semantics — treat as type.
      await keyboard.type(key);
      return;
    }
    await keyboard.pressKey(mapped as Key);
  }

  async keyUp(key: PortableKeyCombo): Promise<void> {
    const mapped = this.mapKey(key);
    if (mapped === 'TYPE_CHAR') return; // no-op — typing isn't held
    await keyboard.releaseKey(mapped as Key);
  }

  // ─── CLIPBOARD ────────────────────────────────────────────────────

  async readClipboard(): Promise<string> {
    try {
      // PowerShell writes stdout in the console's legacy codepage, so any
      // non-ASCII text (é, —, ✓, CJK, emoji) came back as '?'. Return the
      // clipboard as base64-encoded UTF-8 instead — survives any codepage.
      const { stdout } = await execFileAsync(
        powershellExe(),
        ['-NoProfile', '-Command',
          '$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = "" }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))'],
        psOpts({ timeout: CLIPBOARD_TIMEOUT_MS }),
      );
      return Buffer.from((stdout ?? '').trim(), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    try {
      await setWindowsClipboard(text, CLIPBOARD_TIMEOUT_MS);
    } catch {
      // Silent — clipboard is best-effort (same contract as macOS adapter).
    }
  }

  // ─── APPS ─────────────────────────────────────────────────────────

  /**
   * Thin shim — delegates straight to `launchApp` with no alias resolution.
   * The platform layer is alias-data-agnostic; alias resolution lives in
   * the caller (the agent's `open_app` tool, the router's `handleOpenApp`).
   * Callers that want UWP / executable / searchTerm hints must pass them
   * via `launchApp` directly.
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
      /**
       * UWP AppsFolder ID, e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`.
       * Launches via `explorer.exe shell:AppsFolder\<id>` which works for
       * Store / UWP apps where `Start-Process -FilePath <exe>` silently fails.
       * Takes precedence over `name` when provided.
       */
      uwpAppId?: string;
      /**
       * Human-friendly term for the Start-Menu-search fallback. See the
       * `PlatformAdapter` interface doc for why this matters — typing the
       * binary name in Start Menu can surface the wrong app.
       */
      searchTerm?: string;
      /** Skip the Start-Menu search fallback; return {} if no window surfaces. */
      noStartMenuFallback?: boolean;
      /** An agent-typed name: start only an installed app (PlatformAdapter.launchApp). */
      nameOnly?: boolean;
      /** The app's known process names (PlatformAdapter.launchApp). */
      processNames?: readonly string[];
      /** `name` only starts something else (PlatformAdapter.launchApp). */
      viaLauncher?: boolean;
    },
  ): Promise<LaunchResult> {
    // Reject control chars / backticks / $() that can escape PowerShell quoting
    // regardless of how we serialize.
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars that could escape PowerShell quoting
    if (/[\r\n\t\x00-\x1f]/.test(name) || /[`$]/.test(name)) {
      throw new Error('launchApp: illegal characters in app name');
    }

    // A known app's process counts as "started by this launch" only if it began after this point (small slack for
    // clock granularity): browsers and Office keep background processes that prove nothing.
    const launchedAt = Date.now() - 2_000;

    // Snapshot existing windows ONCE before any spawn so the diff-and-poll
    // helper can ignore them. Reused by the idempotency check below.
    // Bounded: an empty before-set (everything looks "new", and an app already up is launched again) is better
    // than a launch that waits on a stuck read. Identity still decides which window is the app's.
    const snapshot = await within(this.launchWindows(), LAUNCH_SNAPSHOT_MS);
    const windowsBefore: readonly WindowInfo[] = snapshot === TIMED_OUT || snapshot === null ? [] : snapshot;

    // v0.8.3 — idempotency: if the app is already running AND caller didn't
    // ask for a fresh instance, FOCUS the existing window instead of spawning
    // another. This closes the "Outlook keeps opening" bug: a retry loop that
    // launches Outlook every iteration used to spawn a new instance each time
    // (Start-Process -FilePath outlook with Outlook already running launches
    // a fresh window).
    // Which windows are this app's: by identity (app-identity.ts), never by what a title happens to contain.
    let app = this.appWindows(appIdentity(name, {
      processNames: opts?.processNames, displayName: opts?.searchTerm, uwpAppId: opts?.uwpAppId, viaLauncher: opts?.viaLauncher,
    }));
    const focusExisting = async (): Promise<LaunchResult | null> => {
      if (opts?.alwaysNewInstance || opts?.url) return null;
      const existing = await app.findIn(windowsBefore);
      if (!existing) return null;
      // Focus it so it surfaces like a launch would, then return its identity.
      await this.focusWindow({ processId: existing.processId }).catch(() => {});
      return { pid: existing.processId, title: existing.title, handle: existing.handle };
    };
    const running = await focusExisting();
    if (running) return running;

    // Name-only launch (an agent-typed name outside the alias table): resolve it to an installed app first, read-only
    // (win-app-resolve.ts), and start exactly that. The raw name never reaches Start-Process, where the shell would read
    // `scheme:` as a URI, and is never typed into the Start menu, whose best match can be a file.
    if (opts?.nameOnly) {
      const found = await resolveInstalledWindowsApp(name);
      if (!found) return {};
      // Now the app itself is known — its program, or its package — and so are its windows, whatever its process is called.
      app = this.appWindows(appIdentity(name, {
        processNames: [found.path, found.target].filter((p): p is string => !!p),
        displayName: found.name,
        uwpAppId: found.appId?.includes('!') ? found.appId : undefined,
      }));
      const alreadyUp = await focusExisting();
      if (alreadyUp) return alreadyUp;
      let started: boolean | undefined;
      if (found.path) {
        started = await this.startProcess({ ...process.env, CLAWD_PS_FILE: found.path },
          'Start-Process -FilePath $env:CLAWD_PS_FILE -WorkingDirectory $env:USERPROFILE');
      } else {
        // explorer's exit status says nothing about the app it activates: only a spawn that could not happen is known.
        try {
          spawn(windowsDirExe('explorer.exe'), [`shell:AppsFolder\\${found.appId}`], { stdio: 'ignore', detached: true, windowsHide: true, cwd: os.homedir() }).unref();
        } catch {
          started = false;
        }
      }
      // A launch Windows refused is a failure, said as one — never "started" on the strength of a process that was
      // already there (a tray app).
      if (started === false) throw new Error(`launchApp: Windows could not start "${name}"${found.path ? ` (${found.path})` : ''}`);
      // Name-only: only a process begun by THIS launch counts — the name was typed by an agent, and a process that was
      // already there (a tray app) says nothing about what this launch did.
      return this.foregroundLaunched(await this.findLaunchedWindow(app, windowsBefore, 8_000, { since: launchedAt }));
    }

    // Route 1: UWP apps via explorer shell:AppsFolder\<id>. This is the Windows-
    // sanctioned way to launch UWP / Store apps and is rock-solid — Calculator,
    // Notepad-Win11, Photos, etc. all work.
    if (opts?.uwpAppId) {
      const id = opts.uwpAppId;
      // App ID format is `<PackageFamily>_<Hash>!<AppId>`. Valid characters are
      // alphanumerics, dots, underscores, hyphens, and a single `!`. Reject anything
      // else to keep the shell: path from interpreting metacharacters.
      if (!/^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(id)) {
        throw new Error(`launchApp: illegal uwpAppId "${id}"`);
      }
      try {
        const child = spawn(windowsDirExe('explorer.exe'), [`shell:AppsFolder\\${id}`], {
          stdio: 'ignore', detached: true, windowsHide: true, cwd: os.homedir(),
        });
        child.unref();
      } catch {
        // Non-fatal — continue and look for the window anyway.
      }
      // Shorter primary budget so we have headroom for the Start-Menu
      // fallback if shell:AppsFolder didn't surface a window — matches
      // the router's strategy ladder.
      const uwpResult = await this.findLaunchedWindow(app, windowsBefore, 4_000, { since: launchedAt });
      // Its process is up and the window is not (a slow starter): started. Searching the Start menu would launch it twice.
      if (uwpResult.title || uwpResult.pid) return this.foregroundLaunched(uwpResult);
      if (opts?.noStartMenuFallback) return uwpResult; // {} — caller verifies
      return this.foregroundLaunched(await this.launchViaStartMenuSearch(name, opts?.searchTerm, windowsBefore, app));
    }

    // Route 2: classic Start-Process via PowerShell; the values arrive as $env:, never as script source (ps-input.ts).
    const env: NodeJS.ProcessEnv = { ...process.env, CLAWD_PS_FILE: name };
    const cmdParts: string[] = ['Start-Process', '-FilePath', '$env:CLAWD_PS_FILE'];
    if (opts?.url) {
      // The target reaches PowerShell as $env: data, never as script text, so `'`, `$` and a backtick are ordinary
      // characters of a path ("Sam's notes.txt", "C:\$Recycle.Bin"). Only what could split the argument is refused —
      // and refused out loud: the target used to be dropped silently, and the bare launcher opened instead.
      // eslint-disable-next-line no-control-regex -- intentional: control characters never belong in a path or a URL
      if (/[\x00-\x1f"]/.test(opts.url)) {
        throw new Error('launchApp: the path or URL to open contains a double quote or a control character, which cannot be passed to a Windows program');
      }
      // A drive or UNC path goes out with backslashes: explorer.exe reads "/" as the start of a switch, so
      // `explorer C:/Windows/System32/calc.exe` opens the Documents folder and never starts the program.
      env.CLAWD_PS_ARGS = startProcessArgument(opts.url);
      cmdParts.push('-ArgumentList', '$env:CLAWD_PS_ARGS');
    }
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars that could escape PowerShell quoting
    if (opts?.cwd && !/[\r\n\t\x00-\x1f"'`$]/.test(opts.cwd)) {
      env.CLAWD_PS_CWD = opts.cwd;
      cmdParts.push('-WorkingDirectory', '$env:CLAWD_PS_CWD');
    } else {
      // An app opened for the user starts in their home, not in clawdcursor's private directory (where this PowerShell runs).
      cmdParts.push('-WorkingDirectory', '$env:USERPROFILE');
    }

    // Not awaited here: the window poll starts at once. Whether Start-Process succeeded is read after it.
    const started = this.startProcess(env, cmdParts.join(' '));

    // Try the primary Start-Process result with a shorter budget so we have
    // time for the Start-Menu fallback if it returns empty. Edge / VS Code /
    // any binary not on PATH but Start-Menu-indexed will recover here.
    // Started through a launcher, and what it starts is unknown (a document's program): there is no window to claim.
    if (opts?.viaLauncher && app.identity.processNames.size === 0) return {};
    // Through a launcher (open_file), the Start-Process that succeeded is explorer.exe's: it says nothing about the
    // file. Only a process begun by this launch counts there — never an older one of the same name.
    const direct = await this.findLaunchedWindow(app, windowsBefore, 4_000, { since: launchedAt, started: opts?.viaLauncher ? undefined : started });
    if (direct.title || direct.pid) return this.foregroundLaunched(direct);
    if (opts?.noStartMenuFallback || opts?.viaLauncher) return direct; // {} — caller verifies (open_file)

    // Route 3: Start Menu search fallback — universal for any app indexed by
    // Windows. Press the Win key, type the app name, press Enter. This is
    // the same pattern the router's zero-LLM fast path uses; ported here so
    // every caller of launchApp (agent's open_app, MCP, REST) gets the
    // reliability without duplicating router logic.
    return this.foregroundLaunched(await this.launchViaStartMenuSearch(name, opts?.searchTerm, windowsBefore, app));
  }

  /**
   * Bring a freshly-launched window to the foreground. A detached spawn opens
   * the app BEHIND the current foreground (Windows foreground-lock), so without
   * this `open_app("calc")` left Calculator in the background and every
   * subsequent focused-window op (read_screen, find_element) targeted the wrong
   * window. The idempotency path already focuses; this gives fresh launches the
   * same contract. Best-effort — never throws, the launch already succeeded.
   */
  private async foregroundLaunched(result: LaunchResult): Promise<LaunchResult> {
    // Only a window can be brought forward: a process that has shown none yet is left to start.
    if (result?.pid && result.title) {
      await this.focusWindow({ processId: result.pid, title: result.title }).catch(() => {});
    }
    return result;
  }

  /**
   * Last-resort launch via Windows' own Start Menu search. Works for any
   * app the user can find by name in the Start Menu (apps, settings panes,
   * UWP without a known AppsFolder ID, third-party Win32 binaries with an
   * App Paths entry). The keyboard primitives we use here go through the
   * adapter directly — this is internal platform logic, not an agent action.
   *
   * Tuned to the same cadence as the router's startMenuSearch helper.
   */
  private async launchViaStartMenuSearch(
    name: string,
    searchTermHint: string | undefined,
    windowsBefore: readonly WindowInfo[],
    app: AppWindows,
  ): Promise<LaunchResult> {
    // Pick the term Windows Search will actually rank correctly. The alias's
    // `searchTerm` (when provided) is the human-friendly name an end user
    // would type — "Edge", "VS Code", "File Explorer". For names without an
    // alias, fall back to stripping the file-system suffix off `name`:
    // `msedge.exe` → `msedge`, `notepad.exe` → `notepad`, etc. Without this
    // distinction, typing the binary name in Start Menu can surface the
    // wrong app (e.g. "msedge" → Microsoft Store as the closest match).
    const searchText = (searchTermHint && searchTermHint.trim())
      ? searchTermHint.trim()
      : name.replace(/\.(exe|com)$/i, '');

    try {
      // Close any in-progress Start Menu / search overlay so the Win key
      // reliably opens a fresh one.
      await this.keyPress('Escape').catch(() => {});
      await this.delay(120);
      await this.keyPress('Super');
      await this.delay(600);
      await this.typeText(searchText);
      await this.delay(700);
      await this.keyPress('Return');
    } catch {
      // Keyboard layer flaky — caller will see empty result and decide.
    }

    // Whatever the search opened, only a window of THIS app is reported: the top hit can be another app or a document.
    return this.findLaunchedWindow(app, windowsBefore, 4_000, { since: Date.now() - 2_000 });
  }

  /**
   * After a launch, wait for the new window to surface. Uses the shared
   * `waitForLaunchedWindow` diff-and-poll helper so the budget is spent
   * doing useful work (polling every 300ms) rather than a single fixed
   * settle. Returns `{}` when the deadline elapses with no match — caller
   * can interpret that as a real "this strategy didn't work" signal and
   * try the next strategy.
   *
   * On Windows, neither the UWP shell:AppsFolder spawn nor the classic
   * Start-Process spawn returns the eventual app's PID (we spawn explorer /
   * powershell, not the target binary), so we don't pass `spawnPid`: the
   * window is the app's by identity (`appWindows`), or none is reported.
   *
   * No window within the budget is not yet "not launched": a slow starter (a CAD suite, an IDE) has its process up
   * long before its window. Then the process is the answer — `{ pid, processName }`, no title — when it is this
   * launch's: it began at or after `launch.since`, or Start-Process is known to have succeeded (`launch.started`:
   * a single-instance app hands the launch to the process already there). A launch known to have FAILED claims
   * nothing, whatever else is running under that name.
   *
   * Bounded: the window reads are Win32 only and each is cut off at the budget (launch-poll.ts); the process
   * lookup is its own short-lived PowerShell (win-processes.ts), so a stuck accessibility read cannot delay it or
   * lose its answer.
   */
  private async findLaunchedWindow(
    app: AppWindows,
    windowsBefore: readonly WindowInfo[],
    timeoutMs?: number,
    launch?: { since?: number; started?: boolean | Promise<boolean | undefined> },
  ): Promise<LaunchResult> {
    const win = await waitForLaunchedWindow(
      windowsBefore,
      async () => {
        const windows = await this.launchWindows();
        await app.learn(windows);
        return windows;
      },
      app.owns,
      timeoutMs ? { timeoutMs } : undefined,
    );
    if (win) return { pid: win.processId, title: win.title, handle: win.handle };
    const started = await launch?.started;
    if (started === false) return {};
    const procs = (await findWindowsProcesses([...app.identity.processNames]))
      .filter(p => !isOwnUiPid(p.pid))
      .sort((x, y) => y.started - x.started);
    const begun = procs.find(p => launch?.since === undefined || p.started >= launch.since);
    if (begun) return { pid: begun.pid, processName: begun.processName };
    // Start-Process succeeded and only an older process exists: the app handed the launch to it. Running, not started.
    return started === true && procs[0] ? { pid: procs[0].pid, processName: procs[0].processName, alreadyRunning: true } : {};
  }

  /**
   * Start-Process in a detached PowerShell (values as $env:, never as script text). Resolves true / false with
   * PowerShell's exit status — Start-Process returns as soon as the program is started, and fails when Windows
   * cannot find or run it — or undefined when that is not known within a few seconds.
   */
  private startProcess(env: NodeJS.ProcessEnv, command: string): Promise<boolean | undefined> {
    return new Promise(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(powershellExe(), ['-NoProfile', '-Command', command], psOpts({ stdio: 'ignore' as const, detached: true, windowsHide: true, env }));
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => resolve(undefined), 5_000);
      child.on('exit', (code: number | null) => { clearTimeout(timer); resolve(code === 0); });
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.unref();
    });
  }

  /**
   * The window list a launch works from: the bridge's Win32-only read (`list-windows`), not the UI Automation
   * one. listWindows() asks every window's UIA provider, and an app that is starting does not answer: the read
   * blocks until the bridge's 20 s call timeout (live: an 8 s launch wait took 39 s). It also names the app a UWP
   * frame window hosts. A bridge that does not know the command (or a test double) falls back to listWindows();
   * a bridge that failed gives no windows this time, rather than a UIA read queued onto a bridge already stuck.
   */
  private async launchWindows(): Promise<WindowInfo[]> {
    let reply: { windows?: unknown } | null;
    try {
      reply = await psRunner.run({ cmd: 'list-windows' }) as { windows?: unknown } | null;
    } catch {
      return [];
    }
    if (!Array.isArray(reply?.windows)) return this.listWindows();
    return reply.windows
      .map((raw: any): WindowInfo => ({
        ...this.normalizeWindow(raw),
        ...(typeof raw?.className === 'string' && raw.className ? { className: raw.className } : {}),
        ...(Number.isInteger(raw?.hostedProcessId) && raw.hostedProcessId > 0
          ? { hostedProcessId: raw.hostedProcessId, hostedProcessName: String(raw.hostedProcessName ?? '') } : {}),
      }))
      .filter(w => !isOwnUiPid(w.processId));
  }

  /**
   * The windows of one app, by identity (app-identity.ts): process name, package family, or the exact display-name
   * title of a window the UWP frame host owns. The package family needs each process's exe path, which the window
   * list does not carry: `learn` asks the bridge for the paths of the processes not yet recognised (once per pid).
   */
  private appWindows(identity: AppIdentity): AppWindows {
    const paths = new Map<number, string>();
    const owns = (w: WindowInfo): boolean => ownsWindow(identity, w, pid => paths.get(pid));
    const learn = async (windows: readonly WindowInfo[]): Promise<void> => {
      if (!identity.packageFamily) return;
      const pids = [...new Set(windows.filter(w => !owns(w)).flatMap(w => [w.processId, w.hostedProcessId ?? 0]))]
        .filter(pid => pid > 0 && !paths.has(pid));
      if (pids.length === 0) return;
      const reply = await psRunner.run({ cmd: 'get-process-paths', pids }).catch(() => null) as { paths?: Record<string, unknown> } | null;
      for (const pid of pids) {
        const p = reply?.paths?.[String(pid)];
        paths.set(pid, typeof p === 'string' ? p : '');
      }
    };
    const findIn = async (windows: readonly WindowInfo[]): Promise<WindowInfo | null> => {
      await learn(windows);
      return windows.find(owns) ?? null;
    };
    return { identity, owns, learn, findIn };
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  private normalizeWindow = (raw: any): WindowInfo => ({
    title: raw?.title ?? '',
    processName: raw?.processName ?? '',
    processId: raw?.processId ?? 0,
    bounds: raw?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    isMinimized: raw?.isMinimized ?? false,
    handle: raw?.handle ?? raw?.processId,
  });

  private normalizeElement = (raw: any): UiElement => {
    const enabled = raw?.isEnabled ?? raw?.enabled;
    return {
      name: raw?.name ?? '',
      controlType: (raw?.controlType ?? '').replace(/^ControlType\./, ''),
      bounds: raw?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      value: raw?.value,
      // A password field (UIA IsPassword): its value is withheld and must never be echoed.
      ...(raw?.secure === true ? { secure: true } : {}),
      enabled,
      focused: raw?.focused,
      // Tranche 1A: richer state fields from ps-bridge.
      selected: raw?.selected ?? raw?.isSelected,
      disabled: enabled === false ? true : undefined,
      busy: raw?.busy ?? raw?.isBusy,
      offscreen: raw?.offscreen ?? raw?.isOffscreen,
      expandable: raw?.expandable,
      expanded: raw?.expanded,
      automationId: raw?.automationId,
      processId: raw?.processId ?? raw?.pid,
      ...(raw?.toggleState === 'On' ? { checked: true }
        : raw?.toggleState === 'Off' ? { checked: false }
        : raw?.toggleState === 'Indeterminate' ? { checked: 'mixed' as const }
        // A radio's tick is its SelectionItem state (UIA radios have no TogglePattern), as on Linux and macOS.
        : /RadioButton$/.test(raw?.controlType ?? '') && typeof (raw?.selected ?? raw?.isSelected) === 'boolean'
          ? { checked: Boolean(raw?.selected ?? raw?.isSelected) } : {}),
    };
  };

  /**
   * Flatten the UIA tree into a single list, matching the macOS adapter's
   * contract. Drops purely structural unnamed nodes to keep the list useful.
   */
  private flattenTree(node: any, acc: UiElement[], depth = 0): void {
    if (!node) return;
    // ConvertTo-UINode may return an array of children when it skipped an
    // unnamed container — just recurse through those (same depth: the
    // container was flattened out).
    if (Array.isArray(node)) {
      for (const n of node) this.flattenTree(n, acc, depth);
      return;
    }
    if (node.controlType || node.name) acc.push({ ...this.normalizeElement(node), depth });
    if (Array.isArray(node.children)) {
      for (const child of node.children) this.flattenTree(child, acc, depth + 1);
    }
  }

  /**
   * Map a portable key token to the nut-js Key enum (or 'TYPE_CHAR' for
   * printable ASCII symbols that don't have a direct enum entry).
   */
  private mapKey(name: string): Key | 'TYPE_CHAR' {
    const direct = WIN_KEY_MAP[name] ?? WIN_KEY_MAP[name.toLowerCase()];
    if (direct !== undefined) return direct;

    if (name.length === 1) {
      const ch = name;
      const upper = ch.toUpperCase();
      // A-Z
      if (upper >= 'A' && upper <= 'Z') {
        const k = (Key as any)[upper];
        if (k !== undefined) return k as Key;
      }
      // 0-9 → nut-js uses Num1..Num9, Num0 for the top-row digits.
      if (upper >= '0' && upper <= '9') {
        const k = (Key as any)[`Num${upper}`];
        if (k !== undefined) return k as Key;
      }
      // Any other printable ASCII — ask keyboard.type() to handle it.
      if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126) return 'TYPE_CHAR';
    }

    // Last resort: direct enum name match (e.g. "F13", "NumPad5").
    const enumVal = (Key as any)[name];
    if (enumVal !== undefined) return enumVal as Key;

    // Spelled-out aliases ("minus", "plus", "comma", …) — same table
    // native-desktop uses; without it `ctrl+minus` threw here.
    const alias = normalizeKey(name);
    if (alias !== name) return this.mapKey(alias);

    throw new Error(`Unknown key: "${name}"`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

/** How long the before-launch window snapshot may take. */
const LAUNCH_SNAPSHOT_MS = 5_000;

/**
 * One argument for `Start-Process -ArgumentList`, which hands its string to the program's command line AS WRITTEN:
 * unquoted, "C:\My Docs\a b.pdf" reached Explorer as three arguments. A drive or UNC path goes out with
 * backslashes (explorer.exe reads "/" as the start of a switch, so `explorer C:/Windows/System32/calc.exe` opened
 * Documents and never started the program), without a trailing backslash (before the closing quote it would
 * escape it) and in double quotes. Anything else is quoted only when it contains white space. The caller has
 * already refused a value with a double quote in it.
 */
function startProcessArgument(value: string): string {
  const isPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(value);
  if (!isPath) return /\s/.test(value) ? `"${value.replace(/(\\+)$/, '$1$1')}"` : value;
  const p = value.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\+$/.test(p)) return `${p.slice(0, 2)}\\`;   // a drive root: "C:\", nothing to quote
  return `"${p.replace(/\\+$/, '')}"`;
}

type LaunchResult = { pid?: number; title?: string; handle?: number | string; processName?: string; alreadyRunning?: boolean };

/** One app's windows: see `WindowsAdapter.appWindows`. */
interface AppWindows {
  identity: AppIdentity;
  owns: (w: WindowInfo) => boolean;
  learn: (windows: readonly WindowInfo[]) => Promise<void>;
  findIn: (windows: readonly WindowInfo[]) => Promise<WindowInfo | null>;
}

// Portable-token → nut-js Key lookup. Lowercase keys are checked as a
// fallback so "Return"/"return", "Shift"/"shift", etc. all resolve.
const WIN_KEY_MAP: Record<string, Key> = {
  // Modifiers
  ctrl: Key.LeftControl, control: Key.LeftControl, Control: Key.LeftControl,
  shift: Key.LeftShift, Shift: Key.LeftShift,
  alt: Key.LeftAlt, Alt: Key.LeftAlt, option: Key.LeftAlt, opt: Key.LeftAlt,
  super: Key.LeftSuper, Super: Key.LeftSuper, win: Key.LeftSuper, windows: Key.LeftSuper, meta: Key.LeftSuper,

  // Navigation / editing
  return: Key.Enter, Return: Key.Enter, enter: Key.Enter, Enter: Key.Enter,
  tab: Key.Tab, Tab: Key.Tab,
  escape: Key.Escape, Escape: Key.Escape, esc: Key.Escape, Esc: Key.Escape,
  backspace: Key.Backspace, Backspace: Key.Backspace,
  delete: Key.Delete, Delete: Key.Delete, forwarddelete: Key.Delete,
  space: Key.Space, Space: Key.Space,
  home: Key.Home, Home: Key.Home,
  end: Key.End, End: Key.End,
  pageup: Key.PageUp, PageUp: Key.PageUp,
  pagedown: Key.PageDown, PageDown: Key.PageDown,
  insert: Key.Insert, Insert: Key.Insert,

  // Arrows
  left: Key.Left, Left: Key.Left,
  right: Key.Right, Right: Key.Right,
  up: Key.Up, Up: Key.Up,
  down: Key.Down, Down: Key.Down,

  // F-keys
  f1: Key.F1, F1: Key.F1, f2: Key.F2, F2: Key.F2, f3: Key.F3, F3: Key.F3,
  f4: Key.F4, F4: Key.F4, f5: Key.F5, F5: Key.F5, f6: Key.F6, F6: Key.F6,
  f7: Key.F7, F7: Key.F7, f8: Key.F8, F8: Key.F8, f9: Key.F9, F9: Key.F9,
  f10: Key.F10, F10: Key.F10, f11: Key.F11, F11: Key.F11, f12: Key.F12, F12: Key.F12,

  // Symbol keys reachable as single chars in combos like "ctrl++" / "ctrl+-"
  '=': Key.Equal,
  '+': Key.Equal,
  '-': Key.Minus,
  '_': Key.Minus,
  '`': Key.Grave,
};
