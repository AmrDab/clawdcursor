/**
 * Accessibility Bridge — queries the native accessibility tree.
 *
 * Windows: uses PSRunner (persistent powershell process via ps-bridge.ps1).
 *          One-time assembly load cost ~800ms, then each call is <50ms.
 * macOS:   spawns osascript per call (unchanged).
 *
 * v4: PSRunner replaces per-call powershell.exe spawning on Windows.
 *     MaxDepth raised to 4 so nested elements are visible to the LLM.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { psRunner } from './ps-runner';
import { getPackageRoot } from '../paths';
import type { PlatformAdapter, UiElement } from './types';

const execFileAsync = promisify(execFile);
const PLATFORM = os.platform();
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';
const SCRIPTS_DIR = path.join(getPackageRoot(), 'scripts');
const MAC_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'mac');

// macOS JXA can be slow on first call; 30s gives headroom.
const MAC_SCRIPT_TIMEOUT = 30000;

const MAX_DEPTH = 8; // raised to 8 — Electron/WebView2 apps (Outlook olk) nest deeply: Window > Pane > Pane > Pane > Button

/** Cached shell availability (macOS only — Windows uses psRunner) */
let macShellAvailable: boolean | null = null;
let macShellCheckedAt = 0;
const MAC_SHELL_TTL = 30000; // Re-check every 30s if previously denied (permission may be granted mid-session)

// ── Linux ───────────────────────────────────────────────────────────────────
// This legacy bridge has no Linux code of its own: every Linux branch routes
// to the LinuxAdapter (src/platform/linux.ts), which owns the AT-SPI Python
// bridge (scripts/linux/atspi-bridge.py) and wmctrl/xdotool window handling.
// That is what smart_click / find_button / smart_type / invoke_element use
// on Linux. Clipboard stays local (wl-copy / xclip / xsel).
// ─────────────────────────────────────────────────────────────────────────────

let linuxAdapterPromise: Promise<PlatformAdapter> | null = null;
function linuxAdapter(): Promise<PlatformAdapter> {
  if (!linuxAdapterPromise) {
    linuxAdapterPromise = import('./index').then(m => m.getPlatform());
  }
  return linuxAdapterPromise;
}

/** PlatformAdapter UiElement → this bridge's legacy UIElement shape. */
function toLegacyElement(el: UiElement): UIElement {
  return {
    name: el.name ?? '',
    automationId: el.automationId ?? '',
    controlType: el.controlType ?? '',
    className: '',
    isEnabled: el.enabled,
    bounds: el.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

function toLegacyWindow(w: import('./types').WindowInfo): WindowInfo {
  return {
    handle: typeof w.handle === 'number' ? w.handle : 0,
    title: w.title,
    processName: w.processName,
    processId: w.processId,
    bounds: w.bounds,
    isMinimized: w.isMinimized,
  };
}

export interface UIElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  isEnabled?: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  children?: UIElement[];
}

export interface FocusedElementInfo {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  processId: number;
  isEnabled: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  value: string;
}

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
}

interface WindowCache {
  windows: WindowInfo[];
  timestamp: number;
}

interface ScreenContextCache {
  context: string;
  timestamp: number;
}

export class AccessibilityBridge {
  private windowCache: WindowCache | null = null;
  private readonly WINDOW_CACHE_TTL = 2000;

  private screenContextCache: ScreenContextCache | null = null;
  private readonly SCREEN_CONTEXT_CACHE_TTL = 2000;

  private taskbarCache: { buttons: UIElement[]; timestamp: number } | null = null;
  private readonly TASKBAR_CACHE_TTL = 30000;
  private explorerProcessId: number | null = null;

