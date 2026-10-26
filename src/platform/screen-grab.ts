/**
 * The one raw full-screen grab that screenshots and OCR end in. grim on Wayland, where nut-js would take the process down
 * (wayland-screen.ts). On macOS only once Screen Recording is confirmed: without it a nut-js grab does not fail, it
 * returns the wallpaper and menu bar, which read as a real but stale screen (#276).
 */
import { screen } from '@nut-tree-fork/nut-js';
import type { GrabImage } from './grab-image';
import { beforeCapture } from './pointer-guard';
import { isWaylandSession, grimGrab } from './wayland-screen';
import { assertScreenRecordingGranted } from './native-helper';

export async function rawScreenGrab(): Promise<GrabImage> {
  await beforeCapture(); // clawdcursor's own pill is never part of a capture
  await assertScreenRecordingGranted();
  return isWaylandSession() ? grimGrab() : screen.grab();
}
