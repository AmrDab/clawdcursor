/**
 * Platform factory — returns the right adapter for the current OS.
 *
 * Use this everywhere instead of `if (process.platform === 'darwin')`.
 */

import type { PlatformAdapter } from './types';
import { guardInputMethods } from './pointer-guard';

let cached: PlatformAdapter | null = null;

/** Get (and lazily construct) the PlatformAdapter for the current OS. */
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
  cached = guardInputMethods(adapter);
  return adapter;
}

/** For tests: reset the cache so a fresh adapter can be created. */
export function _resetPlatformCache(): void {
  cached = null;
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
