/**
 * Action Router — intercepts common tasks and handles them
 * WITHOUT any LLM call using accessibility + VNC.
 *
 * This is the core optimization: most desktop tasks follow predictable
 * patterns that don't need vision AI to execute.
 */

import * as os from 'os';
import { AccessibilityBridge } from './accessibility';
import { VNCClient } from './vnc-client';
import type { WindowInfo } from './accessibility';

const PLATFORM = os.platform();

export interface RouteResult {
  handled: boolean;
  description: string;
  error?: string;
}

/**
 * Known app aliases → process names / Start Menu search terms
 */
const APP_ALIASES: Record<string, { processNames: string[]; searchTerm: string }> = {
  'paint':        { processNames: ['mspaint'],              searchTerm: 'Paint' },
  'mspaint':      { processNames: ['mspaint'],              searchTerm: 'Paint' },
  'notepad':      { processNames: ['notepad', 'Notepad'],   searchTerm: 'Notepad' },
  'calculator':   { processNames: ['Calculator', 'calc'],   searchTerm: 'Calculator' },
  'calc':         { processNames: ['Calculator', 'calc'],   searchTerm: 'Calculator' },
  'chrome':       { processNames: ['chrome'],               searchTerm: 'Chrome' },
  'firefox':      { processNames: ['firefox'],              searchTerm: 'Firefox' },
  'edge':         { processNames: ['msedge'],               searchTerm: 'Edge' },
  'explorer':     { processNames: ['explorer'],             searchTerm: 'File Explorer' },
  'file explorer': { processNames: ['explorer'],            searchTerm: 'File Explorer' },
  'cmd':          { processNames: ['cmd'],                  searchTerm: 'Command Prompt' },
  'terminal':     { processNames: ['WindowsTerminal', 'cmd'], searchTerm: 'Terminal' },
  'powershell':   { processNames: ['powershell', 'pwsh'],   searchTerm: 'PowerShell' },
  'word':         { processNames: ['WINWORD'],              searchTerm: 'Word' },
  'excel':        { processNames: ['EXCEL'],                searchTerm: 'Excel' },
  'vscode':       { processNames: ['Code'],                 searchTerm: 'Visual Studio Code' },
  'code':         { processNames: ['Code'],                 searchTerm: 'Visual Studio Code' },
  'settings':     { processNames: ['SystemSettings'],       searchTerm: 'Settings' },
  'task manager':  { processNames: ['Taskmgr'],             searchTerm: 'Task Manager' },
  'spotify':      { processNames: ['Spotify'],              searchTerm: 'Spotify' },
  'teams':        { processNames: ['ms-teams', 'Teams'],    searchTerm: 'Teams' },
  'slack':        { processNames: ['slack'],                searchTerm: 'Slack' },
  'discord':      { processNames: ['Discord'],              searchTerm: 'Discord' },
};

/** Browser process names for URL navigation */
const BROWSER_PROCESSES = ['chrome', 'msedge', 'firefox', 'brave', 'opera'];

/** Readiness polling config */
const READY_POLL_INTERVAL = 300;  // ms between polls
const READY_TIMEOUT = 8000;       // max ms to wait for app readiness
const READY_SETTLE_MS = 500;      // extra ms after window appears (let UI render)

export class ActionRouter {
  private a11y: AccessibilityBridge;
  private vnc: VNCClient;

  constructor(a11y: AccessibilityBridge, vnc: VNCClient) {
    this.a11y = a11y;
    this.vnc = vnc;
  }

