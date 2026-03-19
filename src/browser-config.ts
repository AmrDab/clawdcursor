/**
 * Browser Configuration — centralised helpers for browser detection and CDP port.
 *
 * All files that need to know which browser processes to match, what CDP port
 * to connect to, or where the browser executable lives should import from here
 * instead of hardcoding values.
 */

import type { ClawdConfig } from './types';

export const DEFAULT_CDP_PORT = 9222;
const DEFAULT_BROWSER_PROCESSES = ['msedge', 'chrome', 'chromium', 'firefox', 'brave', 'opera', 'arc', 'safari'];

/** Get configured browser executable path, or null for auto-detection */
export function getBrowserExePath(config?: ClawdConfig): string | null {
  return config?.browser?.executablePath || null;
}

/** Get list of browser process names to match against */
export function getBrowserProcessNames(config?: ClawdConfig): string[] {
  if (config?.browser?.processName) {
    return [config.browser.processName, ...DEFAULT_BROWSER_PROCESSES];
  }
  return DEFAULT_BROWSER_PROCESSES;
}

/** Get CDP debugging port */
export function getCDPPort(config?: ClawdConfig): number {
  return config?.browser?.cdpPort || DEFAULT_CDP_PORT;
}

/** Build a regex matching browser process names */
export function getBrowserProcessRegex(config?: ClawdConfig): RegExp {
  const names = getBrowserProcessNames(config);
  return new RegExp(names.join('|'), 'i');
}