  /**
   * Check if the platform's shell is available.
   * Windows: always true (PSRunner starts lazily).
   * macOS:   checks osascript + Accessibility permissions.
   */
  async isShellAvailable(): Promise<boolean> {
    if (IS_WIN) return true; // PSRunner handles availability
    if (IS_LINUX) {
      // True when the AT-SPI bridge probe succeeded (python3 + gi + Atspi).
      try {
        return (await (await linuxAdapter()).checkPermissions()).accessibility;
      } catch {
        return false;
      }
    }

    // If previously granted, trust it. If denied, re-check periodically (user may grant mid-session).
    if (macShellAvailable === true) return true;
    if (macShellAvailable === false && (Date.now() - macShellCheckedAt) < MAC_SHELL_TTL) return false;

    try {
      // Must test actual window access — processes.length works WITHOUT assistive access,
      // but accessing windows/UI elements requires it. This catches the false-positive
      // where osascript runs fine but all A11y queries return empty.
      await execFileAsync(
        'osascript',
        ['-l', 'JavaScript', '-e',
          'var se = Application("System Events"); ' +
          'var p = se.processes.whose({frontmost: true})[0]; ' +
          'p.windows.length; true'],
        { timeout: 5000 },
      );
      macShellAvailable = true;
      macShellCheckedAt = Date.now();
      console.log('✅ Accessibility bridge ready (osascript)');
    } catch (err: any) {
      macShellAvailable = false;
      macShellCheckedAt = Date.now();
      const msg = (err.stderr || '') + (err.message || '');
      const isAuthError = msg.includes('not authorized') || msg.includes('not allowed assistive access') || msg.includes('assistive');
      if (isAuthError) {
        console.error(
          '❌ Accessibility: osascript is not allowed assistive access.\n' +
          '   → System Settings → Privacy & Security → Accessibility\n' +
          '   → Enable your terminal app (Terminal.app / iTerm / etc.)\n' +
          '   A11y tree will be unavailable — falling back to OCR-only mode.',
        );
      } else {
        console.error(`❌ osascript not available: ${msg.slice(0, 200)}\n   Accessibility bridge disabled.`);
      }
    }
    return macShellAvailable!;
  }

  /** Start the PSRunner bridge early so the 800ms assembly load happens in background. */
  async warmup(): Promise<void> {
    if (IS_WIN) {
      psRunner.start().catch(() => {}); // fire-and-forget — errors surface on first actual call
    }
  }

  /**
   * Invalidate caches — call after every action so the next read sees fresh UI state.
   */
  invalidateCache(): void {
    this.windowCache = null;
    this.screenContextCache = null;
  }

  // ── Windows bridge helper ──────────────────────────────────────────────────

  private async winCmd(command: Record<string, unknown>): Promise<any> {
    return psRunner.run(command);
  }

  // ── macOS script helper ────────────────────────────────────────────────────

  private runMacScript(scriptName: string, args: string[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(MAC_SCRIPTS_DIR, scriptName);
      execFile('osascript', ['-l', 'JavaScript', scriptPath, ...args], {
        timeout: MAC_SCRIPT_TIMEOUT,
        maxBuffer: 1024 * 1024 * 5,
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() ? ` — ${stderr.trim()}` : '';
          reject(new Error(error.message + detail));
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) reject(new Error(result.error));
          else resolve(result);
        } catch (pe) {
          reject(pe);
        }
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async getWindows(forceRefresh = false): Promise<WindowInfo[]> {
    if (
      !forceRefresh &&
      this.windowCache &&
      Date.now() - this.windowCache.timestamp < this.WINDOW_CACHE_TTL
    ) {
      return this.windowCache.windows;
    }

    let windows: WindowInfo[];
    if (IS_WIN) {
      const result = await this.winCmd({ cmd: 'get-screen-context', maxDepth: 0 }) as any;
      windows = result.windows ?? [];
      // Update screen context cache timestamp so we don't double-fetch
      this.windowCache = { windows, timestamp: Date.now() };
    } else if (IS_MAC) {
      windows = await this.runMacScript('get-windows.jxa');
      this.windowCache = { windows, timestamp: Date.now() };
    } else {
      // Linux: wmctrl listing (with /proc process names) via the adapter.
      try {
        windows = (await (await linuxAdapter()).listWindows()).map(toLegacyWindow);
      } catch {
        windows = [];
      }
      this.windowCache = { windows, timestamp: Date.now() };
    }
    return windows;
  }

  async findElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    processId?: number;
  }): Promise<UIElement[]> {
    // v0.9.0 a11y scope fix: when the caller omits processId, default to the
    // foreground window. The PSBridge / mac native script enforce a results
    // cap during a descendant scan; without a window scope, the cap can be
    // hit before the real target is reached if other windows have matching
    // names earlier in the desktop tree. Foreground-window scope is almost
    // always the right default for an agent that just said "click X".
    let processId = opts.processId;
    if (!processId) {
      try {
        const fg = await this.getActiveWindow();
        if (fg?.processId) processId = fg.processId;
      } catch { /* tolerate failure — fall through to original behaviour */ }
    }
    if (IS_WIN) {
      const result = await this.winCmd({
        cmd: 'find-element',
        ...(opts.name        && { name:        opts.name }),
        ...(opts.automationId && { automationId: opts.automationId }),
        ...(opts.controlType  && { controlType:  opts.controlType }),
        ...(processId         && { processId }),
      }) as any;
      return Array.isArray(result) ? result : [];
    }
    if (IS_MAC) {
      const args: string[] = [];
      if (opts.name)         args.push('-Name', opts.name);
      if (opts.automationId) args.push('-AutomationId', opts.automationId);
      if (opts.controlType)  args.push('-ControlType', opts.controlType);
      if (processId)         args.push('-ProcessId', String(processId));
      return this.runMacScript('find-element.jxa', args);
    }
    try {
      const hits = await (await linuxAdapter()).findElements({
        // AT-SPI has no separate automation id — the accessible name is the handle.
        name: opts.name ?? opts.automationId,
        controlType: opts.controlType,
        processId,
      });
      return hits.map(toLegacyElement);
    } catch {
      return [];
    }
  }

