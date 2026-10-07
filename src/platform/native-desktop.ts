/**
 * Native Desktop Control — direct OS-level input
 * using @nut-tree-fork/nut-js for mouse/keyboard and screen capture.
 *
 * No network connection needed — controls the local desktop directly.
 *
 * - captureScreen() returns full-resolution frames
 * - captureForLLM() returns resized frames (long edge ≤1280px, area ≤1.15 MP) with scaling metadata
 * - Coordinate scaling handled transparently
 */

import os from 'os';
import { EventEmitter } from 'events';
import sharp from 'sharp';
import { mouse, keyboard, screen, Button, Key, Point } from '@nut-tree-fork/nut-js';
import { normalizeKey } from './keys';
import { getNativeHelper, captureScreenViaHelper } from './native-helper';
import { sharpFromGrab, type GrabImage } from './grab-image';
import { isWaylandSession, waylandScreenSize, grimGrab } from './wayland-screen';
import { llmScale, llmSize } from '../core/agent-loop/coord-scale';
import { wheelUnitsPerNotch } from './wheel';
import * as fs from 'fs';
import type { ClawdConfig, ScreenFrame, MouseAction, KeyboardAction } from '../types';

// On macOS, Command key = Key.LeftCmd. On other platforms, Super = Key.LeftSuper.
const SUPER_KEY = os.platform() === 'darwin' ? Key.LeftCmd : Key.LeftSuper;
const IS_MAC = os.platform() === 'darwin';

/** Safely resolve a nut-js Key enum value from multiple candidate names */
function resolveNutKey(...candidates: string[]): Key {
  for (const name of candidates) {
    const value = Key[name as keyof typeof Key];
    if (value !== undefined) return value;
  }
  throw new Error(`Unable to resolve nut-js key from candidates: ${candidates.join(', ')}`);
}

// nut-js Key enum mapping from canonical key names (see keys.ts for normalization)
const KEY_MAP: Record<string, Key> = {
  'Return': Key.Enter,
  'Tab': Key.Tab,
  'Escape': Key.Escape,
  'Backspace': Key.Backspace,
  'Delete': Key.Delete,
  'Home': Key.Home,
  'End': Key.End,
  'PageUp': Key.PageUp,
  'PageDown': Key.PageDown,
  'Left': Key.Left,
  'Up': Key.Up,
  'Right': Key.Right,
  'Down': Key.Down,
  'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
  'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
  'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
  'Shift': Key.LeftShift,
  'Control': Key.LeftControl,
  'Alt': Key.LeftAlt,
  'Super': SUPER_KEY,
  'Space': Key.Space,

  // Symbol keys for combos like ctrl+plus / ctrl+minus
  '=': resolveNutKey('Equal', 'Equals'),
  '+': resolveNutKey('Equal', 'Equals', 'Add', 'NumAdd'),
  '-': resolveNutKey('Minus', 'Subtract', 'NumSubtract'),
  '_': resolveNutKey('Minus', 'Subtract', 'NumSubtract'),
};


export interface MonitorInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  name: string;
}

export class NativeDesktop extends EventEmitter {
  private config: ClawdConfig;
  private screenWidth = 0;
  private screenHeight = 0;
  private connected = false;
  private monitors: MonitorInfo[] = [];
  private helper = IS_MAC ? getNativeHelper() : null;

  /** Scale factor: LLM coordinates × scaleFactor = real screen coordinates */
  private scaleFactor = 1;
  /**
   * DPI ratio: physical pixels / logical (mouse) pixels.
   * OCR coordinates (physical) / dpiRatio = mouse coordinates (logical).
   * Detected at connect() time via System.Windows.Forms.
   */
  private dpiRatio = 1;

  constructor(config: ClawdConfig) {
    super();
    this.config = config;
  }

