/**
 * Platform factory — returns the right adapter for the current OS.
 *
 * Use this everywhere instead of `if (process.platform === 'darwin')`.
 */

import { fencePlatform } from '../core/fence';
import type { PlatformAdapter } from './types';
import { guardInputMethods } from './pointer-guard';

let cached: PlatformAdapter | null = null;

export async function getPlatform(): Promise<PlatformAdapter> {
  if (cached) return cached;

  let adapter: PlatformAdapter;
  if (process.platform === 'darwin') {
    const { MacOSAdapter } = await import('./macos');
    adapter = new MacOSAdapter();
  } else if (process.platform === 'win32') {
    const { WindowsAdapter } = await import('./windows');
    adapter = new WindowsAdapter();
  } else {
    const { LinuxAdapter } = await import('./linux');
    adapter = new LinuxAdapter();
  }

  await adapter.init();
  // The test fence (core/fence.ts): the window list holds fenced windows only. Unset, the adapter is untouched.
  cached = fencePlatform(guardInputMethods(adapter));
  return cached;
}

export type {
  PlatformAdapter,
  ScreenSize,
  ScreenshotResult,
  WindowInfo,
  UiElement,
  PermissionStatus,
  PortableKeyCombo,
} from './types';