  async invokeElement(opts: {
    name?: string;
    automationId?: string;
    controlType?: string;
    action: 'click' | 'set-value' | 'get-value' | 'focus' | 'expand' | 'collapse';
    value?: string;
    processId?: number;
  }): Promise<{ success: boolean; value?: string; error?: string; clickPoint?: { x: number; y: number } }> {
    let processId = opts.processId;

    // v0.9.0 a11y scope fix: prefer foreground window when caller omits
    // processId. findElement() now also defaults to foreground, so this
    // path mostly handles the rare case where the foreground lookup fails.
    if (!processId) {
      try {
        const fg = await this.getActiveWindow();
        if (fg?.processId) processId = fg.processId;
      } catch { /* fall through to find-element resolution */ }
    }

    if (!processId) {
      const elements = await this.findElement({
        name: opts.name,
        automationId: opts.automationId,
        controlType: opts.controlType,
      });
      if (!elements?.length) {
        return { success: false, error: `Element not found: ${opts.name ?? opts.automationId}` };
      }
      const el = elements[0];
      processId = (el as any).processId;

      if (!processId && el.bounds?.width > 0 && opts.action === 'click') {
        const cx = el.bounds.x + Math.floor(el.bounds.width / 2);
        const cy = el.bounds.y + Math.floor(el.bounds.height / 2);
        return { success: true, clickPoint: { x: cx, y: cy } };
      }
      if (!processId) {
        return { success: false, error: `No processId for: ${opts.name ?? opts.automationId}` };
      }
    }

    if (IS_WIN) {
      const result = await this.winCmd({
        cmd: 'invoke-element',
        processId,
        action: opts.action,
        ...(opts.name        && { name:         opts.name }),
        ...(opts.automationId && { automationId: opts.automationId }),
        ...(opts.controlType  && { controlType:  opts.controlType }),
        ...(opts.value        && { value:        opts.value }),
      }) as any;
      return result;
    }
    if (IS_MAC) {
      const args: string[] = ['-Action', opts.action, '-ProcessId', String(processId)];
      if (opts.name)         args.push('-Name', opts.name);
      if (opts.automationId) args.push('-AutomationId', opts.automationId);
      if (opts.controlType)  args.push('-ControlType', opts.controlType);
      if (opts.value)        args.push('-Value', opts.value);
      return this.runMacScript('invoke-element.jxa', args);
    }
    try {
      const res = await (await linuxAdapter()).invokeElement({
        name: opts.name ?? opts.automationId,
        controlType: opts.controlType,
        processId,
        action: opts.action,
        value: opts.value,
      });
      const value = res.data && typeof (res.data as any).value === 'string' ? (res.data as any).value : undefined;
      if (res.success) return { success: true, ...(value !== undefined ? { value } : {}) };
      // Failed invoke with bounds → let the caller fall back to a coordinate click.
      const b = res.bounds;
      if (b && b.width > 0) {
        return {
          success: false,
          error: `AT-SPI action failed for: ${opts.name ?? opts.automationId}`,
          clickPoint: { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) },
        };
      }
      return { success: false, error: `Element not found or not actionable: ${opts.name ?? opts.automationId}` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async focusWindow(
    title?: string,
    processId?: number,
  ): Promise<{ success: boolean; title?: string; processId?: number; error?: string }> {
    try {
      let result: any;
      if (IS_WIN) {
        result = await this.winCmd({
          cmd:     'focus-window',
          restore: true,
          ...(title     && { title }),
          ...(processId && { processId }),
        });
      } else if (IS_MAC) {
        const args: string[] = [];
        if (title)     args.push('-Title', title);
        if (processId) args.push('-ProcessId', String(processId));
        args.push('-Restore');
        result = await this.runMacScript('focus-window.jxa', args);
      } else {
        // wmctrl -i -a activates AND un-iconifies, so this is a restore too.
        const adapter = await linuxAdapter();
        const ok = await adapter.focusWindow({ title, processId });
        if (ok) {
          const active = await adapter.getActiveWindow().catch(() => null);
          result = { success: true, title: active?.title ?? title, processId: active?.processId ?? processId };
        } else {
          result = { success: false, error: `No matching window for: ${title ?? processId}` };
        }
      }
      this.invalidateCache();
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      let fg: any;
      if (IS_WIN) {
        fg = await this.winCmd({ cmd: 'get-foreground-window' });
      } else if (IS_MAC) {
        fg = await this.runMacScript('get-foreground-window.jxa');
      } else {
        const active = await (await linuxAdapter()).getActiveWindow();
        return active ? toLegacyWindow(active) : null;
      }
      if (!fg?.success) return null;

      const windows = await this.getWindows(true);
      const match = windows.find(w => w.processId === fg.processId);
      if (match) return match;

      return {
        handle:      fg.handle,
        title:       fg.title,
        processName: fg.processName,
        processId:   fg.processId,
        bounds:      { x: 0, y: 0, width: 0, height: 0 },
        isMinimized: false,
      };
    } catch {
      try {
        const windows = await this.getWindows(true);
        return windows.find(w => !w.isMinimized) ?? null;
      } catch {
        return null;
      }
    }
  }

  async findWindow(appNameOrTitle: string): Promise<WindowInfo | null> {
    const lower = appNameOrTitle.toLowerCase();
    const windows = await this.getWindows();
    return (
      windows.find(w => w.processName.toLowerCase() === lower) ??
      windows.find(w => w.title.toLowerCase().includes(lower)) ??
      windows.find(w => w.processName.toLowerCase().includes(lower)) ??
      null
    );
  }

  /**
   * Restore an off-screen window to a visible state.
   * Uses focusWindow with restore:true — already cross-platform via winCmd/runMacScript.
   * Caller should additionally press 'super+up' if bounds are still negative after this call.
   */
  async restoreWindow(processId?: number, title?: string): Promise<{ success: boolean; error?: string }> {
    return this.focusWindow(title, processId);
  }

  async getFocusedElement(): Promise<FocusedElementInfo | null> {
    if (IS_WIN) {
      try {
        const result = await this.winCmd({ cmd: 'get-focused-element' }) as any;
        if (!result?.success) return null;
        return {
          name: result.name ?? '',
          automationId: result.automationId ?? '',
          controlType: result.controlType ?? '',
          className: result.className ?? '',
          processId: result.processId ?? 0,
          isEnabled: result.isEnabled ?? true,
          bounds: result.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
          value: result.value ?? '',
        };
      } catch {
        return null;
      }
    }
    if (IS_MAC) {
      try {
        const script = path.join(MAC_SCRIPTS_DIR, 'get-focused-element.jxa');
        const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', script], {
          timeout: MAC_SCRIPT_TIMEOUT,
        });
        const result = JSON.parse(stdout.trim());
        if (!result) return null;
        return {
          name: result.name ?? '',
          automationId: result.automationId ?? '',
          controlType: result.controlType ?? '',
          className: result.className ?? '',
          processId: result.processId ?? 0,
          isEnabled: result.isEnabled ?? true,
          bounds: result.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
          value: result.value ?? '',
        };
      } catch {
        return null;
      }
    }
    try {
      const el = await (await linuxAdapter()).getFocusedElement();
      if (!el) return null;
      return {
        name: el.name ?? '',
        automationId: el.automationId ?? '',
        controlType: el.controlType ?? '',
        className: '',
        processId: el.processId ?? 0,
        isEnabled: el.enabled !== false,
        bounds: el.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        value: el.value ?? '',
      };
    } catch {
      return null;
    }
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────

  /**
   * Read text from the OS clipboard.
   * Returns empty string on error, timeout, or non-text content.
   */
  async readClipboard(): Promise<string> {
    try {
      if (IS_WIN) {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-Command', 'Get-Clipboard',
        ], { timeout: 2000 });
        return stdout?.trim() ?? '';
      }
      if (IS_MAC) {
        const { stdout } = await execFileAsync('pbpaste', [], { timeout: 2000 });
        return stdout?.trim() ?? '';
      }
      if (IS_LINUX) {
        // Linux clipboard: tries wl-paste (Wayland), xclip, xsel (X11) in order
        const { stdout } = await execFileAsync('sh', ['-lc', 'if command -v wl-paste >/dev/null 2>&1; then wl-paste --no-newline; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -o; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --output; fi'], { timeout: 2000 });
        return stdout?.trim() ?? '';
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Write text to the OS clipboard.
   * Silently fails on error or timeout.
   */
  async writeClipboard(text: string): Promise<void> {
    try {
      if (IS_WIN) {
        // Use -EncodedCommand with Base64-encoded UTF-16LE to safely handle
        // all characters (quotes, newlines, special chars) without escaping issues.
        const utf16 = Buffer.from(
          `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`,
          'utf16le',
        );
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-EncodedCommand', utf16.toString('base64'),
        ], { timeout: 2000 });
      } else if (IS_MAC) {
        // macOS: pipe to pbcopy via shell
        await new Promise<void>((resolve, reject) => {
          const proc = execFile('pbcopy', [], { timeout: 2000 }, (err) => {
            if (err) reject(err); else resolve();
          });
          proc.stdin?.write(text);
          proc.stdin?.end();
        });
      } else if (IS_LINUX) {
        // Linux clipboard: tries wl-copy (Wayland), xclip, xsel (X11) in order
        await new Promise<void>((resolve, reject) => {
          const proc = execFile('sh', ['-lc', 'if command -v wl-copy >/dev/null 2>&1; then wl-copy; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --input; else exit 1; fi'], { timeout: 2000 }, (err) => {
            if (err) reject(err); else resolve();
          });
          proc.stdin?.write(text);
          proc.stdin?.end();
        });
      }
    } catch {
      // Silently fail — clipboard write is best-effort
    }
  }