  /**
   * Enumerate all connected monitors with their positions and sizes.
   * Returns best-effort results — falls back to primary only on errors.
   */
  async getMonitors(): Promise<MonitorInfo[]> {
    if (this.monitors.length > 0) return this.monitors;

    try {
      if (process.platform === 'win32') {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X),$($_.Bounds.Y),$($_.Bounds.Width),$($_.Bounds.Height),$($_.Primary),$($_.DeviceName)" }`;
        const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`);
        const lines = stdout.trim().split('\n').filter(Boolean);
        this.monitors = lines.map((line, i) => {
          const [x, y, w, h, primary, name] = line.trim().split(',');
          return {
            index: i,
            x: parseInt(x), y: parseInt(y),
            width: parseInt(w), height: parseInt(h),
            primary: primary.trim().toLowerCase() === 'true',
            name: name?.trim() || `Monitor ${i + 1}`,
          };
        });
      } else if (process.platform === 'darwin') {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        // system_profiler gives display info; for bounds we use osascript
        const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get bounds of every desktop'`).catch(() => ({ stdout: '' }));
        if (stdout.trim()) {
          // fallback: just return primary
          this.monitors = [{ index: 0, x: 0, y: 0, width: this.screenWidth, height: this.screenHeight, primary: true, name: 'Primary' }];
        } else {
          this.monitors = [{ index: 0, x: 0, y: 0, width: this.screenWidth, height: this.screenHeight, primary: true, name: 'Primary' }];
        }
      } else {
        // Linux: use xrandr
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const { stdout } = await execAsync('xrandr --query 2>/dev/null').catch(() => ({ stdout: '' }));
        const re = /(\S+) connected(?: primary)? (\d+)x(\d+)\+(\d+)\+(\d+)/g;
        let m; let i = 0; const results: MonitorInfo[] = [];
        while ((m = re.exec(stdout)) !== null) {
          results.push({ index: i++, x: parseInt(m[4]), y: parseInt(m[5]), width: parseInt(m[2]), height: parseInt(m[3]), primary: stdout.includes(m[1] + ' connected primary'), name: m[1] });
        }
        this.monitors = results.length > 0 ? results : [{ index: 0, x: 0, y: 0, width: this.screenWidth, height: this.screenHeight, primary: true, name: 'Primary' }];
      }
    } catch {
      this.monitors = [{ index: 0, x: 0, y: 0, width: this.screenWidth, height: this.screenHeight, primary: true, name: 'Primary' }];
    }

    return this.monitors;
  }

  /**
   * Capture a specific monitor by index.
   * Falls back to primary grab if region capture fails.
   */
  async captureMonitor(monitorIndex = 0): Promise<ScreenFrame & { scaleFactor: number; llmWidth: number; llmHeight: number }> {
    const monitors = await this.getMonitors();
    const mon = monitors[monitorIndex] ?? monitors.find(m => m.primary) ?? monitors[0];
    if (!mon) return this.captureForLLM();

    try {
      let img: GrabImage;
      if (isWaylandSession()) {
        img = await grimGrab({ x: mon.x, y: mon.y, width: mon.width, height: mon.height });
      } else {
        const { Region } = await import('@nut-tree-fork/nut-js');
        img = await screen.grabRegion(new Region(mon.x, mon.y, mon.width, mon.height));
      }
      const { scale: scaleFactor, width: llmW, height: llmH } = llmSize(mon.width, mon.height);
      const processed = await sharpFromGrab(img)
        .resize(llmW, llmH)
        .png()
        .toBuffer();
      // Release the raw RGBA buffer immediately after processing
      (img as any).data = null;
      return { width: mon.width, height: mon.height, buffer: processed, timestamp: Date.now(), format: 'png', scaleFactor, llmWidth: llmW, llmHeight: llmH };
    } catch {
      // Fallback: full primary grab
      return this.captureForLLM();
    }
  }

  /**
   * "Connect" to the native desktop — detects screen size and configures nut-js.
   * No actual network connection; just initializes the local screen interface.
   */
  async connect(): Promise<void> {
    try {
      if (IS_MAC) {
        // Use the standalone screenshot-helper binary — avoids ReplayKit CPU spin
        // bug and runs in an isolated subprocess for clean TCC permission scoping.
        try {
          const result = await captureScreenViaHelper();
          this.screenWidth = result.width;
          this.screenHeight = result.height;
          this.scaleFactor = llmScale(this.screenWidth, this.screenHeight);
          // Clean up the temp file from connect probe
          try { fs.unlinkSync(result.path); } catch { /* ignore */ }
          this.connected = true;
          console.log(`🐾 Native desktop connected (macOS screenshot-helper)`);
          console.log(`   Screen: ${this.screenWidth}x${this.screenHeight}`);
          console.log(`   LLM scale factor: ${this.scaleFactor.toFixed(2)}x`);
          return;
        } catch (err: any) {
          console.warn(`⚠️  macOS screenshot-helper failed, falling back to nut-js: ${err?.message || err}`);
        }
      }

      // Configure nut-js for speed
      mouse.config.mouseSpeed = 2000;    // Fast mouse movement
      mouse.config.autoDelayMs = 0;      // No auto-delay between actions
      keyboard.config.autoDelayMs = 0;   // No auto-delay between keystrokes

      if (isWaylandSession()) {
        // nut-js screen calls are fatal on Wayland (see wayland-screen.ts) —
        // ask the compositor for geometry; captures refresh it anyway.
        const ws = await waylandScreenSize();
        if (ws) {
          this.screenWidth = ws.physicalWidth;
          this.screenHeight = ws.physicalHeight;
        } else {
          console.warn('⚠️  Screen size unknown on Wayland (need swaymsg, wlr-randr or xrandr) — using the first capture');
        }
      } else {
        // Grab a screenshot to determine screen dimensions
        const img = await screen.grab();
        this.screenWidth = img.width;
        this.screenHeight = img.height;
      }

      // Calculate scale factor
      this.scaleFactor = llmScale(this.screenWidth, this.screenHeight);

      // Detect DPI ratio (physical / mouse-driver px). screen.grab() returns
      // physical pixels; physicalToMouse divides by this before every move.
      if (process.platform === 'win32') {
        // Ask nut-js, in THIS process, what space its mouse uses — DPI awareness
        // is per-process. A DPI-unaware node drives logical px (ratio 2.25 on a
        // 225% panel); a DPI-aware host (Claude Desktop's Electron utility
        // process) drives physical px (ratio 1). Measuring via a separate
        // PowerShell always got the logical width, so in an aware host every
        // click landed at 1/dpiRatio of its target.
        try {
          const mouseW = await screen.width();
          if (mouseW > 0 && mouseW < this.screenWidth) {
            this.dpiRatio = this.screenWidth / mouseW;
          }
        } catch { /* non-fatal — dpiRatio stays 1 */ }
      } else if (process.platform === 'darwin') {
        try {
          const { execFileSync } = await import('child_process');
          // NSScreen reports in logical (point) dimensions — compare with physical pixels from screen.grab()
          // TODO: Multi-monitor support — currently uses mainScreen only. For multi-monitor,
          // enumerate NSScreen.screens and sum widths to get the full virtual canvas size.
          const result = execFileSync('osascript', ['-e',
            'use framework "AppKit"\nreturn (current application\'s NSScreen\'s mainScreen\'s frame()\'s size\'s width) as integer',
          ], { timeout: 5000, encoding: 'utf-8' }).trim();
          const logicalW = parseInt(result);
          if (logicalW > 0 && logicalW < this.screenWidth) {
            this.dpiRatio = this.screenWidth / logicalW;
          }
        } catch { /* non-fatal — dpiRatio stays 1 */ }
      } else if (process.platform === 'linux') {
        try {
          // Check common DE scale environment variables first — Wayland only.
          // On X11 the pointer space IS physical pixels (xdotool / XTest /
          // nut-js), so GDK_SCALE=2 on a 1920x1080 X server made
          // physicalToMouse halve every click. Mirrors LinuxAdapter.
          const onWayland = (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
            || (!process.env.XDG_SESSION_TYPE && !!process.env.WAYLAND_DISPLAY);
          const gdkScale = parseInt(process.env.GDK_SCALE || '1');
          const qtScale = parseFloat(process.env.QT_SCALE_FACTOR || '1');
          const envScale = onWayland ? Math.max(gdkScale, qtScale) : 1;
          if (envScale > 1) {
            this.dpiRatio = envScale;
          } else if (onWayland) {
            // X11: pointer space IS the physical root window. Comparing it to
            // the PRIMARY output's width halved every click on a two-monitor
            // setup (root 3840 / primary 1920 = "2x").
            const { execFileSync } = await import('child_process');
            const output = execFileSync('xrandr', ['--query'], { timeout: 5000, encoding: 'utf-8' });
            const match = output.match(/primary\s+(\d+)x(\d+)/);
            if (match) {
              const logicalW = parseInt(match[1]);
              if (logicalW > 0 && logicalW < this.screenWidth) {
                this.dpiRatio = this.screenWidth / logicalW;
              }
            }
          }
        } catch { /* non-fatal — dpiRatio stays 1 */ }
      }

      this.connected = true;

      console.log(`🐾 Native desktop connected`);
      console.log(`   Screen: ${this.screenWidth}x${this.screenHeight}`);
      console.log(`   LLM scale factor: ${this.scaleFactor.toFixed(2)}x`);
      if (this.dpiRatio > 1) {
        console.log(`   DPI ratio: ${this.dpiRatio.toFixed(2)}x (physical/logical)`);
      }
    } catch (err: any) {
      console.error('Native desktop init error:', err?.message);
      this.connected = false;
      throw err;
    }
  }

  /**
   * Capture a full-resolution screenshot.
   */
  async captureScreen(): Promise<ScreenFrame> {
    if (!this.connected) {
      throw new Error('Not connected to native desktop');
    }

    if (IS_MAC) {
      try {
        const result = await captureScreenViaHelper();
        const buffer = fs.readFileSync(result.path);
        try { fs.unlinkSync(result.path); } catch { /* cleanup */ }
        this.screenWidth = result.width;
        this.screenHeight = result.height;
        return {
          width: result.width,
          height: result.height,
          buffer,
          timestamp: Date.now(),
          format: 'png',
        };
      } catch (err: any) {
        console.warn(`⚠️  macOS screenshot-helper failed, falling back to nut-js: ${err?.message || err}`);
      }
    }

    const img = await this.grab();

    // Update screen dimensions in case of resolution change
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    const processed = await this.processFrame(img, this.screenWidth, this.screenHeight);
    // Release the raw RGBA buffer immediately after processing
    (img as any).data = null;

    return {
      width: this.screenWidth,
      height: this.screenHeight,
      buffer: processed,
      timestamp: Date.now(),
      format: this.config.capture.format,
    };
  }

  /**
   * Capture a RESIZED screenshot optimized for LLM vision.
   * - Resized so the long edge ≤1280px and area ≤1.15 MP (never upscaled) — llmSize()
   * - Much smaller payload = fewer tokens = faster API calls
   * - Returns scaleFactor so coordinates in AI response can be mapped back
   */
  async captureForLLM(): Promise<ScreenFrame & { scaleFactor: number; llmWidth: number; llmHeight: number }> {
    if (!this.connected) {
      throw new Error('Not connected to native desktop');
    }

    if (IS_MAC) {
      try {
        const frame = await this.captureScreen();
        this.screenWidth = frame.width;
        this.screenHeight = frame.height;
        const { scale, width: llmWidth, height: llmHeight } = llmSize(this.screenWidth, this.screenHeight);
        this.scaleFactor = scale;
        const pipeline = sharp(frame.buffer).resize(llmWidth, llmHeight);
        const processed = this.config.capture.format === 'jpeg'
          ? await pipeline.jpeg({ quality: this.config.capture.quality }).toBuffer()
          : await pipeline.png().toBuffer();
        return {
          width: this.screenWidth,
          height: this.screenHeight,
          buffer: processed,
          timestamp: Date.now(),
          format: this.config.capture.format,
          scaleFactor: this.scaleFactor,
          llmWidth,
          llmHeight,
        };
      } catch (err: any) {
        console.warn(`⚠️  macOS screenshot-helper LLM capture failed, falling back to nut-js: ${err?.message || err}`);
      }
    }

    const img = await this.grab();

    // Update screen dimensions
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    // Recalculate scale factor in case resolution changed (long edge AND area capped)
    const { scale, width: llmWidth, height: llmHeight } = llmSize(this.screenWidth, this.screenHeight);
    this.scaleFactor = scale;

    const processed = await this.processFrame(img, llmWidth, llmHeight);
    // Release the raw RGBA buffer immediately after processing
    (img as any).data = null;

    return {
      width: this.screenWidth,       // real screen width
      height: this.screenHeight,     // real screen height
      buffer: processed,
      timestamp: Date.now(),
      format: this.config.capture.format,
      scaleFactor: this.scaleFactor,
      llmWidth,
      llmHeight,
    };
  }

  /**
   * Capture a CROPPED region of the screen, resized for LLM.
   * Coordinates are in REAL screen pixels.
   * Returns the cropped image at higher effective resolution (more detail per pixel).
   * @future — not yet used; intended for focused region analysis
   */
  async captureRegionForLLM(
    x: number, y: number, w: number, h: number
  ): Promise<ScreenFrame & { scaleFactor: number; llmWidth: number; llmHeight: number; regionX: number; regionY: number }> {
    if (!this.connected) throw new Error('Not connected');

    if (IS_MAC && this.helper) {
      const full = await this.captureScreen();
      const rx = Math.max(0, Math.min(x, full.width - 1));
      const ry = Math.max(0, Math.min(y, full.height - 1));
      const rw = Math.min(w, full.width - rx);
      const rh = Math.min(h, full.height - ry);
      const { scale: cropScale, width: llmWidth, height: llmHeight } = llmSize(rw, rh);
      const { format, quality } = this.config.capture;
      let pipeline = sharp(full.buffer).extract({ left: rx, top: ry, width: rw, height: rh });
      if (llmWidth < rw) {
        pipeline = pipeline.resize(llmWidth, llmHeight, { fit: 'fill', kernel: 'lanczos3' });
      }
      const buffer = format === 'jpeg' ? await pipeline.jpeg({ quality }).toBuffer() : await pipeline.png().toBuffer();
      return { width: rw, height: rh, buffer, timestamp: Date.now(), format, scaleFactor: cropScale, llmWidth, llmHeight, regionX: rx, regionY: ry };
    }

    const img = await this.grab();

    // Clamp to screen bounds
    const rx = Math.max(0, Math.min(x, img.width - 1));
    const ry = Math.max(0, Math.min(y, img.height - 1));
    const rw = Math.min(w, img.width - rx);
    const rh = Math.min(h, img.height - ry);

    // Scale crop to LLM-sized output (long edge and area capped)
    const { scale: cropScale, width: llmWidth, height: llmHeight } = llmSize(rw, rh);

    const { format, quality } = this.config.capture;

    let pipeline = sharpFromGrab(img).extract({ left: rx, top: ry, width: rw, height: rh });

    if (llmWidth < rw) {
      pipeline = pipeline.resize(llmWidth, llmHeight, { fit: 'fill', kernel: 'lanczos3' });
    }

    const buffer = format === 'jpeg'
      ? await pipeline.jpeg({ quality }).toBuffer()
      : await pipeline.png().toBuffer();
    // Release the raw RGBA buffer immediately after processing
    (img as any).data = null;

    return {
      width: rw,
      height: rh,
      buffer,
      timestamp: Date.now(),
      format,
      scaleFactor: cropScale,
      llmWidth,
      llmHeight,
      regionX: rx,
      regionY: ry,
    };
  }

  /**
   * Get the scaling factor (LLM pixels → real screen pixels)
   */
  getScaleFactor(): number {
    return this.scaleFactor;
  }

  /** Width (px) of the image the model gets for the current screen — llmSize(). */
  getLlmWidth(): number {
    return this.screenWidth > 0 ? Math.max(1, Math.round(this.screenWidth / this.scaleFactor)) : 0;
  }

  /**
   * Get the DPI ratio (physical pixels / logical mouse pixels).
   * Returns 1 on non-HiDPI screens or non-Windows platforms.
   */
  getDpiRatio(): number {
    return this.dpiRatio;
  }

  /**
   * Convert physical pixel coordinates (from OCR/screenshot) to mouse coordinates.
   * On Windows with DPI scaling, nut-js mouse API uses logical (DPI-scaled) coords,
   * while screen.grab() returns physical pixels. This method bridges the gap.
   */
  physicalToMouse(x: number, y: number): { x: number; y: number } {
    // macOS: callers already pass LOGICAL coords. The compact tools map image→logical
    // via mouseScaleFactor (cli.ts, the #154 fix) and nut-js on macOS consumes logical
    // points. Dividing by dpiRatio here would double-convert and re-introduce #154
    // (every click lands ~2× off on a Retina panel). nut-js drives PHYSICAL only on
    // Windows/Linux-X11 (DPI-unaware process), so the division belongs there alone.
    if (process.platform === 'darwin') return { x, y };
    if (this.dpiRatio <= 1) return { x, y };
    return {
      x: Math.round(x / this.dpiRatio),
      y: Math.round(y / this.dpiRatio),
    };
  }

  /**
   * Read the current cursor position in SCREEN coordinates — the same space
   * a11y/OCR/screenshot coordinates use, i.e. what callers pass to mouseClick.
   * Exact inverse of physicalToMouse: nut-js reports the driver space (logical
   * on Windows/Linux-X11 in this DPI-unaware process; already caller-space on
   * macOS), so multiply back by dpiRatio off-darwin. Computer-use parity:
   * Anthropic's computer tool exposes cursor_position; agents porting those
   * loops expect a pointer-state read.
   */
  async getCursorPosition(): Promise<{ x: number; y: number }> {
    const p = await mouse.getPosition();
    if (process.platform === 'darwin' || this.dpiRatio <= 1) return { x: p.x, y: p.y };
    return { x: Math.round(p.x * this.dpiRatio), y: Math.round(p.y * this.dpiRatio) };
  }

  /**
   * Full-screen grab. nut-js on X11/Windows/macOS; grim on Wayland, where
   * nut-js would open X11 and take the process down (see wayland-screen.ts).
   */
  private grab(): Promise<GrabImage> {
    return isWaylandSession() ? grimGrab() : screen.grab();
  }

  /**
   * Process a raw grab into the configured output format.
   * nut-js screen.grab() returns BGR(A) — sharpFromGrab reorders it and forces alpha opaque.
   */
  private async processFrame(
    img: GrabImage,
    targetWidth: number,
    targetHeight: number,
  ): Promise<Buffer> {
    const { format, quality } = this.config.capture;

    let pipeline = sharpFromGrab(img);

    // Resize if target is smaller than source
    if (targetWidth < img.width || targetHeight < img.height) {
      pipeline = pipeline.resize(targetWidth, targetHeight, {
        fit: 'fill',
        kernel: 'lanczos3',
      });
    }

    if (format === 'jpeg') {
      return pipeline.jpeg({ quality }).toBuffer();
    }
    return pipeline.png().toBuffer();
  }

  // --- Input Methods ---

  async mouseClick(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    // On macOS: skip the Swift helper (CGEvent blocked by TCC), use nut-js directly.
    // nut-js mouse events ARE delivered on macOS (unlike CGEvent from child processes).
    // physicalToMouse: callers pass PHYSICAL coords (image×imageScale / a11y / OCR);
    // nut-js drives in LOGICAL coords in this DPI-unaware process, so /dpiRatio. Without
    // this, clicks on a scaled display land dpiRatio× off-target (and activate-at-point
    // resolves the wrong window -> foreground theft).
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    await this.delay(50);
    const btn = this.mapButton(button);
    await mouse.click(btn);
  }

  async mouseDoubleClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    await this.delay(50);
    await mouse.doubleClick(Button.LEFT);
    console.log(`   🖱️  Double-click at (${x}, ${y})`);
  }

  async mouseRightClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    await this.delay(50);
    await mouse.rightClick();
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
  }

  async mouseScroll(x: number, y: number, delta: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    await this.delay(30);
    const steps = Math.abs(Math.round(delta));
    for (let i = 0; i < steps; i++) {
      // One notch per tick (it was 3 raw units: 3/120 of a notch on Windows,
      // 3 px on macOS, 3 notches on X11 — see wheel.ts).
      if (delta > 0) {
        await mouse.scrollDown(wheelUnitsPerNotch());
      } else {
        await mouse.scrollUp(wheelUnitsPerNotch());
      }
      await this.delay(30);
    }
    console.log(`   🖱️  Scroll at (${x}, ${y}) delta=${delta}`);
  }

  async typeText(text: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    if (IS_MAC) {
      // Use System Events for typing — same reason as keyPress:
      // CGEvent from helper subprocess is silently blocked by TCC.
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      try {
        await execFileAsync('osascript', ['-e',
          `tell application "System Events" to keystroke "${escaped}"`
        ], { timeout: 10000 });
      } catch (err: any) {
        console.warn(`   ⌨️  macOS type failed: ${err.message?.substring(0, 100)}`);
        // Fallback: try helper anyway
        if (this.helper) {
          await this.helper.type(text);
        }
      }
      return;
    }
    await keyboard.type(text);
    console.log(`   ⌨️  Typed: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
  }

  async keyPress(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    if (IS_MAC) {
      // macOS: use System Events via osascript for reliable keystroke delivery.
      // CGEvent.post() from a spawned helper is silently blocked by TCC on macOS 15+
      // because the helper inherits the parent's TCC context but CGEvent posting
      // requires the calling process itself to be trusted for input.
      // System Events is the proven, reliable method for keyboard automation on macOS.
      await this.macKeyPress(keyCombo);
      return;
    }

    // Special case: literal "+" character (can't split on "+" since it IS the separator)
    if (keyCombo === '+') {
      await keyboard.type('+');
      await this.delay(30);
      console.log(`   ⌨️  Key press: +`);
      return;
    }

    const parts = keyCombo.split('+').map(k => k.trim()).filter(k => k.length > 0);
    const keys = parts.map(k => this.mapKey(k));

    // If the only key is a TYPE_CHAR (single printable char like *, +, ., etc.),
    // use keyboard.type() which handles shift combos automatically
    if (keys.length === 1 && keys[0] === 'TYPE_CHAR') {
      await keyboard.type(parts[0]);
      await this.delay(30);
    } else if (keys.length === 1) {
      await keyboard.pressKey(keys[0] as Key);
      await this.delay(30);
      await keyboard.releaseKey(keys[0] as Key);
    } else {
      // Press all modifier keys down, then the final key, then release in reverse
      for (const key of keys) {
        if (key === 'TYPE_CHAR') {
          await keyboard.type(parts[keys.indexOf(key)]);
        } else {
          await keyboard.pressKey(key as Key);
        }
        await this.delay(30);
      }
      for (const key of [...keys].reverse()) {
        if (key !== 'TYPE_CHAR') {
          await keyboard.releaseKey(key as Key);
        }
        await this.delay(30);
      }
    }
    console.log(`   ⌨️  Key press: ${keyCombo}`);
  }

  /**
   * macOS keyboard input via System Events (osascript).
   * Reliable because System Events has its own TCC grant for input,
   * unlike CGEvent.post() from a spawned child process.
   */
  private async macKeyPress(keyCombo: string): Promise<void> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    if (keyCombo === '+') {
      await execFileAsync('osascript', ['-e', 'tell application "System Events" to keystroke "+"']);
      return;
    }

    const parts = keyCombo.split('+').map(k => k.trim()).filter(Boolean);
    const key = parts[parts.length - 1] || keyCombo;
    if (!key) {
      throw new Error(`macKeyPress: empty key after parsing combo "${keyCombo}"`);
    }
    const mods = parts.slice(0, -1).map(k => k.toLowerCase());

    // Map modifier names to System Events syntax.
    // `mod` is the platform-aware "primary" modifier that resolves to Cmd
    // on macOS — without this branch macKeyPress would silently type the
    // bare letter (e.g. `mod+s` becomes a literal `s` keystroke).
    const modUsing: string[] = [];
    for (const m of mods) {
      if (m === 'cmd' || m === 'command' || m === 'super' || m === 'mod') modUsing.push('command down');
      else if (m === 'shift') modUsing.push('shift down');
      else if (m === 'alt' || m === 'option') modUsing.push('option down');
      else if (m === 'ctrl' || m === 'control') modUsing.push('control down');
    }

    // Map special key names to System Events key code actions
    const specialKeys: Record<string, string> = {
      'return': 'key code 36', 'enter': 'key code 36',
      'tab': 'key code 48',
      'escape': 'key code 53', 'esc': 'key code 53',
      'delete': 'key code 51', 'backspace': 'key code 51',
      'space': 'key code 49',
      'left': 'key code 123', 'right': 'key code 124',
      'down': 'key code 125', 'up': 'key code 126',
      'f1': 'key code 122', 'f2': 'key code 120', 'f3': 'key code 99',
      'f4': 'key code 118', 'f5': 'key code 96', 'f6': 'key code 97',
      'f7': 'key code 98', 'f8': 'key code 100', 'f9': 'key code 101',
      'f10': 'key code 109', 'f11': 'key code 103', 'f12': 'key code 111',
      'pageup': 'key code 116', 'pagedown': 'key code 121',
      'home': 'key code 115', 'end': 'key code 119',
      'forwarddelete': 'key code 117',
    };

    let script: string;
    const special = specialKeys[key.toLowerCase()];
    if (special) {
      // Special key — use key code
      if (modUsing.length > 0) {
        script = `tell application "System Events" to ${special} using {${modUsing.join(', ')}}`;
      } else {
        script = `tell application "System Events" to ${special}`;
      }
    } else if (key.length === 1) {
      // Single character — use keystroke
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (modUsing.length > 0) {
        script = `tell application "System Events" to keystroke "${escaped}" using {${modUsing.join(', ')}}`;
      } else {
        script = `tell application "System Events" to keystroke "${escaped}"`;
      }
    } else {
      // Unknown key — try keystroke as-is
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${escaped}"`;
    }

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    } catch (err: any) {
      console.warn(`   ⌨️  macOS key press failed: ${err.message?.substring(0, 100)}`);
    }
  }

  async executeMouseAction(action: MouseAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.mouseClick(action.x, action.y);
        break;
      case 'double_click':
        await this.mouseDoubleClick(action.x, action.y);
        break;
      case 'right_click':
        await this.mouseRightClick(action.x, action.y);
        break;
      case 'move':
        await this.mouseMove(action.x, action.y);
        break;
      case 'scroll':
        await this.mouseScroll(action.x, action.y, action.scrollDelta || 3);
        break;
      case 'drag':
        await this.mouseDrag(action.x, action.y, action.endX || action.x, action.endY || action.y);
        break;
    }
  }

  async executeKeyboardAction(action: KeyboardAction): Promise<void> {
    switch (action.kind) {
      case 'type':
        if (action.text) await this.typeText(action.text);
        break;
      case 'key_press':
        if (action.key) await this.keyPress(action.key);
        break;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Low-level key control (for Computer Use API hold_key) ────────

  async keyDown(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Key down: ${keyCombo}`);
    if (keyCombo === '+') { await keyboard.type('+'); return; }
    const parts = keyCombo.split('+').map(k => k.trim()).filter(k => k.length > 0);
    for (const k of parts) {
      const key = this.mapKey(k);
      if (key === 'TYPE_CHAR') {
        await keyboard.type(k);
      } else {
        await keyboard.pressKey(key);
      }
      await this.delay(20);
    }
  }

  async keyUp(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   ⌨️  Key up: ${keyCombo}`);
    if (keyCombo === '+') return; // type() already released
    const parts = keyCombo.split('+').map(k => k.trim()).filter(k => k.length > 0);
    for (const k of [...parts].reverse()) {
      const key = this.mapKey(k);
      if (key !== 'TYPE_CHAR') {
        await keyboard.releaseKey(key);
      }
      await this.delay(20);
    }
  }

  // ─── Low-level pointer control (for Computer Use API) ────────────

  async mouseDown(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Mouse down at (${x}, ${y})`);
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    const btn = this.mapButton(button);
    await mouse.pressButton(btn);
  }

  async mouseUp(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Mouse up at (${x}, ${y})`);
    const m = this.physicalToMouse(x, y);
    await mouse.setPosition(new Point(m.x, m.y));
    const btn = this.mapButton(button);
    await mouse.releaseButton(btn);
  }

  async mouseDrag(sx: number, sy: number, ex: number, ey: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    // nut-js drag works on all platforms including macOS
    console.log(`   🖱️  Drag (${sx},${sy}) → (${ex},${ey})`);

    // Convert both endpoints PHYSICAL->LOGICAL up front, interpolate in logical space.
    const a = this.physicalToMouse(sx, sy);
    const b = this.physicalToMouse(ex, ey);
    await mouse.setPosition(new Point(a.x, a.y));
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(100);

    // Interpolate intermediate points for smoother drag
    const steps = Math.max(5, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 20));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(a.x + (b.x - a.x) * t);
      const iy = Math.round(a.y + (b.y - a.y) * t);
      await mouse.setPosition(new Point(ix, iy));
      await this.delay(15);
    }

    await mouse.releaseButton(Button.LEFT);
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  disconnect(): void {
    this.connected = false;
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.emit('disconnected');
    // Remove all listeners so this instance can be GCd after disconnect.
    // Must come after emit so 'disconnected' handlers still fire.
    this.removeAllListeners();
    console.log('🐾 Native desktop disconnected');
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * Map a button number to nut-js Button enum.
   * 1=left, 2=middle, 4=right
   */
  private mapButton(buttonId: number): Button {
    switch (buttonId) {
      case 1: return Button.LEFT;
      case 2: return Button.MIDDLE;
      case 4: return Button.RIGHT;
      default: return Button.LEFT;
    }
  }

  /**
   * Map a string key name to nut-js Key enum value.
   * Falls back to character-based lookup for single characters.
   */
  private mapKey(keyName: string): Key | 'TYPE_CHAR' {
    // Normalize via canonical key names first
    const normalized = normalizeKey(keyName);

    // Direct lookup in our map
    const mapped = KEY_MAP[normalized];
    if (mapped !== undefined) return mapped;

    // Single character — try to find matching Key enum entry
    if (keyName.length === 1) {
      const upper = keyName.toUpperCase();
      // Letters A-Z
      if (upper >= 'A' && upper <= 'Z') {
        const keyEntry = Key[upper as keyof typeof Key];
        if (keyEntry !== undefined) return keyEntry;
      }
      // Digits 0-9
      if (upper >= '0' && upper <= '9') {
        const numKey = `Num${upper}` as keyof typeof Key;
        const keyEntry = Key[numKey];
        if (keyEntry !== undefined) return keyEntry;
      }
      // Single printable character (symbols like *, +, -, ., etc.)
      // Use keyboard.type() for these — it handles shift combos automatically
      if (keyName.charCodeAt(0) >= 32 && keyName.charCodeAt(0) <= 126) {
        return 'TYPE_CHAR';
      }
    }

    // Last resort: try exact enum name match
    const enumKey = keyName as keyof typeof Key;
    if (Key[enumKey] !== undefined) return Key[enumKey];

    throw new Error(`Unknown key: "${keyName}" — no mapping found in KEY_MAP or Key enum`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
