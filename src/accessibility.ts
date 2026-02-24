/**
 * Accessibility Bridge — calls platform-specific scripts to query
 * the native accessibility tree. No vision needed for most actions.
 * 
 * Windows: Node.js → spawn powershell → .NET UI Automation → JSON
 * macOS:   Node.js → spawn osascript → JXA (Accessibility API) → JSON
 * 
 * v2: Added window management helpers (focusWindow, launchApp, getActiveWindow)
 * v2.1: Fixed hardcoded process IDs, added PowerShell check, proper foreground window detection
 * v3: Cross-platform support (Windows + macOS)
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const MAC_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'mac');
const SCRIPT_TIMEOUT = 10000; // 10s timeout

/** Platform script file mapping: Windows (.ps1) → macOS (.jxa) */
const SCRIPT_MAP: Record<string, Record<string, string>> = {
  win32: {
    'get-windows': 'get-windows.ps1',
    'find-element': 'find-element.ps1',
    'invoke-element': 'invoke-element.ps1',
    'focus-window': 'focus-window.ps1',
    'get-foreground-window': 'get-foreground-window.ps1',
    'get-screen-context': 'get-screen-context.ps1',
  },
  darwin: {
    'get-windows': 'get-windows.jxa',
    'get-screen-context': 'get-screen-context.jxa',
    'find-element': 'find-element.jxa',
    'invoke-element': 'invoke-element.jxa',
    'focus-window': 'focus-window.jxa',
    'get-foreground-window': 'get-foreground-window.jxa',
  },
};

/** Cached shell availability */
let shellAvailable: boolean | null = null;

export interface UIElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: UIElement[];
}

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
}

/** Cached window list with TTL */
interface WindowCache {
  windows: WindowInfo[];
  timestamp: number;
}

/** Cached screen context with TTL */
interface ScreenContextCache {
  context: string;
  timestamp: number;
}

export class AccessibilityBridge {
  private windowCache: WindowCache | null = null;
  private readonly WINDOW_CACHE_TTL = 2000; // 2s cache for window list
  private explorerProcessId: number | null = null; // Cached Explorer PID for taskbar detection

  /** Cached taskbar buttons — rarely change, queried once */
  private taskbarCache: { buttons: UIElement[]; timestamp: number } | null = null;
  private readonly TASKBAR_CACHE_TTL = 30000; // 30s — taskbar barely changes

  // ── Perf Opt #3: Screen context cache (2s TTL — UI rarely changes mid-LLM-call) ──
  private screenContextCache: ScreenContextCache | null = null;
  private readonly SCREEN_CONTEXT_CACHE_TTL = 2000;

  /**
   * Check if the platform's script shell is available.
   * Windows: PowerShell, macOS: osascript
   */
  async isShellAvailable(): Promise<boolean> {
    if (shellAvailable !== null) return shellAvailable;
    
    try {
      if (PLATFORM === 'win32') {
        await execFileAsync('powershell.exe', ['-Command', 'exit 0'], { timeout: 5000 });
      } else if (PLATFORM === 'darwin') {
        // Probe System Events directly — a bare osascript -e '""' succeeds even without
        // Accessibility permissions, giving a false positive. Touching processes.length
        // forces macOS to check the permission and fail fast with a clear error if not granted.
        await execFileAsync(
          'osascript',
          ['-l', 'JavaScript', '-e', 'Application("System Events").processes.length; true'],
          { timeout: 5000 },
        );
      } else {
        console.error(`❌ Unsupported platform: ${PLATFORM}. Accessibility requires Windows or macOS.`);
        shellAvailable = false;
        return false;
      }
      shellAvailable = true;
      console.log(`✅ Accessibility bridge ready (${PLATFORM === 'win32' ? 'PowerShell' : 'osascript'})`);
    } catch (err: any) {
      shellAvailable = false;
      if (PLATFORM === 'darwin') {
        const isAuthError = err.stderr?.includes('not authorized') || err.message?.includes('not authorized');
        if (isAuthError) {
          console.error(
            `❌ Accessibility: not authorized to control System Events.\n` +
            `   → System Settings → Privacy & Security → Accessibility\n` +
            `   → Add your terminal app (Terminal, iTerm2, wezterm, etc.) or Node.js and try again.`
          );
        } else {
          console.error(`❌ osascript not available. Accessibility bridge will not function.`);
        }
      } else {
        console.error(`❌ PowerShell not available. Accessibility bridge will not function.`);
      }
    }
    return shellAvailable;
  }

