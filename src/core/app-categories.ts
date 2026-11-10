/**
 * App categorization data — the single source of truth for app-pattern
 * matching across clawdcursor.
 *
 * Why this file exists. v0.9's agnostic-audit subagent flagged
 * places where app-specific patterns were inlined as regexes deep inside
 * other modules:
 *   - src/core/router/webview2.ts hardcoded the WebView2 settle list
 *   - src/tools/electron_bridge.ts had its own KNOWN_APPS array
 *
 * Each of those was small, but together they meant "the list of apps
 * clawdcursor knows about" was scattered across three files in three
 * directories. Adding a new app required changing code in N places and
 * was easy to miss.
 *
 * This module consolidates the app-data so:
 *   - Categorization decisions live next to one another.
 *   - The agent loop / pipeline never imports this file — only the
 *     small helper modules that need to make a categorization call do.
 *   - Adding a new app means editing one row in one file.
 *
 * Anti-design note. This file is intentionally not exported from any
 * index. Importers reach in explicitly so it's clear at the call-site
 * that they're consulting app-category data, not running app-specific
 * logic. The autonomous pipeline (agent loop, decomposer, verifier,
 * preprocessor) does NOT import from here and never should — those
 * components stay model- and app-agnostic by construction.
 */

/**
 * Apps that render their UI inside Chromium / Edge WebView2 / Electron.
 * For these the OS-level UI Automation tree is sparse — clawdcursor needs
 * a longer settle window after launch and may need to attach via CDP
 * (`relaunch_with_cdp`) to read the real DOM.
 *
 * Matched against process name OR alias name (case-insensitive substring).
 * Adding a new app here is the only change needed to give it the longer
 * WebView2 settle treatment.
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
 * Used by callers that need the regex form (the webview2 helper
 * `.test()`s a process name).
 *
 * Word-boundary `\b` is used so we don't false-match (`mail` inside
 * `gmail` is fine because both are listed; but `signal` doesn't match
 * `signaling`).
 */
export function buildAppRegex(patterns: readonly string[]): RegExp {
  const alt = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}

/** Convenience: regex form of {@link WEBVIEW2_APPS}. */
export const WEBVIEW2_APPS_PATTERN: RegExp = buildAppRegex(WEBVIEW2_APPS);
