/**
 * Action Router — intercepts common tasks and handles them
 * WITHOUT any LLM call using accessibility + native desktop.
 *
 * This is the core optimization: most desktop tasks follow predictable
 * patterns that don't need vision AI to execute.
 */

import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { AccessibilityBridge } from './accessibility';
import { NativeDesktop } from './native-desktop';
import { normalizeKey } from './keys';
import { findShortcut } from './shortcuts';
import type { WindowInfo } from './accessibility';
import { getBrowserProcessNames, getCDPPort, getBrowserExePath } from './browser-config';

const execFileAsync = promisify(execFile);

const PLATFORM = os.platform();

export interface RouteResult {
  handled: boolean;
  description: string;
  error?: string;
}


export interface RouterTelemetry {
  totalRequests: number;
  shortcutHits: number;
  shortcutFuzzyHits: number;
  nonShortcutHandled: number;
  llmFallbacks: number;
}

/**
 * Known app aliases → process names / Start Menu search terms
 */
const APP_ALIASES: Record<string, { processNames: string[]; searchTerm: string; macOSAppName?: string }> = {
  'paint':        { processNames: ['mspaint'],              searchTerm: 'Paint' },
  'mspaint':      { processNames: ['mspaint'],              searchTerm: 'Paint' },
  'notepad':      { processNames: ['notepad', 'Notepad'],   searchTerm: 'Notepad',            macOSAppName: 'TextEdit' },
  'calculator':   { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator', macOSAppName: 'Calculator' },
  'calc':         { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator', macOSAppName: 'Calculator' },
  'chrome':       { processNames: ['chrome', 'Google Chrome'], searchTerm: 'Chrome',          macOSAppName: 'Google Chrome' },
  'google chrome': { processNames: ['chrome', 'Google Chrome'], searchTerm: 'Chrome',         macOSAppName: 'Google Chrome' },
  'firefox':      { processNames: ['firefox'],              searchTerm: 'Firefox',            macOSAppName: 'Firefox' },
  'safari':       { processNames: ['Safari'],               searchTerm: 'Safari',             macOSAppName: 'Safari' },
  'edge':         { processNames: ['msedge'],               searchTerm: 'Edge',               macOSAppName: 'Microsoft Edge' },
  'microsoft edge': { processNames: ['msedge'],            searchTerm: 'Edge',               macOSAppName: 'Microsoft Edge' },
  'outlook':      { processNames: ['OUTLOOK', 'olk'],       searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'microsoft outlook': { processNames: ['OUTLOOK', 'olk'],  searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'explorer':     { processNames: ['explorer'],             searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'finder':       { processNames: ['Finder'],               searchTerm: 'Finder',             macOSAppName: 'Finder' },
  'file explorer': { processNames: ['explorer'],            searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'cmd':          { processNames: ['cmd'],                  searchTerm: 'Command Prompt',     macOSAppName: 'Terminal' },
  'terminal':     { processNames: ['WindowsTerminal', 'cmd', 'Terminal'], searchTerm: 'Terminal', macOSAppName: 'Terminal' },
  'powershell':   { processNames: ['powershell', 'pwsh'],   searchTerm: 'PowerShell' },
  'word':         { processNames: ['WINWORD'],              searchTerm: 'Word',               macOSAppName: 'Microsoft Word' },
  'excel':        { processNames: ['EXCEL'],                searchTerm: 'Excel',              macOSAppName: 'Microsoft Excel' },
  'vscode':       { processNames: ['Code'],                 searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'code':         { processNames: ['Code'],                 searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'settings':     { processNames: ['SystemSettings'],       searchTerm: 'Settings',           macOSAppName: 'System Settings' },
  'system settings': { processNames: ['System Preferences', 'System Settings'], searchTerm: 'System Settings', macOSAppName: 'System Settings' },
  'task manager':  { processNames: ['Taskmgr'],             searchTerm: 'Task Manager',       macOSAppName: 'Activity Monitor' },
  'activity monitor': { processNames: ['Activity Monitor'], searchTerm: 'Activity Monitor',   macOSAppName: 'Activity Monitor' },
  'figma':        { processNames: ['Figma'],                searchTerm: 'Figma',              macOSAppName: 'Figma' },
  'spotify':      { processNames: ['Spotify'],              searchTerm: 'Spotify',            macOSAppName: 'Spotify' },
  'slack':        { processNames: ['Slack', 'slack'],       searchTerm: 'Slack',              macOSAppName: 'Slack' },
  'teams':        { processNames: ['ms-teams', 'Teams'],    searchTerm: 'Teams',              macOSAppName: 'Microsoft Teams' },
  'discord':      { processNames: ['Discord'],              searchTerm: 'Discord',            macOSAppName: 'Discord' },
  'codex':        { processNames: ['Codex'],                searchTerm: 'Codex',              macOSAppName: 'Codex' },
  'wezterm':      { processNames: ['WezTerm', 'wezterm'],   searchTerm: 'WezTerm',            macOSAppName: 'WezTerm' },
  'iterm':        { processNames: ['iTerm2', 'iTerm'],      searchTerm: 'iTerm',              macOSAppName: 'iTerm' },
  'iterm2':       { processNames: ['iTerm2'],               searchTerm: 'iTerm2',             macOSAppName: 'iTerm' },
  'cursor':       { processNames: ['Cursor'],               searchTerm: 'Cursor',             macOSAppName: 'Cursor' },
  'notes':        { processNames: ['Notes'],                searchTerm: 'Notes',              macOSAppName: 'Notes' },
  'mail':         { processNames: ['Mail'],                 searchTerm: 'Mail',               macOSAppName: 'Mail' },
  'xcode':        { processNames: ['Xcode'],                searchTerm: 'Xcode',              macOSAppName: 'Xcode' },
};

/** Browser process names for URL navigation */
const BROWSER_PROCESSES = getBrowserProcessNames();

/** Readiness polling config */
const READY_POLL_INTERVAL = 300;  // ms between polls
const READY_TIMEOUT = 8000;       // max ms to wait for app readiness
const READY_SETTLE_MS = 500;      // extra ms after window appears (let UI render)

// WebView2/Electron apps freeze if hit with UIA queries during startup.
// These need longer settle times before any interaction.
const WEBVIEW2_APPS = /\b(olk|outlook|teams|slack|discord|spotify|vscode|code)\b/i;
const WEBVIEW2_SETTLE_MS = 4000;  // 4s settle for WebView2 apps

export class ActionRouter {
  private a11y: AccessibilityBridge;
  private desktop: NativeDesktop;
  private telemetry: RouterTelemetry = {
    totalRequests: 0,
    shortcutHits: 0,
    shortcutFuzzyHits: 0,
    nonShortcutHandled: 0,
    llmFallbacks: 0,
  };

  constructor(a11y: AccessibilityBridge, desktop: NativeDesktop) {
    this.a11y = a11y;
    this.desktop = desktop;
  }

  getTelemetry(): RouterTelemetry {
    return { ...this.telemetry };
  }

  resetTelemetry(): void {
    this.telemetry = {
      totalRequests: 0,
      shortcutHits: 0,
      shortcutFuzzyHits: 0,
      nonShortcutHandled: 0,
      llmFallbacks: 0,
    };
  }

  /**
   * Try to handle a subtask without LLM. Returns { handled: true } if successful.
   */
  async route(subtask: string): Promise<RouteResult> {
    this.telemetry.totalRequests += 1;
    const rawTask = subtask.trim();
    const task = rawTask.toLowerCase();

    // Guard: compound/multi-step tasks should NOT be routed here.
    // Pattern 1: action verb after a separator (comma, "then", "and then")
    //   e.g. "Open Notepad, type hello" or "click OK, then close"
    // Pattern 2: starts with action verb ... "and" ... another action verb
    //   e.g. "open google docs and write a sentence" or "find the file and delete it"
    // Avoids false positives like "click the save button" (save is a label, not a clause start)
    const separatorVerb = /(?:,\s*|\band\s+then\s+|\bthen\s+)\b(open|launch|start|type|click|tap|save|close|find|press|navigate|go to|draw|write|send|create|delete|move|drag|search|download|upload)\b/i;
    const verbAndVerb = /^(open|launch|start|type|click|tap|navigate|go to|find|press)\b.+\band\s+(open|launch|start|type|click|tap|save|close|find|press|navigate|go to|draw|write|send|create|delete|move|drag|search|download|upload)\b/i;
    if (separatorVerb.test(task) || verbAndVerb.test(task)) {
      this.telemetry.llmFallbacks += 1;
      return { handled: false, description: 'Compound task — needs decomposition' };
    }

    // 1. "open [app]" / "launch [app]" / "start [app]"
    const openMatch = rawTask.match(/^(?:open|launch|start|run)\s+(\S.*)$/i);
    if (openMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleOpenApp(openMatch[1].trim());
    }

    // 2. "type [text]" / "type '[text]'" / "enter [text]"
    // NOTE: "write" is excluded — it implies creative composition (needs LLM), not raw typing
    const typeMatch = rawTask.match(/^(?:type|enter|input)\s+(?:['"]([^'"]*)['"]\s*|(\S.*))$/i);
    if (typeMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleType(typeMatch[1] ?? typeMatch[2]);
    }

    // 2b. "save as [filename] [on the desktop / in folder]"
    const saveAsMatch = rawTask.match(/^save\s+as\s+(.+)$/i);
    if (saveAsMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleSaveAs(saveAsMatch[1].trim());
    }

    // 3. "go to [url]" / "navigate to [url]" / "visit [url]"
    const urlMatch = rawTask.match(/^(?:go to|navigate to|visit|browse to|open)\s+(https?:\/\/[^\s]+|www\.[^\s]+|[^\s.]+\.\w{2,}(?:\/[^\s]*)?)$/i);
    if (urlMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleNavigateToUrl(urlMatch[1]);
    }

    // 4. Shortcut registry (natural-language → fast keyboard action)
    const shortcutContext = await this.getShortcutContextHint();
    const shortcutMatch = findShortcut(task, PLATFORM, { contextHint: shortcutContext, enableFuzzy: true });
    if (shortcutMatch) {
      this.telemetry.shortcutHits += 1;
      if (shortcutMatch.matchType === 'fuzzy') this.telemetry.shortcutFuzzyHits += 1;
      await this.desktop.keyPress(shortcutMatch.combo);
      return {
        handled: true,
        description: `Pressed ${shortcutMatch.combo} (${shortcutMatch.canonicalIntent}${shortcutMatch.matchType === 'fuzzy' ? ', fuzzy' : ''})`,
      };
    }

    // 5. "press [key]" — direct key press (BEFORE click to avoid "press enter" being caught as click)
    const keyMatch = rawTask.match(/^(?:press|hit)\s+(\S.*)$/i);
    if (keyMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleKeyPress(keyMatch[1].trim());
    }

    // 6. "click [element]" — try a11y lookup (no "press"/"hit" — handled above)
    const clickMatch = rawTask.match(
      /^(?:click|tap)\s+(?:the\s+)?(?:on\s+)?(?:['"]([^'"]+)['"]|(.+?))(?:\s+(?:button|link|tab|menu|item))?\s*$/i,
    );
    if (clickMatch) {
      const elementName = (clickMatch[1] ?? clickMatch[2] ?? '').trim();
      if (elementName) {
        this.telemetry.nonShortcutHandled += 1;
        return this.handleClick(elementName);
      }
    }

    // 7. "focus [window]" / "switch to [window]"
    const focusMatch = rawTask.match(/^(?:focus|switch to|bring up|activate|go to)\s+(\S.*)$/i);
    if (focusMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleFocusWindow(focusMatch[1].trim());
    }

    // 8. "close [window/app]"
    const closeMatch = rawTask.match(/^(?:close)\s+(\S.*)$/i);
    if (closeMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleClose(closeMatch[1].trim());
    }

    // 9. "minimize [window]" / "maximize [window]"
    const winCtrlMatch = rawTask.match(/^(minimize|maximize)\s+(\S.*)$/i);
    if (winCtrlMatch) {
      this.telemetry.nonShortcutHandled += 1;
      return this.handleWindowControl(winCtrlMatch[1].toLowerCase(), winCtrlMatch[2].trim());
    }

    // 10. "find <text>" → Ctrl/Cmd+F then type
    // Only match explicit in-page find requests (with quotes or "in page" qualifier)
    // NOT intent-based tasks like "find the cheapest flight" or "find a restaurant"
    const mod = PLATFORM === 'darwin' ? 'Super' : 'Control'; // Cmd on macOS, Ctrl on Windows/Linux
    const findMatch = rawTask.match(/^(?:search in page|search within|find in page|find on page)\s+(.+)$/i)
      || rawTask.match(/^(?:find|search)\s+['"](.+)['"]$/i); // only quoted strings
    if (findMatch) {
      await this.desktop.keyPress(`${mod}+f`);
      await this.delay(200);
      await this.desktop.typeText(findMatch[1]);
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: `Find "${findMatch[1]}"` };
    }

    // 10b. "search for X [on google]" — type query in browser address bar
    const searchForMatch = rawTask.match(/^search\s+(?:for\s+)?(.+?)(?:\s+on\s+(?:google|bing|duckduckgo))?$/i);
    if (searchForMatch) {
      const query = searchForMatch[1].trim();
      // Ensure a browser is focused
      try {
        const windows = await this.a11y.getWindows();
        const browser = windows.find(w =>
          BROWSER_PROCESSES.some(bp => w.processName.toLowerCase().includes(bp)) && !w.isMinimized
        );
        if (browser) {
          await this.a11y.focusWindow(undefined, browser.processId);
          await this.delay(400);
        }
      } catch { /* proceed anyway */ }

      // Ctrl+L to focus address bar, type query, Enter
      await this.desktop.keyPress(`${mod}+l`);
      await this.delay(300);
      await this.desktop.typeText(query);
      await this.delay(200);
      await this.desktop.keyPress('Return');
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: `Searched for "${query}" via address bar` };
    }

    // 11. Screenshot / show desktop / lock screen
    if (/^(take|capture)\s+(a\s+)?screenshot$/.test(task)) {
      const combo = PLATFORM === 'darwin' ? 'Super+Shift+4' : 'Super+Shift+s';
      await this.desktop.keyPress(combo);
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: `Screenshot via ${combo}` };
    }

    if (/^(show|go to)\s+desktop|minimize all$/.test(task)) {
      const combo = PLATFORM === 'darwin' ? 'Super+Option+m' : 'Super+d';
      await this.desktop.keyPress(combo);
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: `Show desktop via ${combo}` };
    }

    if (/^lock\s+screen$/.test(task)) {
      const combo = PLATFORM === 'darwin' ? 'Control+Super+q' : 'Super+l';
      await this.desktop.keyPress(combo);
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: `Lock screen via ${combo}` };
    }

    // 12. Select all + delete
    if (task === 'select all and delete') {
      await this.desktop.keyPress(`${mod}+a`);
      await this.delay(100);
      await this.desktop.keyPress('Delete');
      this.telemetry.nonShortcutHandled += 1;
      return { handled: true, description: 'Select all and delete' };
    }

    // Not handled — fall back to LLM
    this.telemetry.llmFallbacks += 1;
    return { handled: false, description: `Could not route: "${subtask}"` };
  }

  // ─── Handler: Open App ─────────────────────────────────────────────

  private async handleOpenApp(appName: string): Promise<RouteResult> {
    const normalized = appName.toLowerCase().replace(/['"]/g, '');
    const alias = APP_ALIASES[normalized];

    // Check if app is already running
    let windowsBefore: WindowInfo[] = [];
    try {
      windowsBefore = await this.a11y.getWindows(true);
      const running = this.findWindowForApp(windowsBefore, normalized, alias);

      if (running) {
        // App is running — focus and maximize it
        const result = await this.a11y.focusWindow(undefined, running.processId);
        if (result.success) {
          await this.maximizeWindow({ hwnd: running.handle });
          await this.delay(200);
          return {
            handled: true,
            description: `Focused existing "${running.title}" window`,
          };
        }
      }
    } catch {
      // a11y unavailable, proceed with launch
    }

    // For Chrome/Edge on Windows: launch directly with --profile-directory=Default
    // to bypass the "Who's using Chrome?" profile picker entirely.
    if (PLATFORM === 'win32' && /^(chrome|google chrome|edge|microsoft edge)$/i.test(normalized)) {
      const directResult = await this.launchBrowserDirect(normalized, windowsBefore);
      if (directResult) return directResult;
    }

    // App not running — launch via Start Menu (or open -a on macOS)
    const searchTerm = alias?.searchTerm || appName;
    const macOSAppName = alias?.macOSAppName || appName;
    return this.launchViaStartMenu(searchTerm, macOSAppName);
  }

  /**
   * Launch Chrome/Edge directly with --profile-directory=Default to skip profile picker.
   * Returns null if direct launch fails (caller falls back to Start Menu).
   */
  private async launchBrowserDirect(normalized: string, windowsBefore: WindowInfo[]): Promise<RouteResult | null> {
    const customExe = getBrowserExePath();
    const isChrome = /chrome/i.test(normalized);
    const exePaths = customExe
      ? [customExe]
      : isChrome
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ];

    const searchTerm = isChrome ? 'Chrome' : 'Edge';

    for (const exePath of exePaths) {
      try {
        // Check if exe exists before trying to spawn
        const { existsSync } = await import('fs');
        if (!existsSync(exePath)) continue;

        console.log(`   🚀 Direct launch: ${exePath} --profile-directory=Default`);
        const child = spawn(exePath, ['--profile-directory=Default', '--disable-session-crashed-bubble', '--no-first-run'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        // Wait for window to appear
        const readyResult = await this.waitForAppReady(searchTerm, windowsBefore);
        if (readyResult) {
          await this.maximizeWindow({ hwnd: readyResult.handle });
          await this.delay(200);
          return {
            handled: true,
            description: `Launched "${searchTerm}" with default profile — window ready & maximized (${readyResult.title})`,
          };
        }
        // Window didn't appear — fall through
      } catch {
        continue;
      }
    }
    return null; // direct launch failed, fall back to Start Menu
  }

  private findWindowForApp(
    windows: WindowInfo[],
    normalizedName: string,
    alias?: { processNames: string[]; searchTerm: string },
  ): WindowInfo | undefined {
    // Match by process name
    if (alias) {
      for (const pn of alias.processNames) {
        const found = windows.find(w =>
          !w.isMinimized && w.processName.toLowerCase() === pn.toLowerCase()
        );
        if (found) return found;
        // Also check minimized
        const minimized = windows.find(w =>
          w.processName.toLowerCase() === pn.toLowerCase()
        );
        if (minimized) return minimized;
      }
    }

    // Fuzzy match on window title
    return windows.find(w =>
      w.title.toLowerCase().includes(normalizedName)
    );
  }

  private async launchViaStartMenu(searchTerm: string, macOSAppName?: string): Promise<RouteResult> {
    // Snapshot windows BEFORE launch so we can detect the new one
    let windowsBefore: WindowInfo[] = [];
    try {
      windowsBefore = await this.a11y.getWindows(true);
    } catch { /* proceed without snapshot */ }

    try {
      if (PLATFORM === 'darwin') {
        // macOS: use `open -a` — directly launches & focuses, no Spotlight needed
        try {
          await execFileAsync('open', ['-a', macOSAppName || searchTerm]);
          await this.delay(800); // give app time to surface
        } catch {
          // Fallback: Spotlight if open -a fails (e.g. non-standard app name)
          await this.desktop.keyPress('Super+Space');
          await this.delay(400);
          await this.desktop.typeText(searchTerm);
          await this.delay(600);
          await this.desktop.keyPress('Return');
        }
      } else {
        // Windows: Use Start Menu (Win key)
        await this.desktop.keyPress('Super');
        await this.delay(600);
        await this.desktop.typeText(searchTerm);
        await this.delay(800);
        await this.desktop.keyPress('Return');
      }

      // Poll until a NEW window appears (or timeout)
      const readyResult = await this.waitForAppReady(searchTerm, windowsBefore);

      // Maximize the new window for consistent layout
      if (readyResult) {
        try {
          await this.maximizeWindow({ hwnd: readyResult.handle });
          await this.delay(200);
        } catch { /* non-critical */ }
      }

      return {
        handled: true,
        description: readyResult
          ? `Launched "${searchTerm}" — window ready & maximized (${readyResult.title})`
          : `Launched "${searchTerm}" via Start Menu search (readiness timeout — proceeding anyway)`,
      };
    } catch (err) {
      return {
        handled: false,
        description: `Failed to launch "${searchTerm}": ${err}`,
        error: String(err),
      };
    }
  }

  /**
   * Maximize a window via Win32 API.
   * If hwnd is provided, uses that handle directly (most reliable for multi-process apps like Edge).
   * If pid is provided, finds the window by process ID.
   * Otherwise, maximizes the foreground window.
   */
  private async maximizeWindow(opts?: { hwnd?: number; pid?: number }): Promise<void> {
    if (process.platform !== 'win32') {
      await this.desktop.keyPress(process.platform === 'darwin' ? 'ctrl+cmd+f' : 'Super+Up');
      return;
    }
    try {
      // Win11 snap layouts are persistent — ShowWindow alone can't override them.
      // Use SetWindowPos to forcefully resize, then maximize.
      const typeDef = `'using System; using System.Runtime.InteropServices; public class WinMax { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'`;
      const maximizeSeq = `$w=[WinMax]::GetSystemMetrics(0); $ht=[WinMax]::GetSystemMetrics(1); [WinMax]::ShowWindow($h,1)|Out-Null; Start-Sleep -m 100; [WinMax]::SetWindowPos($h,[IntPtr]::Zero,0,0,$w,$ht,0x0040)|Out-Null; Start-Sleep -m 100; [WinMax]::SetForegroundWindow($h)|Out-Null; [WinMax]::ShowWindow($h,3)|Out-Null`;
      let cmd: string;
      if (opts?.hwnd) {
        cmd = `Add-Type -TypeDefinition ${typeDef}; $h=[IntPtr]${opts.hwnd}; ${maximizeSeq}; Write-Host "hwnd=${opts.hwnd} OK"`;
      } else if (opts?.pid) {
        cmd = `$p=Get-Process -Id ${opts.pid} -ErrorAction Stop; $h=$p.MainWindowHandle; if($h -ne [IntPtr]::Zero){ Add-Type -TypeDefinition ${typeDef}; ${maximizeSeq}; Write-Host "pid=${opts.pid} hwnd=$h OK" } else { Write-Host "pid=${opts.pid} no-main-window" }`;
      } else {
        cmd = `Add-Type -TypeDefinition ${typeDef}; $h=[WinMax]::GetForegroundWindow(); [WinMax]::ShowWindow($h,3)|Out-Null; Write-Host "hwnd=$h OK"`;
      }
      console.log(`   📐 Maximizing window${opts?.hwnd ? ` (hwnd ${opts.hwnd})` : opts?.pid ? ` (pid ${opts.pid})` : ''}...`);
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 5000, windowsHide: true });
      console.log(`   📐 ${stdout.trim()}`);
    } catch (e: any) {
      console.warn(`   ⚠️ PowerShell maximize failed: ${e?.message} — falling back to Alt+Space+X`);
      await this.desktop.keyPress('alt+space');
      await this.delay(150);
      await this.desktop.keyPress('x');
    }
  }

  /** Backward-compatible alias */
  private async maximizeForegroundWindow(pidOrHwnd?: number): Promise<void> {
    return this.maximizeWindow(pidOrHwnd ? { pid: pidOrHwnd } : undefined);
  }

  /**
   * Poll accessibility until a new window matching the app appears.
   * Returns the matched WindowInfo, or null on timeout.
   */
  private async waitForAppReady(
    searchTerm: string,
    windowsBefore: WindowInfo[],
  ): Promise<WindowInfo | null> {
    const beforeHandles = new Set(windowsBefore.map(w => w.handle));
    const normalized = searchTerm.toLowerCase();
    const alias = APP_ALIASES[normalized];
    const deadline = Date.now() + READY_TIMEOUT;

    console.log(`   ⏳ Waiting for "${searchTerm}" window to appear...`);

    while (Date.now() < deadline) {
      await this.delay(READY_POLL_INTERVAL);

      try {
        const currentWindows = await this.a11y.getWindows(true);

        // Look for a NEW window (handle not in beforeHandles) that matches the app
        for (const w of currentWindows) {
          if (beforeHandles.has(w.handle)) continue;
          if (w.isMinimized) continue;

          const matchesProcess = alias
            ? alias.processNames.some(pn => w.processName.toLowerCase() === pn.toLowerCase())
            : false;
          const matchesTitle = w.title.toLowerCase().includes(normalized);
          const matchesSearch = alias
            ? w.title.toLowerCase().includes(alias.searchTerm.toLowerCase())
            : false;

          if (matchesProcess || matchesTitle || matchesSearch) {
            const isWebView2 = WEBVIEW2_APPS.test(w.processName) || WEBVIEW2_APPS.test(w.title);
            const settleMs = isWebView2 ? WEBVIEW2_SETTLE_MS : READY_SETTLE_MS;
            console.log(`   ✅ Window detected: "${w.title}" (pid:${w.processId}) — settling ${settleMs}ms${isWebView2 ? ' (WebView2)' : ''}`);
            // Give the window time to finish rendering — WebView2 apps need longer
            await this.delay(settleMs);
            return w;
          }
        }
      } catch {
        // a11y temporarily unavailable, keep polling
      }
    }

    console.log(`   ⚠️ Readiness timeout (${READY_TIMEOUT}ms) — app may still be loading`);
    return null;
  }

  // ─── Helper: Launch Edge with CDP port ─────────────────────────────

  /**
   * Try to launch a browser with --remote-debugging-port so CDPDriver can connect.
   * Uses configured exe path if set, otherwise tries common Edge installation paths.
   */
  private async launchEdgeWithCDP(url: string): Promise<boolean> {
    const cdpPort = getCDPPort();
    const customExe = getBrowserExePath();
    const browserPaths = customExe
      ? [customExe]
      : PLATFORM === 'darwin'
        ? [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ]
        : PLATFORM === 'linux'
          ? [
              '/usr/bin/microsoft-edge',
              '/usr/bin/google-chrome',
              '/usr/bin/google-chrome-stable',
              '/usr/bin/chromium',
              '/usr/bin/chromium-browser',
            ]
          : [
              'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            ];
    for (const browserPath of browserPaths) {
      try {
        spawn(browserPath, [
          `--remote-debugging-port=${cdpPort}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          url,
        ], { detached: true, stdio: 'ignore' }).unref();
        console.log(`   🔌 Launched browser with CDP port ${cdpPort} — ${url}`);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // ─── Handler: Save As ──────────────────────────────────────────────

  private async handleSaveAs(descriptor: string): Promise<RouteResult> {
    // Parse "filename on the desktop" / "filename in Documents" / just "filename"
    let filename = descriptor;
    let folder = '';

    const onDesktopMatch = descriptor.match(/^(.+?)\s+on\s+(?:the\s+)?desktop$/i);
    const inFolderMatch = descriptor.match(/^(.+?)\s+(?:in|to)\s+(?:the\s+)?(.+)$/i);

    if (onDesktopMatch) {
      filename = onDesktopMatch[1].trim();
      folder = os.platform() === 'win32'
        ? `${process.env.USERPROFILE || 'C:\\Users\\' + os.userInfo().username}\\Desktop`
        : `${os.homedir()}/Desktop`;
    } else if (inFolderMatch) {
      filename = inFolderMatch[1].trim();
      const folderName = inFolderMatch[2].trim().toLowerCase();
      const home = os.homedir();
      const folderMap: Record<string, string> = {
        'documents': `${home}${os.platform() === 'win32' ? '\\Documents' : '/Documents'}`,
        'downloads': `${home}${os.platform() === 'win32' ? '\\Downloads' : '/Downloads'}`,
        'desktop': `${home}${os.platform() === 'win32' ? '\\Desktop' : '/Desktop'}`,
      };
      folder = folderMap[folderName] || '';
    }

    const fullPath = folder
      ? (os.platform() === 'win32' ? `${folder}\\${filename}` : `${folder}/${filename}`)
      : filename;

    try {
      // Press Ctrl+Shift+S for Save As dialog
      await this.desktop.keyPress('Control+Shift+s');
      await this.delay(1500); // Wait for Save As dialog to fully render

      // Select all text in the filename field and type the path
      await this.desktop.keyPress('Control+a');
      await this.delay(100);
      await this.desktop.typeText(fullPath);
      await this.delay(300);

      // Press Enter to save
      await this.desktop.keyPress('Return');
      await this.delay(1000);

      // Handle potential "overwrite?" confirmation dialog
      // If a confirmation dialog appears, press Enter again to confirm
      try {
        const activeWin = await this.a11y.getActiveWindow().catch(() => null);
        if (activeWin && /confirm|replace|overwrite|save as/i.test(activeWin.title)) {
          await this.desktop.keyPress('Return');
          await this.delay(500);
        }
      } catch { /* non-critical */ }

      return {
        handled: true,
        description: `Saved file as "${fullPath}" via Ctrl+Shift+S → Save As dialog`,
      };
    } catch (err) {
      return {
        handled: false,
        description: `Save As failed: ${err}`,
        error: String(err),
      };
    }
  }

  // ─── Handler: Type Text ────────────────────────────────────────────

  private async handleType(text: string): Promise<RouteResult> {
    try {
      // Use clipboard paste for longer text — avoids autocomplete interference in Notepad
      // Guard: writeClipboard may not exist if a11y bridge is unavailable
      if (text.length > 10 && typeof this.a11y.writeClipboard === 'function') {
        try {
          await this.a11y.writeClipboard(text);
          await this.delay(50);
          await this.desktop.keyPress(PLATFORM === 'darwin' ? 'Super+v' : 'Control+v');
          await this.delay(200);
        } catch {
          // Clipboard bridge failed — fall back to direct typing
          await this.desktop.typeText(text);
        }
      } else {
        await this.desktop.typeText(text);
      }
      return {
        handled: true,
        description: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
      };
    } catch (err) {
      return {
        handled: false,
        description: `Failed to type text: ${err}`,
        error: String(err),
      };
    }
  }

  // ─── Handler: Navigate to URL ──────────────────────────────────────

  private async handleNavigateToUrl(url: string): Promise<RouteResult> {
    // Ensure URL has protocol
    let fullUrl = url;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }

    // Validate URL to prevent command injection
    try {
      const parsed = new URL(fullUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { handled: false, description: `Invalid URL protocol: ${parsed.protocol}`, error: 'Invalid URL protocol' };
      }
    } catch {
      return { handled: false, description: `Invalid URL: ${fullUrl}`, error: 'Invalid URL' };
    }

    try {
      // Try to find and focus a browser window
      const windows = await this.a11y.getWindows();
      const browser = windows.find(w =>
        BROWSER_PROCESSES.some(bp => w.processName.toLowerCase().includes(bp))
      );

      if (browser) {
        // Focus browser
        await this.a11y.focusWindow(undefined, browser.processId);
        await this.delay(300);
      } else {
        // No browser running — launch Edge with CDP debugging port for DOM access
        const launched = await this.launchEdgeWithCDP(fullUrl);
        if (launched) {
          await this.delay(2500);
          return {
            handled: true,
            description: `Opened ${fullUrl} in browser (CDP port ${getCDPPort()} enabled for DOM interaction)`,
          };
        }
        // Fall back to OS default browser
        if (PLATFORM === 'darwin') {
          await execFileAsync('open', [fullUrl]);
        } else if (PLATFORM === 'linux') {
          await execFileAsync('xdg-open', [fullUrl]);
        } else {
          await execFileAsync('explorer', [fullUrl]);
        }
        await this.delay(2000);
        return {
          handled: true,
          description: `Opened ${fullUrl} in default browser`,
        };
      }

      // Ctrl+L to focus address bar, then type URL
      await this.desktop.keyPress('ctrl+l');
      await this.delay(300);
      await this.desktop.typeText(fullUrl);
      await this.delay(100);
      await this.desktop.keyPress('Return');

      return {
        handled: true,
        description: `Navigated to ${fullUrl}`,
      };
    } catch (err) {
      return {
        handled: false,
        description: `Failed to navigate: ${err}`,
        error: String(err),
      };
    }
  }

  // ─── Handler: Click Element ────────────────────────────────────────

  private async handleClick(elementName: string): Promise<RouteResult> {
    try {
      // Try to find and click via a11y
      const elements = await this.a11y.findElement({ name: elementName });

      if (elements && elements.length > 0) {
        const el = elements[0];
        const processId = (el as any).processId;

        if (processId) {
          const result = await this.a11y.invokeElement({
            name: elementName,
            action: 'click',
            processId,
          });

          if (result.success) {
            return {
              handled: true,
              description: `Clicked "${elementName}" via accessibility`,
            };
          }

          // If a11y click failed but we have coordinates, click there
          if ((result as any).clickPoint) {
            const pt = (result as any).clickPoint;
            const mc = this.desktop.physicalToMouse(pt.x, pt.y);
            await this.desktop.mouseClick(mc.x, mc.y);
            return {
              handled: true,
              description: `Clicked "${elementName}" at (${mc.x}, ${mc.y})`,
            };
          }
        }

        // Fall back to clicking the center of the element's bounds
        if (el.bounds && el.bounds.width > 0) {
          const cx = el.bounds.x + Math.floor(el.bounds.width / 2);
          const cy = el.bounds.y + Math.floor(el.bounds.height / 2);
          const mc = this.desktop.physicalToMouse(cx, cy);
          await this.desktop.mouseClick(mc.x, mc.y);
          return {
            handled: true,
            description: `Clicked "${elementName}" at center (${mc.x}, ${mc.y})`,
          };
        }
      }

      return { handled: false, description: `Element "${elementName}" not found via a11y` };
    } catch (err) {
      return { handled: false, description: `Click failed: ${err}`, error: String(err) };
    }
  }

  // ─── Handler: Focus Window ─────────────────────────────────────────

  private async handleFocusWindow(windowName: string): Promise<RouteResult> {
    const normalized = windowName.toLowerCase().replace(/['"]/g, '');
    const alias = APP_ALIASES[normalized];

    try {
      const windows = await this.a11y.getWindows();
      const target = this.findWindowForApp(windows, normalized, alias);

      if (target) {
        const result = await this.a11y.focusWindow(undefined, target.processId);
        if (result.success) {
          return {
            handled: true,
            description: `Focused window "${target.title}"`,
          };
        }
      }

      // Try title match
      const result = await this.a11y.focusWindow(windowName);
      if (result.success) {
        return {
          handled: true,
          description: `Focused window matching "${windowName}"`,
        };
      }

      return { handled: false, description: `Window "${windowName}" not found` };
    } catch (err) {
      return { handled: false, description: `Focus failed: ${err}`, error: String(err) };
    }
  }

  // ─── Handler: Close Window ─────────────────────────────────────────

  private async handleClose(appName: string): Promise<RouteResult> {
    try {
      // Focus it first, then Alt+F4
      const focusResult = await this.handleFocusWindow(appName);
      if (focusResult.handled) {
        await this.delay(200);
        if (PLATFORM === 'darwin') {
          await this.desktop.keyPress('Super+q'); // Cmd+Q on macOS
        } else {
          await this.desktop.keyPress('alt+F4');
        }
        return {
          handled: true,
          description: `Closed "${appName}" with ${PLATFORM === 'darwin' ? 'Cmd+Q' : 'Alt+F4'}`,
        };
      }
      return { handled: false, description: `Cannot close — window "${appName}" not found` };
    } catch (err) {
      return { handled: false, description: `Close failed: ${err}`, error: String(err) };
    }
  }

  // ─── Handler: Window Control (minimize/maximize) ───────────────────

  private async handleWindowControl(action: string, appName: string): Promise<RouteResult> {
    try {
      const focusResult = await this.handleFocusWindow(appName);
      if (!focusResult.handled) {
        return { handled: false, description: `Cannot ${action} — window "${appName}" not found` };
      }

      await this.delay(200);

      if (action === 'minimize') {
        await this.desktop.keyPress('Super+Down');
      } else {
        await this.maximizeForegroundWindow();
      }

      return {
        handled: true,
        description: `${action}d "${appName}"`,
      };
    } catch (err) {
      return { handled: false, description: `${action} failed: ${err}`, error: String(err) };
    }
  }

  // ─── Handler: Key Press ────────────────────────────────────────────

  private async handleKeyPress(keyDesc: string): Promise<RouteResult> {
    const mapped = normalizeKey(keyDesc);

    try {
      await this.desktop.keyPress(mapped);
      return {
        handled: true,
        description: `Pressed ${mapped}`,
      };
    } catch (err) {
      return { handled: false, description: `Key press failed: ${err}`, error: String(err) };
    }
  }

  // ─── Utility ───────────────────────────────────────────────────────


  private async getShortcutContextHint(): Promise<string> {
    try {
      const active = await this.a11y.getActiveWindow();
      if (!active) return '';
      return `${active.title} ${active.processName}`.toLowerCase();
    } catch {
      return '';
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
