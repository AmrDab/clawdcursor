/**
 * The one raw full-screen grab that screenshots and OCR end in. grim on Wayland, where nut-js would take the process down
 * (wayland-screen.ts). On macOS only once Screen Recording is confirmed: without it a nut-js grab does not fail, it
 * returns the wallpaper and menu bar, which read as a real but stale screen (#276).
 */
import * as fs from 'fs';
import sharp from 'sharp';
import { screen } from '@nut-tree-fork/nut-js';
import type { GrabImage } from './grab-image';
import { beforeCapture } from './pointer-guard';
import { isWaylandSession, grimGrab } from './wayland-screen';
import { assertScreenRecordingGranted, captureScreenViaHelper, ScreenRecordingDeniedError } from './native-helper';

export async function rawScreenGrab(): Promise<GrabImage> {
  await beforeCapture(); // clawdcursor's own pill is never part of a capture
  await assertScreenRecordingGranted();
  return isWaylandSession() ? grimGrab() : screen.grab();
}

/**
 * macOS: the full screen through the screenshot helper (ScreenCaptureKit, in the ClawdCursor app bundle), as RGBA pixels.
 * It is the capture `computer screenshot` uses, under the helper's own Screen Recording grant. A nut-js grab runs inside
 * node and needs node's grant (or its host app's), which a Mac may not have: OCR failed with "Failed to capture screen"
 * while screenshots worked (Mac, 2026-11-17). Null elsewhere, and when the helper is missing or fails for another reason
 * than the permission: the caller then grabs with nut-js. A permission refusal is final, since a nut-js grab would return
 * the wallpaper (#276).
 */
export async function helperScreenGrab(): Promise<GrabImage | null> {
  if (process.platform !== 'darwin') return null;
  await beforeCapture();
  let file: string | undefined;
  try {
    file = (await captureScreenViaHelper()).path;
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: 4, colorMode: 1 };
  } catch (err) {
    if (err instanceof ScreenRecordingDeniedError) throw err;
    return null;
  } finally {
    if (file) try { fs.unlinkSync(file); } catch { /* a temp file */ }
  }
}
