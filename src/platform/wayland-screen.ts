/**
 * Wayland-safe screen access.
 *
 * nut-js (libnut) opens the X11 display for every screen call. On a Wayland
 * session that is fatal in two ways neither of which can be caught from JS:
 *   - no DISPLAY (no XWayland): "Could not open main display" → SIGSEGV.
 *   - rootless XWayland (GNOME/KDE): root-window XGetImage is a BadMatch and
 *     Xlib's default error handler calls exit().
 * So on Wayland nothing may touch nut-js screen APIs; this module is the
 * replacement: `grim` (wlroots) for pixels, swaymsg / wlr-randr / xrandr for
 * geometry, and an honest error when neither is available.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import type { GrabImage } from './grab-image';

const execFileAsync = promisify(execFile);
const TOOL_TIMEOUT_MS = 3_000;
const GRIM_TIMEOUT_MS = 10_000;
const GRIM_MAX_BUFFER = 64 * 1024 * 1024; // 4K PNG is well under this

/**
 * Detect Linux display server. Wayland reports itself via `XDG_SESSION_TYPE`
 * or `WAYLAND_DISPLAY`. Anything else is treated as X11.
 */
export function detectLinuxEnvironment(): 'wayland' | 'x11' {
  const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  if (sessionType === 'wayland') return 'wayland';
  if (sessionType === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  return 'x11';
}

export function isWaylandSession(): boolean {
  return process.platform === 'linux' && detectLinuxEnvironment() === 'wayland';
}

export const GRIM_MISSING_MESSAGE =
  'Screenshots on this Wayland compositor need grim (wlroots: sway, Hyprland, river) — ' +
  'install it, or log in to an X11 session. GNOME/KDE need xdg-desktop-portal, which ' +
  'clawdcursor does not drive yet.';

export interface WaylandScreenSize {
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
}

/**
 * Screen geometry without X11: swaymsg (sway) → wlr-randr (any wlroots) →
 * xrandr (XWayland). Returns null when none of them answers.
 */
export async function waylandScreenSize(): Promise<WaylandScreenSize | null> {
  try {
    const { stdout } = await execFileAsync('swaymsg', ['-t', 'get_outputs', '-r'], { timeout: TOOL_TIMEOUT_MS });
    const outputs = JSON.parse(stdout) as Array<{
      active?: boolean; focused?: boolean;
      rect?: { width: number; height: number };
      current_mode?: { width: number; height: number };
    }>;
    const out = outputs.find(o => o.focused) ?? outputs.find(o => o.active !== false);
    if (out?.rect?.width && out.rect.height) {
      return {
        logicalWidth: out.rect.width,
        logicalHeight: out.rect.height,
        physicalWidth: out.current_mode?.width || out.rect.width,
        physicalHeight: out.current_mode?.height || out.rect.height,
      };
    }
  } catch { /* not sway */ }

  try {
    const { stdout } = await execFileAsync('wlr-randr', [], { timeout: TOOL_TIMEOUT_MS });
    const mode = stdout.match(/(\d+)x(\d+)\s+px[^\n]*current/);
    const scale = parseFloat(stdout.match(/Scale:\s*([\d.]+)/)?.[1] ?? '1') || 1;
    if (mode) {
      const pw = parseInt(mode[1], 10);
      const ph = parseInt(mode[2], 10);
      return {
        logicalWidth: Math.round(pw / scale),
        logicalHeight: Math.round(ph / scale),
        physicalWidth: pw,
        physicalHeight: ph,
      };
    }
  } catch { /* no wlr-randr */ }

  try {
    const { stdout } = await execFileAsync('xrandr', ['--query'], { timeout: TOOL_TIMEOUT_MS });
    const m = stdout.match(/\bconnected\s+primary\s+(\d+)x(\d+)/) ?? stdout.match(/\bconnected(?:\s+primary)?\s+(\d+)x(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      return { logicalWidth: w, logicalHeight: h, physicalWidth: w, physicalHeight: h };
    }
  } catch { /* no XWayland */ }

  return null;
}

/**
 * Capture via grim and decode to the same shape nut-js hands us (RGBA,
 * `colorMode` 1 = RGB, opaque) so every capture pipeline is unchanged.
 * `region` is in compositor (logical) coordinates.
 */
export async function grimGrab(region?: { x: number; y: number; width: number; height: number }): Promise<GrabImage> {
  const args = region ? ['-g', `${region.x},${region.y} ${region.width}x${region.height}`, '-'] : ['-'];
  let png: Buffer;
  try {
    const { stdout } = await execFileAsync('grim', args, {
      timeout: GRIM_TIMEOUT_MS,
      maxBuffer: GRIM_MAX_BUFFER,
      encoding: 'buffer',
    });
    png = stdout;
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(GRIM_MISSING_MESSAGE, { cause: err });
    throw new Error(`grim failed: ${String(err?.stderr || err?.message || err).trim()}`, { cause: err });
  }
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4, colorMode: 1 };
}
