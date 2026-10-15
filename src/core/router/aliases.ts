/**
 * APP_ALIASES — the 40-app, 3-OS canonical app table.
 *
 * Ported verbatim from src/action-router.ts (v0.6.3 heritage). Each row
 * maps a user-facing natural-language name to the set of actual process
 * names on each OS plus the macOS app bundle name.
 *
 * Adding an app = one row here, nothing else. No business-logic file
 * should reference raw process names — they go through this table.
 */

import { normalizeAppName } from './normalize';

export interface AppAlias {
  /** Process names to look for when checking "is this app running?". */
  processNames: string[];
  /** Human-friendly search term for UIA-tree search (window title matching). */
  searchTerm: string;
  /** macOS app bundle name for `open -a`. */
  macOSAppName?: string;
  /** Windows fallback exe, used when Start-Process can't find by name. */
  executable?: string;
  /**
   * Windows UWP AppsFolder ID (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`).
   * When present, the launcher uses `explorer.exe shell:AppsFolder\<id>` which
   * works reliably for Store / UWP apps where `Start-Process -FilePath <exe>`
   * silently fails. If omitted, the launcher falls back to Start Menu search,
   * which is slower but universal.
   */
  uwpAppId?: string;
  /**
   * If true, the user typically wants a FRESH instance (mspaint: new
   * canvas, notepad: new document). Launch with -n on macOS, or by
   * executable path on Windows.
   */
  alwaysNewInstance?: boolean;
}

