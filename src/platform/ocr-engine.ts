/**
 * OcrEngine — OS-level OCR bridge.
 *
 * Takes a screenshot (or region), returns structured OCR results with bounding boxes.
 * Coordinates are in REAL screen pixels — no scaleFactor conversion needed.
 *
 * Windows: Windows.Media.Ocr via PowerShell one-shot (scripts/ocr-recognize.ps1).
 * macOS:   Apple Vision framework via Swift script (scripts/mac/ocr-recognize.swift).
 * Linux:   Tesseract OCR via Python script (scripts/linux/ocr-recognize.py).
 *
 * Caching: last result is kept for 300ms. Invalidated on any action execution.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { screen } from '@nut-tree-fork/nut-js';
import sharp from 'sharp';
import { getPackageRoot } from '../paths';
import { sharpFromGrab, type GrabImage } from './grab-image';
import { isWaylandSession, grimGrab } from './wayland-screen';
import { psRunner } from './ps-runner';
import { pickDisplay } from './display-target';
import type { Display } from './types';

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = path.join(getPackageRoot(), 'scripts');
const OCR_SCRIPT = path.join(SCRIPTS_DIR, 'ocr-recognize.ps1');
const MAC_OCR_SCRIPT = path.join(SCRIPTS_DIR, 'mac', 'ocr-recognize.swift');
const LINUX_OCR_SCRIPT = path.join(SCRIPTS_DIR, 'linux', 'ocr-recognize.py');
const CACHE_TTL_MS = 300;
const OCR_TIMEOUT = 15000;   // 15s — WinRT assembly load + recognition
const MAC_OCR_TIMEOUT = 20000; // 20s — Swift compilation on first run
const LINUX_OCR_TIMEOUT = 30000; // 30s — Tesseract can be slow on large images
const LINUX_OCR_UPSCALE = 2;      // Tesseract needs UI text larger than native size
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB — large screens with dense text

// ─── Public types ─────────────────────────────────────────────────────────────

export interface OcrElement {
  text: string;
  x: number;        // left edge in screen pixels
  y: number;        // top edge
  width: number;
  height: number;
  confidence: number; // 0.0–1.0
  line: number;     // line index (for grouping)
}

export interface OcrResult {
  elements: OcrElement[];
  fullText: string;  // flat concatenation for quick search
  durationMs: number;
}

const EMPTY_RESULT: OcrResult = Object.freeze({ elements: [], fullText: '', durationMs: 0 });

/**
 * Windows: PNG of a PHYSICAL virtual-desktop rect via the bridge, on any
 * monitor. nut-js grabs the primary display only, so OCR of the monitor
 * clawdcursor is working on read the wrong screen. With no rect: the working
 * monitor when it is not the primary. null → use the nut-js grab.
 */
async function bridgeCapture(rect?: { x: number; y: number; width: number; height: number }): Promise<{ png: Buffer; x: number; y: number } | null> {
  if (process.platform !== 'win32') return null;
  try {
    let r = rect;
    if (!r) {
      const list = await psRunner.run({ cmd: 'list-displays' }) as { displays?: Array<{ index: number; primary: boolean; x: number; y: number; width: number; height: number }> };
      const displays = (list?.displays ?? []).map(d => ({ index: d.index, primary: d.primary, bounds: { x: d.x, y: d.y, width: d.width, height: d.height } })) as Display[];
      const target = pickDisplay(displays);
      if (!target || target.primary) return null;
      r = target.bounds;
    }
    const x = Math.round(r.x), y = Math.round(r.y);
    const c = await psRunner.run({ cmd: 'capture-rect', x, y, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }) as { success?: boolean; png?: string };
    return c?.success && c.png ? { png: Buffer.from(c.png, 'base64'), x, y } : null;
  } catch {
    return null;
  }
}

/**
 * True when the failure means the OCR engine itself is absent: the runner
 * binary could not be spawned (ENOENT), or the script reported it could not
 * find / load an engine ("tesseract not found", "Windows OCR engine not
 * available - no recognized languages installed", "No OCR available").
 */