  /**
   * Get a text summary of the UI for the LLM.
   * Always reads fresh on Windows (PSRunner is cheap); respects 2s cache otherwise.
   */
  async getScreenContext(focusedProcessId?: number): Promise<string> {
    if (
      this.screenContextCache &&
      Date.now() - this.screenContextCache.timestamp < this.SCREEN_CONTEXT_CACHE_TTL
    ) {
      return this.screenContextCache.context;
    }

    let context = '';

    try {
      if (IS_WIN) {
        const combined = await this.winCmd({
          cmd:              'get-screen-context',
          maxDepth:         MAX_DEPTH,
          ...(focusedProcessId && { focusedProcessId }),
        }) as any;

        if (combined.windows?.length) {
          this.windowCache = { windows: combined.windows, timestamp: Date.now() };
          context += 'WINDOWS:\n';
          for (const w of combined.windows) {
            context += `  ${w.isMinimized ? '🔽' : '🟢'} [${w.processName}] "${w.title}" pid:${w.processId}`;
            if (!w.isMinimized) context += ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`;
            context += '\n';
          }
        }

        if (combined.uiTree) {
          context += '\nFOCUSED WINDOW UI TREE:\n';
          context += this.formatTree(
            Array.isArray(combined.uiTree) ? combined.uiTree : [combined.uiTree],
            '  ',
          );
        }
      } else if (IS_MAC) {
        // macOS — separate script calls
        const windows = await this.getWindows();
        context += 'WINDOWS:\n';
        for (const w of windows) {
          context += `  ${w.isMinimized ? '🔽' : '🟢'} [${w.processName}] "${w.title}" pid:${w.processId}`;
          if (!w.isMinimized) context += ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}`;
          context += '\n';
        }
        if (focusedProcessId) {
          try {
            const result = await this.runMacScript('get-screen-context.jxa', [
              '-FocusedProcessId', String(focusedProcessId),
              '-MaxDepth', String(MAX_DEPTH),
            ]);
            const tree = result?.uiTree ? [result.uiTree] : [];
            context += `\nFOCUSED WINDOW UI TREE (pid:${focusedProcessId}):\n`;
            context += this.formatTree(tree, '  ');
          } catch { /* skip */ }
        }
      } else {
        context += '(Accessibility unavailable on Linux — browser CDP and OCR remain available)';
      }
    } catch (err) {
      context += `\n[A11y tree unavailable: ${err}]\n`;
    }

    // Always append focused element — even when the tree query failed, focus info is critical
    if (IS_WIN) {
      try {
        const focused = await this.getFocusedElement();
        if (focused) {
          context += '\nFOCUSED ELEMENT:\n';
          context += `  [${focused.controlType}] "${focused.name}" id:${focused.automationId} @${focused.bounds.x},${focused.bounds.y}`;
          if (!focused.isEnabled) context += ' DISABLED';
          if (focused.value) context += ` value="${focused.value.substring(0, 100)}"`;
          context += ` pid:${focused.processId}\n`;
        }
      } catch { /* non-critical */ }
    }

    if (!context.trim()) {
      return '(Accessibility unavailable)';
    }

    this.screenContextCache = { context, timestamp: Date.now() };
    return context;
  }

  private static readonly INTERACTIVE_TYPES = new Set([
    'ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox',
    'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink',
    'ControlType.MenuItem', 'ControlType.Menu', 'ControlType.Tab',
    'ControlType.TabItem', 'ControlType.ListItem', 'ControlType.TreeItem',
    'ControlType.Slider', 'ControlType.ScrollBar', 'ControlType.ToolBar',
    'ControlType.Document', 'ControlType.DataItem',
    'ControlType.Pane', 'ControlType.Custom', 'ControlType.Group',
    'ControlType.Text',
  ]);

  private static readonly MAX_CONTEXT_CHARS = 12000; // raised for deep Electron/WebView2/Office trees — LLM needs full field visibility

  private formatTree(elements: UIElement[], indent: string): string {
    let result = '';
    for (const el of elements) {
      const isInteractive = AccessibilityBridge.INTERACTIVE_TYPES.has(el.controlType);
      const hasName = !!(el.name?.trim());
      const hasChildren = el.children && el.children.length > 0;

      // Show element if interactive or named; skip unnamed non-interactive LEAVES only
      if (isInteractive || hasName) {
        const name   = el.name ? `"${el.name}"` : '';
        const id     = el.automationId ? `id:${el.automationId}` : '';
        const bounds = `@${el.bounds.x},${el.bounds.y}`;
        const disabled = el.isEnabled === false ? ' DISABLED' : '';
        result += `${indent}[${el.controlType}] ${name} ${id} ${bounds}${disabled}\n`;

        if (result.length > AccessibilityBridge.MAX_CONTEXT_CHARS) {
          result += `${indent}... (truncated)\n`;
          return result;
        }
      }

      // Always recurse into children — unnamed containers (Pane/Group) in Electron apps
      // often wrap the actual interactive elements several levels deep
      if (hasChildren) {
        result += this.formatTree(el.children!, indent + '  ');
        if (result.length > AccessibilityBridge.MAX_CONTEXT_CHARS) return result;
      }
    }
    return result;
  }
}