export const APP_ALIASES: Record<string, AppAlias> = {
  // Drawing / editors
  'paint':              { processNames: ['mspaint'],                          searchTerm: 'Paint',              executable: 'mspaint.exe', alwaysNewInstance: true },
  'mspaint':            { processNames: ['mspaint'],                          searchTerm: 'Paint',              executable: 'mspaint.exe', alwaysNewInstance: true },
  // Notepad is UWP on Win11 (Microsoft.WindowsNotepad). The classic
  // `notepad.exe` redirector still exists but spawns the UWP app via
  // ApplicationFrameHost, so the polled window has processName "Notepad"
  // not "notepad.exe". uwpAppId is the reliable Win11 launch route.
  'notepad':            { processNames: ['Notepad', 'notepad', 'ApplicationFrameHost'], searchTerm: 'Notepad',  executable: 'notepad.exe', uwpAppId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', alwaysNewInstance: true, macOSAppName: 'TextEdit' },
  'textedit':           { processNames: ['TextEdit'],                         searchTerm: 'TextEdit',           macOSAppName: 'TextEdit' },

  // Utility (Windows Calculator is UWP on Win10+; direct `Start-Process calc` fails)
  'calculator':         { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator',      macOSAppName: 'Calculator', uwpAppId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  'calc':               { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator',      macOSAppName: 'Calculator', uwpAppId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },

  // Browsers — executables let the direct-launch strategy fire first on Win32.
  // If the exe isn't on PATH, the router's Start Menu search fallback picks up.
  'chrome':             { processNames: ['chrome', 'Google Chrome'],          searchTerm: 'Chrome',             executable: 'chrome.exe',  macOSAppName: 'Google Chrome' },
  'google chrome':      { processNames: ['chrome', 'Google Chrome'],          searchTerm: 'Chrome',             executable: 'chrome.exe',  macOSAppName: 'Google Chrome' },
  'firefox':            { processNames: ['firefox'],                          searchTerm: 'Firefox',            executable: 'firefox.exe', macOSAppName: 'Firefox' },
  'safari':             { processNames: ['Safari'],                           searchTerm: 'Safari',             macOSAppName: 'Safari' },
  'edge':               { processNames: ['msedge'],                           searchTerm: 'Edge',               executable: 'msedge.exe',  macOSAppName: 'Microsoft Edge' },
  'microsoft edge':     { processNames: ['msedge'],                           searchTerm: 'Edge',               executable: 'msedge.exe',  macOSAppName: 'Microsoft Edge' },

  // Office
  'outlook':            { processNames: ['OUTLOOK', 'olk'],                   searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'microsoft outlook':  { processNames: ['OUTLOOK', 'olk'],                   searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'word':               { processNames: ['WINWORD'],                          searchTerm: 'Word',               macOSAppName: 'Microsoft Word' },
  'excel':              { processNames: ['EXCEL'],                            searchTerm: 'Excel',              macOSAppName: 'Microsoft Excel' },

  // Shell
  'explorer':           { processNames: ['explorer'],                         searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'finder':             { processNames: ['Finder'],                           searchTerm: 'Finder',             macOSAppName: 'Finder' },
  'file explorer':      { processNames: ['explorer'],                         searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'cmd':                { processNames: ['cmd'],                              searchTerm: 'Command Prompt',     macOSAppName: 'Terminal' },
  'terminal':           { processNames: ['WindowsTerminal', 'cmd', 'Terminal'], searchTerm: 'Terminal',         macOSAppName: 'Terminal' },
  'powershell':         { processNames: ['powershell', 'pwsh'],               searchTerm: 'PowerShell' },

  // Dev tools
  'vscode':             { processNames: ['Code'],                             searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'code':               { processNames: ['Code'],                             searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'cursor':             { processNames: ['Cursor'],                           searchTerm: 'Cursor',             macOSAppName: 'Cursor' },
  'xcode':              { processNames: ['Xcode'],                            searchTerm: 'Xcode',              macOSAppName: 'Xcode' },
  'wezterm':            { processNames: ['WezTerm', 'wezterm'],               searchTerm: 'WezTerm',            macOSAppName: 'WezTerm' },
  'iterm':              { processNames: ['iTerm2', 'iTerm'],                  searchTerm: 'iTerm',              macOSAppName: 'iTerm' },
  'iterm2':             { processNames: ['iTerm2'],                           searchTerm: 'iTerm2',             macOSAppName: 'iTerm' },

  // Settings / system
  // uwpAppId: launch straight through shell:AppsFolder — without it
  // Start-Process 'Settings' failed and the Start-Menu fallback cost ~10 s.
  'settings':           { processNames: ['SystemSettings'],                   searchTerm: 'Settings',           macOSAppName: 'System Settings', uwpAppId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' },
  'system settings':    { processNames: ['System Preferences', 'System Settings'], searchTerm: 'System Settings', macOSAppName: 'System Settings' },
  'task manager':       { processNames: ['Taskmgr'],                          searchTerm: 'Task Manager',       macOSAppName: 'Activity Monitor' },
  'activity monitor':   { processNames: ['Activity Monitor'],                 searchTerm: 'Activity Monitor',   macOSAppName: 'Activity Monitor' },

  // Collab / comms
  'figma':              { processNames: ['Figma'],                            searchTerm: 'Figma',              macOSAppName: 'Figma' },
  'slack':              { processNames: ['Slack', 'slack'],                   searchTerm: 'Slack',              macOSAppName: 'Slack' },
  'teams':              { processNames: ['ms-teams', 'Teams'],                searchTerm: 'Teams',              macOSAppName: 'Microsoft Teams' },
  'discord':            { processNames: ['Discord'],                          searchTerm: 'Discord',            macOSAppName: 'Discord' },

  // Media
  'spotify':            { processNames: ['Spotify'],                          searchTerm: 'Spotify',            macOSAppName: 'Spotify' },

  // Apple native
  'notes':              { processNames: ['Notes'],                            searchTerm: 'Notes',              macOSAppName: 'Notes' },
  'mail':               { processNames: ['Mail'],                             searchTerm: 'Mail',               macOSAppName: 'Mail' },
};

/**
 * Resolve a user-facing app name to its alias row. Goes through
 * `normalizeAppName` first so phrasings like "the Outlook app",
 * "Edge browser", or '"chrome"' all match the same canonical key as
 * the bare app name. Returns null for unknown apps — caller should
 * fall back to `launchApp(name)` with the raw string.
 *
 * This is the single choke point for "name → alias row". Every caller
 * (router, agent's `open_app`, MCP `mcp__clawdcursor__window`, REST
 * `/execute`) hits this function, so adding normalization here means
 * we don't have to push the same logic into every entry point.
 */
export function resolveAlias(name: string): (AppAlias & { key: string }) | null {
  const k = normalizeAppName(name);
  if (!k) return null;
  // Try the normalized form first.
  let hit = APP_ALIASES[k];
  // Fallback: if the user's literal phrase was multi-word with a filler
  // suffix that took it back below an alias key (e.g. "music app" → "music"
  // → no alias), try the un-normalized form too. Cheap and only fires
  // when normalization didn't help.
  if (!hit) {
    const literal = name.trim().toLowerCase().replace(/['"`‘’“”]/g, '');
    if (literal !== k) hit = APP_ALIASES[literal];
  }
  if (!hit) return null;
  return { key: k, ...hit };
}