  /**
   * Try to handle a subtask without LLM. Returns { handled: true } if successful.
   */
  async route(subtask: string): Promise<RouteResult> {
    const task = subtask.trim().toLowerCase();

    // 1. "open [app]" / "launch [app]" / "start [app]"
    const openMatch = task.match(/^(?:open|launch|start|run)\s+(.+)$/i);
    if (openMatch) {
      return this.handleOpenApp(openMatch[1].trim());
    }

    // 2. "type [text]" / "type '[text]'" / "enter [text]"
    const typeMatch = task.match(/^(?:type|enter|write|input)\s+['"]?(.+?)['"]?\s*$/i);
    if (typeMatch) {
      return this.handleType(typeMatch[1]);
    }

    // 3. "go to [url]" / "navigate to [url]" / "visit [url]"
    const urlMatch = task.match(/^(?:go to|navigate to|visit|browse to|open)\s+(https?:\/\/\S+|www\.\S+|\S+\.\w{2,}(?:\/\S*)?)$/i);
    if (urlMatch) {
      return this.handleNavigateToUrl(urlMatch[1]);
    }

    // 4. "click [element]" — try a11y lookup
    const clickMatch = task.match(/^(?:click|press|tap|hit)\s+(?:the\s+)?(?:on\s+)?['"]?(.+?)['"]?\s*(?:button|link|tab|menu|item)?$/i);
    if (clickMatch) {
      return this.handleClick(clickMatch[1].trim());
    }

    // 5. "focus [window]" / "switch to [window]"
    const focusMatch = task.match(/^(?:focus|switch to|bring up|activate|go to)\s+(.+)$/i);
    if (focusMatch) {
      return this.handleFocusWindow(focusMatch[1].trim());
    }

    // 6. "close [window/app]"
    const closeMatch = task.match(/^(?:close)\s+(.+)$/i);
    if (closeMatch) {
      return this.handleClose(closeMatch[1].trim());
    }

    // 7. "minimize [window]" / "maximize [window]"
    const winCtrlMatch = task.match(/^(minimize|maximize)\s+(.+)$/i);
    if (winCtrlMatch) {
      return this.handleWindowControl(winCtrlMatch[1].toLowerCase(), winCtrlMatch[2].trim());
    }

    // 8. "press [key]" — direct key press
    const keyMatch = task.match(/^(?:press|hit)\s+(.+)$/i);
    if (keyMatch) {
      return this.handleKeyPress(keyMatch[1].trim());
    }

    // 9. "select all" / "copy" / "paste" / "undo" / "redo" / "save"
    const mod = PLATFORM === 'darwin' ? 'Super' : 'ctrl'; // Cmd on macOS, Ctrl on Windows
    const shortcutMap: Record<string, string> = {
      'select all': `${mod}+a`,
      'copy': `${mod}+c`,
      'paste': `${mod}+v`,
      'cut': `${mod}+x`,
      'undo': `${mod}+z`,
      'redo': PLATFORM === 'darwin' ? 'Super+shift+z' : 'ctrl+y',
      'save': `${mod}+s`,
      'save as': `${mod}+shift+s`,
      'find': `${mod}+f`,
      'new tab': `${mod}+t`,
      'close tab': `${mod}+w`,
      'new window': `${mod}+n`,
    };

    for (const [pattern, combo] of Object.entries(shortcutMap)) {
      if (task === pattern || task === `press ${pattern}`) {
        await this.vnc.keyPress(combo);
        return { handled: true, description: `Pressed ${combo} (${pattern})` };
      }
    }

    // Not handled — fall back to LLM
    return { handled: false, description: `Could not route: "${subtask}"` };
  }

  // ─── Handler: Open App ─────────────────────────────────────────────

  private async handleOpenApp(appName: string): Promise<RouteResult> {
    const normalized = appName.toLowerCase().replace(/['"]/g, '');
    const alias = APP_ALIASES[normalized];

    // Check if app is already running
    try {
      const windows = await this.a11y.getWindows();
      const running = this.findWindowForApp(windows, normalized, alias);

      if (running) {
        // App is running — just focus it
        const result = await this.a11y.focusWindow(undefined, running.processId);
        if (result.success) {
          return {
            handled: true,
            description: `Focused existing "${running.title}" window`,
          };
        }
      }
    } catch {
      // a11y unavailable, proceed with launch
    }

    // App not running — launch via Start Menu
    const searchTerm = alias?.searchTerm || appName;
    return this.launchViaStartMenu(searchTerm);
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

  private async launchViaStartMenu(searchTerm: string): Promise<RouteResult> {
    // Snapshot windows BEFORE launch so we can detect the new one
    let windowsBefore: WindowInfo[] = [];
    try {
      windowsBefore = await this.a11y.getWindows(true);
    } catch { /* proceed without snapshot */ }

    try {
      if (PLATFORM === 'darwin') {
        // macOS: Use Spotlight (Cmd+Space)
        await this.vnc.keyPress('Super+ '); // Cmd+Space
        await this.delay(400);
        await this.vnc.typeText(searchTerm);
        await this.delay(600);
        await this.vnc.keyPress('Return');
      } else {
        // Windows: Use Start Menu (Win key)
        await this.vnc.keyPress('Super');
        await this.delay(600);
        await this.vnc.typeText(searchTerm);
        await this.delay(800);
        await this.vnc.keyPress('Return');
      }

      // Poll until a NEW window appears (or timeout)
      const readyResult = await this.waitForAppReady(searchTerm, windowsBefore);

      return {
        handled: true,
        description: readyResult
          ? `Launched "${searchTerm}" — window ready (${readyResult.title})`
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
            console.log(`   ✅ Window detected: "${w.title}" (pid:${w.processId}) — settling ${READY_SETTLE_MS}ms`);
            // Give the window a moment to finish rendering its UI
            await this.delay(READY_SETTLE_MS);
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

  // ─── Handler: Type Text ────────────────────────────────────────────

  private async handleType(text: string): Promise<RouteResult> {
    try {
      await this.vnc.typeText(text);
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
        // No browser running — launch default browser via Start
        await this.launchViaStartMenu('Chrome');
        await this.delay(2000);
      }

      // Ctrl+L to focus address bar, then type URL
      await this.vnc.keyPress('ctrl+l');
      await this.delay(300);
      await this.vnc.typeText(fullUrl);
      await this.delay(100);
      await this.vnc.keyPress('Return');

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
            await this.vnc.mouseClick(pt.x, pt.y);
            return {
              handled: true,
              description: `Clicked "${elementName}" at (${pt.x}, ${pt.y})`,
            };
          }
        }

        // Fall back to clicking the center of the element's bounds
        if (el.bounds && el.bounds.width > 0) {
          const cx = el.bounds.x + Math.floor(el.bounds.width / 2);
          const cy = el.bounds.y + Math.floor(el.bounds.height / 2);
          await this.vnc.mouseClick(cx, cy);
          return {
            handled: true,
            description: `Clicked "${elementName}" at center (${cx}, ${cy})`,
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
          await this.vnc.keyPress('Super+q'); // Cmd+Q on macOS
        } else {
          await this.vnc.keyPress('alt+F4');
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
        await this.vnc.keyPress('Super+Down');
      } else {
        await this.vnc.keyPress('Super+Up');
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
    // Normalize common key names
    const keyMap: Record<string, string> = {
      'enter': 'Return',
      'return': 'Return',
      'esc': 'Escape',
      'escape': 'Escape',
      'tab': 'Tab',
      'backspace': 'Backspace',
      'delete': 'Delete',
      'space': ' ',
      'spacebar': ' ',
      'up': 'Up',
      'down': 'Down',
      'left': 'Left',
      'right': 'Right',
      'home': 'Home',
      'end': 'End',
      'page up': 'PageUp',
      'page down': 'PageDown',
      'windows': 'Super',
      'win': 'Super',
    };

    const normalized = keyDesc.toLowerCase();
    const mapped = keyMap[normalized] || keyDesc;

    try {
      await this.vnc.keyPress(mapped);
      return {
        handled: true,
        description: `Pressed ${mapped}`,
      };
    } catch (err) {
      return { handled: false, description: `Key press failed: ${err}`, error: String(err) };
    }
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