function isEngineMissing(err: any): boolean {
  if (err?.code === 'ENOENT') return true;
  return /\bnot (found|available|installed)\b/i.test(String(err?.message ?? ''));
}

// ─── OcrEngine ────────────────────────────────────────────────────────────────

export class OcrEngine {
  private cachedResult: OcrResult | null = null;
  private cacheTimestamp = 0;
  private available: boolean | null = null;

  /**
   * Check if OS-level OCR is available on this platform.
   * Never throws.
   */
  isAvailable(): boolean {
    if (this.available !== null) return this.available;

    if (process.platform === 'win32') {
      // Windows.Media.Ocr ships with Windows 10+.
      // Actual availability (language packs) is verified on first recognizeScreen() call.
      this.available = true;
      return true;
    }

    if (process.platform === 'darwin') {
      // macOS: Apple Vision framework via Swift script.
      // Available on macOS 10.15+ (Catalina and later).
      // swift is always present on macOS with Xcode CLI tools.
      try {
        const { execFileSync } = require('child_process');
        execFileSync('which', ['swift'], { timeout: 3000, stdio: 'pipe' });
        this.available = fs.existsSync(MAC_OCR_SCRIPT);
        if (this.available) {
          console.log('[OCR] macOS Vision framework available via Swift');
        }
      } catch {
        this.available = false;
      }
      return this.available;
    }

    if (process.platform === 'linux') {
      // Linux: Tesseract OCR via Python script.
      // Requires: sudo apt install tesseract-ocr && python3
      try {
        const { execFileSync } = require('child_process');
        execFileSync('which', ['tesseract'], { timeout: 3000, stdio: 'pipe' });
        execFileSync('which', ['python3'], { timeout: 3000, stdio: 'pipe' });
        this.available = fs.existsSync(LINUX_OCR_SCRIPT);
        if (this.available) {
          console.log('[OCR] Linux Tesseract OCR available');
        }
      } catch {
        this.available = false;
      }
      return this.available;
    }

    this.available = false;
    return false;
  }

  /**
   * Invalidate the cached OCR result.
   * Call after any action execution so the next read is fresh.
   */
  invalidateCache(): void {
    this.cachedResult = null;
    this.cacheTimestamp = 0;
  }

