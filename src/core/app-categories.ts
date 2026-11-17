/**
 * App categorization data. Read by telemetry (`appKind` in observability/telemetry.ts) to tag an app as
 * 'electron'. src/tools/electron_bridge.ts keeps its own KNOWN_APPS fingerprints for the CDP bridge.
 */

/**
 * Apps that render their UI inside Chromium / Edge WebView2 / Electron.
 * For these the OS-level UI Automation tree is sparse — clawdcursor may
 * need to attach via CDP (`relaunch_with_cdp`) to read the real DOM.
 *
 * Matched as whole words, case-insensitive (see buildAppRegex).
 */
export const WEBVIEW2_APPS: readonly string[] = [
  'olk',       // Microsoft New Outlook (Win11)
  'outlook',
  'teams',     // Microsoft Teams
  'slack',
  'discord',
  'spotify',
  'vscode',    // VS Code
  'code',      // VS Code on macOS / Linux
  'obsidian',
  'notion',
];

/**
 * Build a case-insensitive regex from a list of substring patterns.
 *
 * Word-boundary `\b` is used so we don't false-match (`signal` doesn't
 * match `signaling`).
 */
export function buildAppRegex(patterns: readonly string[]): RegExp {
  const alt = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}

/** Convenience: regex form of {@link WEBVIEW2_APPS}. */
export const WEBVIEW2_APPS_PATTERN: RegExp = buildAppRegex(WEBVIEW2_APPS);