  /**
   * Get the Explorer/Finder process ID (for taskbar/dock detection).
   * Caches result to avoid repeated lookups.
   */
  private async getExplorerProcessId(): Promise<number | null> {
    if (this.explorerProcessId !== null) return this.explorerProcessId;
    
    const targetProcess = PLATFORM === 'darwin' ? 'finder' : 'explorer';
    try {
      const windows = await this.getWindows(true);
      const match = windows.find(w => w.processName.toLowerCase() === targetProcess);
      if (match) {
        this.explorerProcessId = match.processId;
        return match.processId;
      }
    } catch {
      // Fall through to null
    }
    return null;
  }

  /**
   * List all visible top-level windows (cached for 2s)
   */
  async getWindows(forceRefresh = false): Promise<WindowInfo[]> {
    // Check shell availability on first call
    if (shellAvailable === null) {
      const available = await this.isShellAvailable();
      if (!available) {
        throw new Error(`Accessibility shell not available on ${PLATFORM}. Features disabled.`);
      }
    }
    
    if (
      !forceRefresh &&
      this.windowCache &&
      Date.now() - this.windowCache.timestamp < this.WINDOW_CACHE_TTL
    ) {
      return this.windowCache.windows;
    }

    const windows = await this.runScript('get-windows.ps1');
    this.windowCache = { windows, timestamp: Date.now() };
    return windows;
  }

  /**
   * Invalidate the window cache (call after actions that change window state)
   */
  invalidateCache(): void {
    this.windowCache = null;
    this.screenContextCache = null;
  }