  /**
   * OCR the entire screen. Returns cached result if within 300ms window.
   * Never throws — returns EMPTY_RESULT on failure and degrades gracefully.
   */
  async recognizeScreen(): Promise<OcrResult> {
    if (!this.isAvailable()) return { ...EMPTY_RESULT };

    // Return cached if fresh
    const now = Date.now();
    if (this.cachedResult && (now - this.cacheTimestamp) < CACHE_TTL_MS) {
      return this.cachedResult;
    }

    const start = Date.now();
    try {
      // The working monitor via the bridge (Windows, non-primary); otherwise a
      // full-resolution nut-js grab (grim on Wayland) of the primary.
      const shot = await bridgeCapture();
      let pngBuffer: Buffer;
      if (shot) {
        pngBuffer = shot.png;
      } else {
        const img = await this.grab();
        if (!this.cachedResult) {
          // Log image dimensions on first capture to diagnose coordinate space issues
          console.log(`[OCR] Screenshot captured: ${img.width}x${img.height}px`);
        }
        pngBuffer = await sharpFromGrab(img).png().toBuffer();
        // Release the raw RGBA buffer immediately after processing
        (img as any).data = null;
      }

      // Save to temp file — OS OCR reads from disk
      const tmpPath = path.join(os.tmpdir(), `clawdcursor-ocr-${process.pid}-${crypto.randomUUID().slice(0, 8)}.png`);
      fs.writeFileSync(tmpPath, pngBuffer);

      try {
        const result = await this.runOcr(tmpPath);
        result.durationMs = Date.now() - start;
        // Back to virtual-desktop coordinates when another monitor was read.
        if (shot) for (const el of result.elements) { el.x += shot.x; el.y += shot.y; }

        // Cache
        this.cachedResult = result;
        this.cacheTimestamp = Date.now();

        return result;
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* non-fatal */ }
      }
    } catch (err: any) {
      console.error(`[OCR] recognizeScreen failed: ${err?.message}`);
      // If the first call ever fails because the ENGINE is missing (no
      // binary, no language pack), mark unavailable so the pipeline degrades
      // to vision. A transient failure (script parse error, timeout, bad
      // frame) must NOT latch — on Linux a one-off tesseract TSV parse error
      // used to make every later call return "OCR is not available" forever.
      if (this.cachedResult === null && isEngineMissing(err)) {
        this.available = false;
      }
      return { ...EMPTY_RESULT, durationMs: Date.now() - start };
    }
  }

  /**
   * OCR a rectangular region of the screen.
   * Coordinates are in real screen pixels (input and output).
   * Never throws.
   */
  async recognizeRegion(x: number, y: number, w: number, h: number): Promise<OcrResult> {
    if (!this.isAvailable()) return { ...EMPTY_RESULT };

    const start = Date.now();
    try {
      // Windows: the exact rect on whichever monitor it is on.
      const shot = await bridgeCapture({ x, y, width: w, height: h });
      if (shot) {
        const tmp = path.join(os.tmpdir(), `clawdcursor-ocr-region-${process.pid}-${crypto.randomUUID().slice(0, 8)}.png`);
        fs.writeFileSync(tmp, shot.png);
        try {
          const result = await this.runOcr(tmp);
          result.durationMs = Date.now() - start;
          for (const el of result.elements) { el.x += shot.x; el.y += shot.y; }
          return result;
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* non-fatal */ }
        }
      }

      const img = await this.grab();

      // Clamp to screen bounds
      const rx = Math.max(0, Math.min(x, img.width - 1));
      const ry = Math.max(0, Math.min(y, img.height - 1));
      const rw = Math.min(w, img.width - rx);
      const rh = Math.min(h, img.height - ry);

      const pngBuffer = await sharpFromGrab(img)
        .extract({ left: rx, top: ry, width: rw, height: rh })
        .png()
        .toBuffer();
      // Release the raw RGBA buffer immediately after processing
      (img as any).data = null;

      const tmpPath = path.join(os.tmpdir(), `clawdcursor-ocr-region-${process.pid}-${crypto.randomUUID().slice(0, 8)}.png`);
      fs.writeFileSync(tmpPath, pngBuffer);

      try {
        const result = await this.runOcr(tmpPath);
        result.durationMs = Date.now() - start;

        // Offset coordinates back to full-screen space
        for (const el of result.elements) {
          el.x += rx;
          el.y += ry;
        }

        return result;
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* non-fatal */ }
      }
    } catch (err: any) {
      console.error(`[OCR] recognizeRegion failed: ${err?.message}`);
      return { ...EMPTY_RESULT, durationMs: Date.now() - start };
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Full-screen grab — grim on Wayland, where nut-js would crash the process (see wayland-screen.ts). */
  private grab(): Promise<GrabImage> {
    return isWaylandSession() ? grimGrab() : screen.grab();
  }

  /**
   * Dispatch to the platform-specific OCR implementation.
   */
  private async runOcr(imagePath: string): Promise<OcrResult> {
    if (process.platform === 'win32') {
      return this.runWindowsOcr(imagePath);
    }
    if (process.platform === 'darwin') {
      return this.runMacOcr(imagePath);
    }
    if (process.platform === 'linux') {
      return this.runLinuxOcr(imagePath);
    }
    return { ...EMPTY_RESULT };
  }

  /**
   * Windows: spawn PowerShell to invoke Windows.Media.Ocr WinRT API.
   * The script outputs a single JSON line with { elements, fullText }.
   */
  private async runWindowsOcr(imagePath: string): Promise<OcrResult> {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', OCR_SCRIPT,
      imagePath,
    ], {
      timeout: OCR_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('PowerShell OCR script returned empty output');
    }

    // Sanitize control characters that PowerShell's ConvertTo-Json may leave unescaped
    // (e.g. bell \x07 from OCR'd icons). Keep \t, \n, \r which are valid in JSON.
    // eslint-disable-next-line no-control-regex -- intentional: sanitize control chars that PowerShell's ConvertTo-Json may leave unescaped
    const sanitized = trimmed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    const data = JSON.parse(sanitized);
    if (data.error) {
      throw new Error(data.error);
    }

    const rawElements = Array.isArray(data.elements) ? data.elements : [];
    const elements: OcrElement[] = rawElements.map((el: Record<string, unknown>) => ({
      text:       String(el.text ?? ''),
      x:          Number(el.x) || 0,
      y:          Number(el.y) || 0,
      width:      Number(el.width) || 0,
      height:     Number(el.height) || 0,
      confidence: Number(el.confidence) || 0,
      line:       Number(el.line) || 0,
    }));

    return {
      elements,
      fullText: String(data.fullText ?? ''),
      durationMs: 0, // filled by caller
    };
  }

  /**
   * macOS: run Swift script that uses Apple Vision framework (VNRecognizeTextRequest).
   * Requires macOS 10.15+ and Xcode command-line tools (swift).
   * The script outputs a single JSON line with { elements, fullText }.
   */
  private async runMacOcr(imagePath: string): Promise<OcrResult> {
    const { stdout } = await execFileAsync('swift', [
      MAC_OCR_SCRIPT,
      imagePath,
    ], {
      timeout: MAC_OCR_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    });

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Swift OCR script returned empty output');
    }

    const data = JSON.parse(trimmed);
    if (data.error) {
      throw new Error(data.error);
    }

    return this.parseOcrJson(data);
  }

  /**
   * Linux: run Python script that uses Tesseract OCR.
   * Requires: tesseract-ocr package + python3.
   * The script outputs a single JSON line with { elements, fullText }.
   */
  private async runLinuxOcr(imagePath: string): Promise<OcrResult> {
    // Tesseract misses small UI labels at native size (it found no text at
    // all on a 1080p desktop). Upscale 2x; the script divides the boxes back.
    const scaledPath = imagePath.replace(/\.png$/i, '') + '-2x.png';
    let stdout: string;
    try {
      const meta = await sharp(imagePath).metadata();
      await sharp(imagePath).resize((meta.width ?? 0) * LINUX_OCR_UPSCALE, null, { kernel: 'lanczos3' }).toFile(scaledPath);
      ({ stdout } = await execFileAsync('python3', [
        LINUX_OCR_SCRIPT,
        scaledPath,
        String(LINUX_OCR_UPSCALE),
      ], {
        timeout: LINUX_OCR_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      }));
    } finally {
      try { fs.unlinkSync(scaledPath); } catch { /* non-fatal */ }
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Python OCR script returned empty output');
    }

    const data = JSON.parse(trimmed);
    if (data.error) {
      throw new Error(data.error);
    }

    return this.parseOcrJson(data);
  }

  /**
   * Shared JSON parser for macOS/Linux OCR output.
   * Both scripts emit the same { elements, fullText } format.
   */
  private parseOcrJson(data: Record<string, unknown>): OcrResult {
    const rawElements = Array.isArray(data.elements) ? data.elements : [];
    const elements: OcrElement[] = rawElements.map((el: Record<string, unknown>) => ({
      text:       String(el.text ?? ''),
      x:          Number(el.x) || 0,
      y:          Number(el.y) || 0,
      width:      Number(el.width) || 0,
      height:     Number(el.height) || 0,
      confidence: Number(el.confidence) || 0,
      line:       Number(el.line) || 0,
    }));

    return {
      elements,
      fullText: String(data.fullText ?? ''),
      durationMs: 0, // filled by caller
    };
  }
}
