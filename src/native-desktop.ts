/**
 * Native Desktop Control — direct OS-level input
 * using @nut-tree-fork/nut-js for mouse/keyboard and screen capture.
 *
 * No network connection needed — controls the local desktop directly.
 *
 * - captureScreen() returns full-resolution frames
 * - captureForLLM() returns resized frames (1280px wide) with scaling metadata
 * - Coordinate scaling handled transparently
 */

import os from 'os';
import { EventEmitter } from 'events';
import sharp from 'sharp';
import { mouse, keyboard, screen, Button, Key, Point } from '@nut-tree-fork/nut-js';
import { normalizeKey } from './keys';
import type { ClawdConfig, ScreenFrame, MouseAction, KeyboardAction } from './types';

// On macOS, Command key = Key.LeftCmd. On other platforms, Super = Key.LeftSuper.
const SUPER_KEY = os.platform() === 'darwin' ? Key.LeftCmd : Key.LeftSuper;

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

/** LLM screenshot target width — smaller = faster API calls + fewer tokens */
// Higher resolution = better tool/icon identification. 1280 is Anthropic's recommended max.
// At 2560 screen: 1280 → scale 2x (was 1024 → 2.5x). Icons go from ~12px to ~20px.
const LLM_TARGET_WIDTH = 1280;

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
      const { Region } = await import('@nut-tree-fork/nut-js');
      const region = new Region(mon.x, mon.y, mon.width, mon.height);
      const img = await screen.grabRegion(region);
      const scaleFactor = mon.width > LLM_TARGET_WIDTH ? mon.width / LLM_TARGET_WIDTH : 1;
      const llmW = Math.round(mon.width / scaleFactor);
      const llmH = Math.round(mon.height / scaleFactor);
      const processed = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
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
      // Configure nut-js for speed
      mouse.config.mouseSpeed = 2000;    // Fast mouse movement
      mouse.config.autoDelayMs = 0;      // No auto-delay between actions
      keyboard.config.autoDelayMs = 0;   // No auto-delay between keystrokes

      // Grab a screenshot to determine screen dimensions
      const img = await screen.grab();
      this.screenWidth = img.width;
      this.screenHeight = img.height;

      // Calculate scale factor
      if (this.screenWidth > LLM_TARGET_WIDTH) {
        this.scaleFactor = this.screenWidth / LLM_TARGET_WIDTH;
      } else {
        this.scaleFactor = 1;
      }

      // Detect DPI ratio (physical / logical) for OCR coordinate conversion.
      // On Windows, System.Windows.Forms.Screen returns logical (DPI-scaled) dimensions,
      // while screen.grab() returns physical pixels. Mouse API uses logical coords.
      if (process.platform === 'win32') {
        try {
          const { execFileSync } = await import('child_process');
          const result = execFileSync('powershell.exe', [
            '-NoProfile', '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \"$($s.Width),$($s.Height)\"",
          ], { timeout: 10000, encoding: 'utf-8' }).trim();
          const [logicalW] = result.split(',').map(Number);
          if (logicalW > 0 && logicalW < this.screenWidth) {
            this.dpiRatio = this.screenWidth / logicalW;
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

    const img = await screen.grab();

    // Update screen dimensions in case of resolution change
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    const processed = await this.processFrame(
      img.data,
      img.width,
      img.height,
      this.screenWidth,
      this.screenHeight,
    );
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
   * - Resized to 1280px wide (or less if screen is smaller)
   * - Much smaller payload = fewer tokens = faster API calls
   * - Returns scaleFactor so coordinates in AI response can be mapped back
   */
  async captureForLLM(): Promise<ScreenFrame & { scaleFactor: number; llmWidth: number; llmHeight: number }> {
    if (!this.connected) {
      throw new Error('Not connected to native desktop');
    }

    const img = await screen.grab();

    // Update screen dimensions
    this.screenWidth = img.width;
    this.screenHeight = img.height;

    // Recalculate scale factor in case resolution changed
    if (this.screenWidth > LLM_TARGET_WIDTH) {
      this.scaleFactor = this.screenWidth / LLM_TARGET_WIDTH;
    } else {
      this.scaleFactor = 1;
    }

    const llmWidth = Math.min(this.screenWidth, LLM_TARGET_WIDTH);
    const llmHeight = Math.round(this.screenHeight / this.scaleFactor);

    const processed = await this.processFrame(
      img.data,
      img.width,
      img.height,
      llmWidth,
      llmHeight,
    );
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

    const img = await screen.grab();

    // Clamp to screen bounds
    const rx = Math.max(0, Math.min(x, img.width - 1));
    const ry = Math.max(0, Math.min(y, img.height - 1));
    const rw = Math.min(w, img.width - rx);
    const rh = Math.min(h, img.height - ry);

    // Scale crop to LLM-sized output (max 1280px wide)
    const cropScale = rw > LLM_TARGET_WIDTH ? rw / LLM_TARGET_WIDTH : 1;
    const llmWidth = Math.min(rw, LLM_TARGET_WIDTH);
    const llmHeight = Math.round(rh / cropScale);

    const { format, quality } = this.config.capture;

    let pipeline = sharp(img.data, {
      raw: { width: img.width, height: img.height, channels: 4 },
    }).extract({ left: rx, top: ry, width: rw, height: rh });

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
    if (this.dpiRatio <= 1) return { x, y };
    return {
      x: Math.round(x / this.dpiRatio),
      y: Math.round(y / this.dpiRatio),
    };
  }

  /**
   * Process a raw RGBA buffer into the configured output format.
   * nut-js screen.grab() returns RGBA data directly — no BGRA swap needed.
   */
  private async processFrame(
    rawData: Buffer,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): Promise<Buffer> {
    const { format, quality } = this.config.capture;

    let pipeline = sharp(rawData, {
      raw: {
        width: srcWidth,
        height: srcHeight,
        channels: 4,
      },
    });

    // Resize if target is smaller than source
    if (targetWidth < srcWidth || targetHeight < srcHeight) {
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
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    const btn = this.mapButton(button);
    await mouse.click(btn);
    console.log(`   🖱️  Click at (${x}, ${y})`);
  }

  async mouseDoubleClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    await mouse.doubleClick(Button.LEFT);
    console.log(`   🖱️  Double-click at (${x}, ${y})`);
  }

  async mouseRightClick(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await mouse.setPosition(new Point(x, y));
    await this.delay(50);
    await mouse.rightClick();
    console.log(`   🖱️  Right-click at (${x}, ${y})`);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await mouse.setPosition(new Point(x, y));
  }

  async mouseScroll(x: number, y: number, delta: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await mouse.setPosition(new Point(x, y));
    await this.delay(30);
    const steps = Math.abs(Math.round(delta));
    for (let i = 0; i < steps; i++) {
      if (delta > 0) {
        await mouse.scrollDown(3);
      } else {
        await mouse.scrollUp(3);
      }
      await this.delay(30);
    }
    console.log(`   🖱️  Scroll at (${x}, ${y}) delta=${delta}`);
  }

  async typeText(text: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await keyboard.type(text);
    console.log(`   ⌨️  Typed: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
  }

  async keyPress(keyCombo: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

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
    await mouse.setPosition(new Point(x, y));
    const btn = this.mapButton(button);
    await mouse.pressButton(btn);
  }

  async mouseUp(x: number, y: number, button: number = 1): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Mouse up at (${x}, ${y})`);
    await mouse.setPosition(new Point(x, y));
    const btn = this.mapButton(button);
    await mouse.releaseButton(btn);
  }

  async mouseDrag(sx: number, sy: number, ex: number, ey: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    console.log(`   🖱️  Drag (${sx},${sy}) → (${ex},${ey})`);

    await mouse.setPosition(new Point(sx, sy));
    await this.delay(50);
    await mouse.pressButton(Button.LEFT);
    await this.delay(100);

    // Interpolate intermediate points for smoother drag
    const steps = Math.max(5, Math.floor(Math.hypot(ex - sx, ey - sy) / 20));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(sx + (ex - sx) * t);
      const iy = Math.round(sy + (ey - sy) * t);
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
