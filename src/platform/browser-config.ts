/**
 * Browser Configuration — centralised helpers for browser detection and CDP port.
 *
 * All files that need to know which browser processes to match, what CDP port
 * to connect to, or where the browser executable lives should import from here
 * instead of hardcoding values.
 */

export const DEFAULT_CDP_PORT = 9223;

/**
 * Port for the AGENT-OWNED dedicated browser instance (the one CDPDriver
 * launches itself with `--user-data-dir=~/.clawdcursor/cdp-profile`).
 *
 * Deliberately DIFFERENT from DEFAULT_CDP_PORT (9223): ownership is encoded in
 * the port. 9223 is reserved for browsers the USER put on the wire (their own
 * launch flags, `relaunch_with_cdp`, the browser relay) — attaching there means
 * "driving the user's session" and gets new-tab discipline. Sharing one port
 * for both meant the driver could not tell its own instance from the user's:
 * whoever squatted 9223 won, and a lingering agent instance the user adopted
 * (music, browsing) got its tabs hijacked (root-cause fix 2026-06-11).
 */
export const AGENT_CDP_PORT = Number(process.env.CLAWD_AGENT_CDP_PORT ?? '') || 9333;

const DEFAULT_BROWSER_PROCESSES = ['msedge', 'chrome', 'chromium', 'firefox', 'brave', 'opera', 'arc', 'safari'];

/** Get list of browser process names to match against */
export function getBrowserProcessNames(): string[] {
  return DEFAULT_BROWSER_PROCESSES;
}

/**
 * Is this process a web browser? Matches the bare executable name ("chrome",
 * "msedge.exe") and macOS's app display names ("Google Chrome", "Microsoft
 * Edge", "Brave Browser"), which an exact match against the list missed.
 */
export function isBrowserProcess(name: string | undefined | null): boolean {
  const n = String(name ?? '').toLowerCase().replace(/\.exe$/, '').trim();
  if (!n) return false;
  const names = getBrowserProcessNames().map(s => s.toLowerCase());
  if (names.includes(n)) return true;
  return n.split(/\s+/).some(w => names.includes(w) || w === 'edge');
}

const PLATFORM = process.platform;

/** Get default Chrome executable paths for the current platform */
export function getChromePaths(): string[] {
  if (PLATFORM === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (PLATFORM === 'linux') return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
}

/** Get default Edge executable paths for the current platform */
export function getEdgePaths(): string[] {
  if (PLATFORM === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  if (PLATFORM === 'linux') return ['/usr/bin/microsoft-edge'];
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
}

/**
 * Attach/launch policy for the agent's browser, shared by EVERY tool that brings
 * one up (browser_connect / cdp_connect and navigate_browser). One policy means
 * one instance: navigate and connect land on the same driver, port and page.
 * CLAWD_AGENT_CDP_OFF=1 → attach-only (never launch a new instance).
 */
export function agentBrowserConnectOptions(): { launch: boolean; exePaths: string[] } {
  const launch = !/^(1|true)$/i.test(process.env.CLAWD_AGENT_CDP_OFF ?? '');
  return { launch, exePaths: [...getEdgePaths(), ...getChromePaths()] };
}