  /**
   * Find elements matching criteria
   */
  async findElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    processId?: number;
  }): Promise<UIElement[]> {
    const args: string[] = [];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.processId) args.push('-ProcessId', String(opts.processId));
    return this.runScript('find-element.ps1', args);
  }

  /**
   * Invoke an action on an element (click, set value, etc.)
   * Auto-discovers processId by finding the element first.
   * Falls back to coordinate click if element has bounds but no processId.
   */
  async invokeElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    action: 'click' | 'set-value' | 'get-value' | 'focus' | 'expand' | 'collapse';
    value?: string;
    processId?: number;
  }): Promise<{ success: boolean; value?: string; error?: string; clickPoint?: { x: number; y: number } }> {
    let processId = opts.processId;
    let elementBounds: { x: number; y: number; width: number; height: number } | null = null;

    // Auto-discover processId if not provided
    if (!processId) {
      const searchOpts: any = {};
      if (opts.automationId) {
        searchOpts.automationId = opts.automationId;
      } else if (opts.controlType) {
        searchOpts.controlType = opts.controlType;
      }
      if (Object.keys(searchOpts).length === 0 && opts.name) {
        searchOpts.automationId = opts.name;
      }
      const elements = await this.findElement(searchOpts);
      if (!elements || elements.length === 0) {
        return { success: false, error: `Element not found: ${opts.name || opts.automationId}` };
      }
      const element = elements[0];
      processId = (element as any).processId;
      elementBounds = element.bounds;
      
      // Fallback to coordinate click if we have bounds but no processId
      if (!processId && elementBounds && elementBounds.width > 0 && opts.action === 'click') {
        const centerX = elementBounds.x + Math.floor(elementBounds.width / 2);
        const centerY = elementBounds.y + Math.floor(elementBounds.height / 2);
        console.log(`   ♿ No processId for "${opts.name}", falling back to coordinate click at (${centerX}, ${centerY})`);
        return { 
          success: true, 
          clickPoint: { x: centerX, y: centerY },
          error: `Coordinate click fallback — caller should execute mouse click at (${centerX}, ${centerY})`
        };
      }
      
      if (!processId) {
        return { success: false, error: `No processId for element: ${opts.name || opts.automationId}` };
      }
    }

    const args: string[] = ['-Action', opts.action, '-ProcessId', String(processId)];
    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.value) args.push('-Value', opts.value);
    return this.runScript('invoke-element.ps1', args);
  }

  // ─── Window Management Helpers (deterministic, no LLM) ────────────

  /**
   * Focus (bring to front) a window by title substring or processId.
   * Reliable — uses UIA WindowPattern + Win32 SetForegroundWindow fallback.
   */
  async focusWindow(title?: string, processId?: number): Promise<{ success: boolean; title?: string; processId?: number; error?: string }> {
    const args: string[] = [];
    if (title) args.push('-Title', title);
    if (processId) args.push('-ProcessId', String(processId));
    args.push('-Restore');  // Always restore from minimized

    try {
      const result = await this.runScript('focus-window.ps1', args);
      this.invalidateCache(); // Window state changed
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get the currently active/focused window using Win32 GetForegroundWindow.
   * Returns the window info for the actual foreground window, not a heuristic guess.
   */
  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      // Use Win32 API to get actual foreground window
      const fgResult = await this.runScript('get-foreground-window.ps1');
      if (!fgResult.success) return null;

      // Get full window list to find matching window with full info
      const windows = await this.getWindows(true);
      const match = windows.find(w => w.processId === fgResult.processId);
      
      if (match) return match;
      
      // Window might be new — construct minimal info from foreground result
      return {
        handle: fgResult.handle,
        title: fgResult.title,
        processName: fgResult.processName,
        processId: fgResult.processId,
        bounds: { x: 0, y: 0, width: 0, height: 0 }, // Unknown without full query
        isMinimized: false, // Foreground window can't be minimized
      };
    } catch {
      // Fallback: return first non-minimized window (better than nothing)
      try {
        const windows = await this.getWindows(true);
        return windows.find(w => !w.isMinimized) || null;
      } catch {
        return null;
      }
    }
  }

  /**
   * Find a window by app name/title (fuzzy match).
   */
  async findWindow(appNameOrTitle: string): Promise<WindowInfo | null> {
    const lower = appNameOrTitle.toLowerCase();
    const windows = await this.getWindows();

    // Exact process name match
    let match = windows.find(w => w.processName.toLowerCase() === lower);
    if (match) return match;

    // Title contains
    match = windows.find(w => w.title.toLowerCase().includes(lower));
    if (match) return match;

    // Process name contains
    match = windows.find(w => w.processName.toLowerCase().includes(lower));
    if (match) return match;

    return null;
  }

  /**
   * Get a text summary of the UI for the AI.
   * Uses combined script (1 PowerShell spawn instead of 3).
   * Includes windows list, taskbar buttons, and focused window UI tree.
   */
  async getScreenContext(focusedProcessId?: number): Promise<string> {
    // ── Perf Opt #3: Return cached context if fresh ──
    if (
      this.screenContextCache &&
      Date.now() - this.screenContextCache.timestamp < this.SCREEN_CONTEXT_CACHE_TTL
    ) {
      return this.screenContextCache.context;
    }

    try {
      // Use combined script for single PowerShell spawn
      const args: string[] = [];
      if (focusedProcessId) args.push('-FocusedProcessId', String(focusedProcessId));
      args.push('-MaxDepth', '2');

      let context = '';

      try {
        const combined = await this.runScript('get-screen-context.ps1', args);

        // Format windows
        if (combined.windows && Array.isArray(combined.windows)) {
          context += `WINDOWS:\n`;
          for (const w of combined.windows) {
            context += `  ${w.isMinimized ? '🔽' : '🟢'} [${w.processName}] "${w.title}" pid:${w.processId}`;
            if (!w.isMinimized) context += ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`;
            context += `\n`;
          }
          // Update window cache from combined result
          this.windowCache = { windows: combined.windows, timestamp: Date.now() };
        }

        // Format UI tree (already filtered to interactive elements by the script)
        if (combined.uiTree) {
          context += `\nFOCUSED WINDOW UI TREE:\n`;
          context += this.formatTree(Array.isArray(combined.uiTree) ? combined.uiTree : [combined.uiTree], '  ');
        }
      } catch {
        // Fallback to separate calls if combined script fails
        const windows = await this.getWindows();
        context += `WINDOWS:\n`;
        for (const w of windows) {
          context += `  ${w.isMinimized ? '🔽' : '🟢'} [${w.processName}] "${w.title}" pid:${w.processId}`;
          if (!w.isMinimized) context += ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`;
          context += `\n`;
        }

        if (focusedProcessId) {
          try {
            const args = ['-FocusedProcessId', String(focusedProcessId), '-MaxDepth', '2'];
            const result = await this.runScript('get-screen-context.ps1', args);
            const tree = result?.uiTree ? [result.uiTree] : [];
            context += `\nFOCUSED WINDOW UI TREE (pid:${focusedProcessId}):\n`;
            context += this.formatTree(Array.isArray(tree) ? tree : [tree], '  ');
          } catch { /* tree query failed, skip */ }
        }
      }

      // Include cached taskbar buttons (refreshed every 30s)
      try {
        let tbButtons: UIElement[] = [];
        if (this.taskbarCache && Date.now() - this.taskbarCache.timestamp < this.TASKBAR_CACHE_TTL) {
          tbButtons = this.taskbarCache.buttons;
        } else {
          const explorerPid = await this.getExplorerProcessId();
          if (explorerPid) {
            const taskbarButtons = await this.findElement({ controlType: 'Button' });
            tbButtons = taskbarButtons.filter((b: any) =>
              b.processId === explorerPid && 
              (b.className?.includes('Taskbar') || b.className?.includes('MSTaskList'))
            );
            this.taskbarCache = { buttons: tbButtons, timestamp: Date.now() };
          }
        }
        if (tbButtons.length > 0) {
          context += `\nTASKBAR APPS:\n`;
          for (const b of tbButtons) {
            context += `  📌 "${b.name}" at (${b.bounds.x},${b.bounds.y})\n`;
          }
        }
      } catch { /* taskbar query failed, skip */ }

      // Cache the result
      this.screenContextCache = { context, timestamp: Date.now() };
      return context;
    } catch (err) {
      return `(Accessibility unavailable: ${err})`;
    }
  }

  /** Interactive control types worth sending to the LLM */
  private static readonly INTERACTIVE_TYPES = new Set([
    'ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox',
    'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink',
    'ControlType.MenuItem', 'ControlType.Menu', 'ControlType.Tab',
    'ControlType.TabItem', 'ControlType.ListItem', 'ControlType.TreeItem',
    'ControlType.Slider', 'ControlType.ScrollBar', 'ControlType.ToolBar',
    'ControlType.Document', 'ControlType.DataItem',
  ]);

  /** Max chars for accessibility context sent to LLM */
  private static readonly MAX_CONTEXT_CHARS = 3000;

  private formatTree(elements: UIElement[], indent: string): string {
    let result = '';
    for (const el of elements) {
      // Only include interactive elements or those with useful names
      const isInteractive = AccessibilityBridge.INTERACTIVE_TYPES.has(el.controlType);
      const hasName = !!(el.name && el.name.trim());

      if (isInteractive || hasName) {
        const name = el.name ? `"${el.name}"` : '';
        const id = el.automationId ? `id:${el.automationId}` : '';
        const bounds = `@${el.bounds.x},${el.bounds.y}`;
        result += `${indent}[${el.controlType}] ${name} ${id} ${bounds}\n`;

        // Stop adding if we're over the limit
        if (result.length > AccessibilityBridge.MAX_CONTEXT_CHARS) {
          result += `${indent}... (truncated)\n`;
          return result;
        }
      }

      if (el.children) {
        result += this.formatTree(el.children, indent + '  ');
        if (result.length > AccessibilityBridge.MAX_CONTEXT_CHARS) return result;
      }
    }
    return result;
  }

  /**
   * Run a platform-specific accessibility script.
   * Accepts either a direct filename (e.g. 'get-windows.ps1') or
   * a logical name (e.g. 'get-windows') that gets mapped per platform.
   */
  private runScript(scriptName: string, args: string[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      let command: string;
      let commandArgs: string[];

      // Resolve script name — accept both logical names and direct filenames
      const logicalName = scriptName.replace(/\.(ps1|jxa)$/, '');
      const platformScripts = SCRIPT_MAP[PLATFORM] || SCRIPT_MAP['win32'];
      const resolvedScript = platformScripts[logicalName] || scriptName;

      if (PLATFORM === 'darwin') {
        const scriptPath = path.join(MAC_SCRIPTS_DIR, resolvedScript);
        command = 'osascript';
        commandArgs = ['-l', 'JavaScript', scriptPath, ...args];
      } else {
        // Windows (default)
        const scriptPath = path.join(SCRIPTS_DIR, resolvedScript);
        command = 'powershell.exe';
        commandArgs = [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          ...args,
        ];
      }

      execFile(command, commandArgs, {
        timeout: SCRIPT_TIMEOUT,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
      }, (error, stdout, stderr) => {
        if (error) {
          // Include stderr so the real reason (e.g. "not authorized to send Apple events") is visible
          const stderrDetail = typeof stderr === 'string' && stderr.trim() ? ` — ${stderr.trim()}` : '';
          const fullMessage = error.message + stderrDetail;
          console.error(`Accessibility script error (${resolvedScript}):`, fullMessage);
          reject(new Error(fullMessage));
          return;
        }

        // On macOS, JXA's console.log() writes to stderr, not stdout. Use stdout first, then stderr fallback.
        const raw = (typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim()) || '';
        try {
          const result = JSON.parse(raw);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (parseErr) {
          console.error(`Failed to parse ${resolvedScript} output:`, raw.substring(0, 200));
          reject(parseErr);
        }
      });
    });
  }
}
