/**
 * UIDriver — High-level UI Automation interaction layer (cross-platform).
 *
 * Sits between the A11y Reasoner (Layer 2) and Computer Use (Layer 3).
 * Instead of relying on screenshot+vision to find elements, this layer
 * uses platform-native accessibility APIs to locate and interact with
 * elements by their accessible properties (Name, AutomationId, ControlType).
 *
 * Platform support:
 *   - Windows: PowerShell/.NET UI Automation (find-element.ps1, invoke-element.ps1)
 *   - macOS:   JXA + System Events shell scripts (scripts/mac/*.sh)
 *   - OS detection is automatic via process.platform — no config needed.
 *
 * Architecture:
 *   Layer 1: Action Router (intent detection)
 *   Layer 2: A11y Reasoner (LLM reads accessibility tree)
 *   ──────── UIDriver (this layer) ────────
 *   │  Programmatic element interaction    │
 *   │  Win: PowerShell/.NET UI Automation  │
 *   │  Mac: JXA + System Events + osascript│
 *   │  CDP for browser content             │
 *   ────────────────────────────────────────
 *   Layer 3: Computer Use (screenshot+vision fallback)
 *
 * NOTE: On Bash/macOS, use && to chain commands (e.g., cd dir && npm start)
 * On PowerShell (Windows), use ; instead of && (e.g., cd dir; npm start)
 *
 * Usage:
 *   const driver = new UIDriver();
 *
 *   // Click a button by its accessible name
 *   await driver.clickElement('Save');
 *
 *   // Type into a text field
 *   await driver.typeInElement('Search', 'hello world');
 *
 *   // Find elements with flexible queries
 *   const buttons = await driver.findElements({ controlType: 'Button' });
 *
 *   // Wait for a dialog to appear
 *   await driver.waitForElement('Save As', 15000);
 *
 *   // Get bounds for fallback coordinate click
 *   const rect = await driver.getElementBounds('Submit');
 *   if (rect) nativeDesktop.click(rect.x + rect.width/2, rect.y + rect.height/2);
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import type { UIElement } from './accessibility';

const execFileAsync = promisify(execFile);

// ── Platform detection ──
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// ── Script paths ──
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const MAC_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'mac');

// Windows scripts
const WIN_FIND_SCRIPT = path.join(SCRIPTS_DIR, 'find-element.ps1');
const WIN_INVOKE_SCRIPT = path.join(SCRIPTS_DIR, 'invoke-element.ps1');
const WIN_INTERACT_SCRIPT = path.join(SCRIPTS_DIR, 'interact-element.ps1');

// macOS scripts
const MAC_FIND_SCRIPT = path.join(MAC_SCRIPTS_DIR, 'find-element.sh');
const MAC_INTERACT_SCRIPT = path.join(MAC_SCRIPTS_DIR, 'interact-element.sh');
const MAC_UI_TREE_SCRIPT = path.join(MAC_SCRIPTS_DIR, 'get-ui-tree.sh');

// ── Timeouts ──
const SCRIPT_TIMEOUT = 15_000;   // 15s for individual script calls
const MAX_BUFFER = 5 * 1024 * 1024; // 5MB stdout buffer

// ── Types ──

/** Flexible element search query. All fields are optional; at least one should be set. */
export interface ElementQuery {
  /** Match by accessible Name (exact match by default, partial if partialMatch=true) */
  name?: string;
  /** Match by AutomationId (exact match) */
  automationId?: string;
  /** Match by ClassName */
  className?: string;
  /** Match by ControlType (e.g. 'Button', 'Edit', 'MenuItem', 'ComboBox') */
  controlType?: string;
  /** Limit search to a specific process */
  processId?: number;
  /** Max results to return (default 20) */
  maxResults?: number;
}

/** Extended element info returned by findElements */
export interface ElementInfo extends UIElement {
  processId: number;
  isEnabled: boolean;
}

interface ElementCacheEntry {
  timestamp: number;
  results: ElementInfo[];
}

/** Bounding rectangle in screen coordinates */
export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of an interaction action */
export interface InteractionResult {
  success: boolean;
  /** The method used (e.g. 'InvokePattern', 'ValuePattern', 'TogglePattern') */
  method?: string;
  /** Returned value (for get-value actions) */
  value?: string;
  /** If click failed, the center point for coordinate fallback */
  clickPoint?: { x: number; y: number };
  /** Error message if failed */
  error?: string;
  /** The action that was performed */
  action?: string;
  /** Toggle state after toggle action */
  toggleState?: string;
}

/**
 * UIDriver — programmatic UI element interaction via platform-native accessibility.
 *
 * Cross-platform: automatically uses the correct scripts for the current OS.
 * - Windows: PowerShell + .NET UI Automation
 * - macOS: Bash + JXA (JavaScript for Automation) + System Events
 *
 * All methods are async and return typed results with error info.
 * The public API is identical regardless of platform.
 */
export class UIDriver {
  private defaultProcessId?: number;
  private readonly platform: 'win32' | 'darwin' | 'unsupported';
  private elementCache = new Map<string, ElementCacheEntry>();
  private readonly ELEMENT_CACHE_TTL = 2000; // ms

  /**
   * @param defaultProcessId Optional — if set, all queries default to this process.
   *   Useful when you know you're working with a specific app window.
   */
  constructor(defaultProcessId?: number) {
    this.defaultProcessId = defaultProcessId;

    // Detect platform at construction time
    if (IS_WIN) {
      this.platform = 'win32';
    } else if (IS_MAC) {
      this.platform = 'darwin';
    } else {
      this.platform = 'unsupported';
      console.warn('UIDriver: unsupported platform:', process.platform, '— only Windows and macOS are supported');
    }
  }

  /** Update the default process ID (e.g., after focusing a new window) */
  setDefaultProcess(processId: number): void {
    this.defaultProcessId = processId;
    this.elementCache.clear();
  }

  /** Check if the current platform is supported */
  isSupported(): boolean {
    return this.platform !== 'unsupported';
  }

  /** Get the detected platform */
  getPlatform(): string {
    return this.platform;
  }

  // ════════════════════════════════════════════════════════════════════
  // ELEMENT SEARCH
  // ════════════════════════════════════════════════════════════════════

  /**
   * Find elements matching a query.
   *
   * On Windows, uses find-element.ps1 (PowerShell/.NET UI Automation tree).
   * On macOS, uses find-element.sh → find-element.jxa (System Events).
   *
   * @returns Array of matching elements with full property info
   */
  async findElements(query: ElementQuery): Promise<ElementInfo[]> {
    if (this.platform === 'unsupported') return [];

    const args = this.buildFindArgs(query);

    // Check cache (2s TTL)
    const cacheKey = JSON.stringify({ query, platform: this.platform, pid: this.defaultProcessId || null });
    const cached = this.elementCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.ELEMENT_CACHE_TTL) {
      return cached.results;
    }

    try {
      const result = this.platform === 'win32'
        ? await this.runPowerShell(WIN_FIND_SCRIPT, args)
        : await this.runShellScript(MAC_FIND_SCRIPT, args);

      // Scripts return a JSON array
      if (Array.isArray(result)) {
        const items = result as ElementInfo[];
        this.elementCache.set(cacheKey, { timestamp: Date.now(), results: items });
        return items;
      }

      // Single object wrapped
      if (result && typeof result === 'object' && !result.error) {
        const items = [result as ElementInfo];
        this.elementCache.set(cacheKey, { timestamp: Date.now(), results: items });
        return items;
      }

      // Error or empty
      if (result?.error) {
        throw new Error(result.error);
      }

      this.elementCache.set(cacheKey, { timestamp: Date.now(), results: [] });
      return [];
    } catch (err) {
      console.error(`   ❌ UIDriver.findElements failed:`, err);
      return [];
    }
  }

  /**
   * Find a single element matching a query.
   * Returns the first match, or null if not found.
   */
  async findElement(query: ElementQuery): Promise<ElementInfo | null> {
    const results = await this.findElements({ ...query, maxResults: 1 });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find element by name (convenience wrapper).
   * Searches by Name property. Optionally filter by controlType.
   */
  async findByName(
    name: string,
    controlType?: string,
    processId?: number,
  ): Promise<ElementInfo | null> {
    return this.findElement({
      name,
      controlType,
      processId: processId ?? this.defaultProcessId,
    });
  }

  /**
   * Find element by AutomationId (convenience wrapper).
   * AutomationIds are developer-assigned and tend to be more stable than Names.
   * On macOS, this searches by name (macOS doesn't have AutomationId).
   */
  async findByAutomationId(
    automationId: string,
    processId?: number,
  ): Promise<ElementInfo | null> {
    return this.findElement({
      automationId,
      processId: processId ?? this.defaultProcessId,
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // ELEMENT INTERACTION
  // ════════════════════════════════════════════════════════════════════

  /**
   * Click an element by Name or AutomationId.
   *
   * Strategy:
   * 1. Find the element in the UI tree
   * 2. Try InvokePattern (Win) or click() (Mac)
   * 3. Fall back to TogglePattern/coordinate click
   * 4. If both fail, return clickPoint for coordinate-based fallback
   *
   * @param nameOrId The element's Name or AutomationId
   * @param opts Additional search filters
   * @returns InteractionResult with success status and fallback coordinates
   */
  async clickElement(
    nameOrId: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    // First, find the element to get its processId if we don't have one
    if (!processId) {
      const element = await this.findElement({
        name: nameOrId,
        controlType: opts?.controlType,
      });

      if (!element) {
        // Try by automationId
        const byId = await this.findElement({ automationId: nameOrId });
        if (!byId) {
          return { success: false, error: `Element not found: "${nameOrId}"` };
        }
        return this.invokeAction({
          name: nameOrId,
          automationId: nameOrId,
          action: 'click',
          processId: byId.processId,
          controlType: opts?.controlType,
        });
      }

      return this.invokeAction({
        name: nameOrId,
        action: 'click',
        processId: element.processId,
        controlType: opts?.controlType,
      });
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'click',
      processId,
      controlType: opts?.controlType,
    });
  }

  /**
   * Type text into an element (text field, search box, etc.)
   *
   * Strategy:
   * 1. Find the element
   * 2. Try ValuePattern.SetValue() (Win) or set value property (Mac)
   * 3. If not supported, focus the element and use sendkeys/keystroke
   *
   * @param nameOrId The element's Name or AutomationId
   * @param text The text to type
   * @param opts Additional options
   */
  async typeInElement(
    nameOrId: string,
    text: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    // Resolve processId if needed
    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({
        name: nameOrId,
        controlType: opts?.controlType ?? 'Edit',
      });
      if (!element) {
        return { success: false, error: `Text field not found: "${nameOrId}"` };
      }
      resolvedPid = element.processId;
    }

    // Use set-value action (ValuePattern on Win, value property on Mac)
    const result = await this.invokeAction({
      name: nameOrId,
      action: 'set-value',
      value: text,
      processId: resolvedPid!,
      controlType: opts?.controlType,
    });

    // If ValuePattern/value property isn't supported, try focus + SendKeys approach
    if (!result.success && (result.error?.includes('ValuePattern not supported') || result.error?.includes('Failed to set value'))) {
      console.log(`   ⌨️ Value setting not supported for "${nameOrId}", trying focus + sendkeys`);

      // Try the sendkeys action (works on both platforms)
      const sendkeysResult = await this.invokeAction({
        name: nameOrId,
        action: 'sendkeys',
        value: text,
        processId: resolvedPid!,
        controlType: opts?.controlType,
      });

      if (sendkeysResult.success) {
        return { success: true, method: 'SendKeys', action: 'type' };
      }

      // Fall back: focus the element so caller can type
      const focusResult = await this.invokeAction({
        name: nameOrId,
        action: 'focus',
        processId: resolvedPid!,
        controlType: opts?.controlType,
      });

      if (focusResult.success) {
        return {
          success: true,
          method: 'Focus+CallerTypes',
          action: 'focus',
          error: 'Element focused — caller should use keyboard.type() to input text',
        };
      }

      return {
        success: false,
        error: `Cannot type into "${nameOrId}": value setting not supported and focus failed`,
      };
    }

    return result;
  }

  /**
   * Focus an element (set keyboard focus).
   * Useful before typing via keyboard or before using keyboard shortcuts.
   */
  async focusElement(
    nameOrId: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId });
      if (!element) {
        return { success: false, error: `Element not found: "${nameOrId}"` };
      }
      resolvedPid = element.processId;
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'focus',
      processId: resolvedPid!,
      controlType: opts?.controlType,
    });
  }

  /**
   * Get the bounding rectangle of an element in screen coordinates.
   *
   * Use this when you need to fall back to coordinate-based clicking
   * (e.g., for elements that don't support InvokePattern / click()).
   * Returns the center point as a convenience.
   */
  async getElementBounds(
    nameOrId: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<(BoundingRect & { centerX: number; centerY: number }) | null> {
    const element = await this.findElement({
      name: nameOrId,
      controlType: opts?.controlType,
      processId: opts?.processId ?? this.defaultProcessId,
    });

    if (!element || !element.bounds) return null;

    const { x, y, width, height } = element.bounds;

    // Validate bounds (UIA sometimes returns invalid/infinite values)
    if (width <= 0 || height <= 0 || x < -10000 || y < -10000) {
      return null;
    }

    return {
      x,
      y,
      width,
      height,
      centerX: Math.round(x + width / 2),
      centerY: Math.round(y + height / 2),
    };
  }

  /**
   * Get the current value of an element (text fields, labels, etc.)
   *
   * Tries ValuePattern (Win) / value property (Mac) first, then fallbacks.
   */
  async getElementValue(
    nameOrId: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<string | null> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId });
      if (!element) return null;
      resolvedPid = element.processId;
    }

    const result = await this.invokeAction({
      name: nameOrId,
      action: 'get-value',
      processId: resolvedPid!,
      controlType: opts?.controlType,
    });

    return result.success ? (result.value ?? null) : null;
  }

  // ════════════════════════════════════════════════════════════════════
  // ADVANCED INTERACTIONS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Toggle a checkbox or toggle button.
   * Uses TogglePattern (Win) or click-toggle (Mac).
   */
  async toggleElement(
    nameOrId: string,
    opts?: { processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId, controlType: 'CheckBox' });
      if (!element) {
        return { success: false, error: `Checkbox not found: "${nameOrId}"` };
      }
      resolvedPid = element.processId;
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'toggle',
      processId: resolvedPid!,
    });
  }

  /**
   * Expand a tree item, combo box, or other expandable element.
   * Uses ExpandCollapsePattern (Win) or click-expand (Mac).
   */
  async expandElement(
    nameOrId: string,
    opts?: { processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId });
      if (!element) return { success: false, error: `Element not found: "${nameOrId}"` };
      resolvedPid = element.processId;
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'expand',
      processId: resolvedPid!,
    });
  }

  /**
   * Collapse an expanded element.
   */
  async collapseElement(
    nameOrId: string,
    opts?: { processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId });
      if (!element) return { success: false, error: `Element not found: "${nameOrId}"` };
      resolvedPid = element.processId;
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'collapse',
      processId: resolvedPid!,
    });
  }

  /**
   * Select an item (list items, radio buttons, tab items).
   * Uses SelectionItemPattern (Win) or click-select (Mac).
   */
  async selectElement(
    nameOrId: string,
    opts?: { controlType?: string; processId?: number },
  ): Promise<InteractionResult> {
    const processId = opts?.processId ?? this.defaultProcessId;

    let resolvedPid = processId;
    if (!resolvedPid) {
      const element = await this.findElement({ name: nameOrId, controlType: opts?.controlType });
      if (!element) return { success: false, error: `Element not found: "${nameOrId}"` };
      resolvedPid = element.processId;
    }

    return this.invokeAction({
      name: nameOrId,
      action: 'select',
      processId: resolvedPid!,
      controlType: opts?.controlType,
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // POLLING / WAITING
  // ════════════════════════════════════════════════════════════════════

  /**
   * Wait for an element to appear in the UI tree.
   *
   * Polls at regular intervals until the element is found or timeout is reached.
   * Useful for waiting on dialogs, loading screens, or dynamically created elements.
   *
   * @param nameOrId Element Name or AutomationId to wait for
   * @param timeoutMs Maximum time to wait (default 10000ms)
   * @param pollIntervalMs How often to check (default 500ms)
   * @returns The found element, or null if timed out
   */
  async waitForElement(
    nameOrId: string,
    timeoutMs = 10_000,
    pollIntervalMs = 500,
  ): Promise<ElementInfo | null> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;

      // Try by Name first
      let element = await this.findElement({ name: nameOrId });

      // Try by AutomationId if Name didn't match
      if (!element) {
        element = await this.findElement({ automationId: nameOrId });
      }

      if (element) {
        console.log(`   ✅ waitForElement("${nameOrId}"): found after ${attempt} attempt(s)`);
        return element;
      }

      // Sleep before next poll
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }

    console.log(`   ⏰ waitForElement("${nameOrId}"): timed out after ${timeoutMs}ms`);
    return null;
  }

  /**
   * Wait for an element to disappear from the UI tree.
   * Useful for waiting on dialogs to close or loading indicators to vanish.
   */
  async waitForElementGone(
    nameOrId: string,
    timeoutMs = 10_000,
    pollIntervalMs = 500,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const element = await this.findElement({ name: nameOrId });
      if (!element) {
        return true; // Element is gone
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }

    return false; // Still present after timeout
  }

  // ════════════════════════════════════════════════════════════════════
  // HIGH-LEVEL COMPOUND ACTIONS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Click a menu item by navigating a menu path.
   *
   * Example: await driver.clickMenuPath(['File', 'Save As...'])
   *
   * Opens each menu level in sequence, with small delays for menu animations.
   */
  async clickMenuPath(menuPath: string[]): Promise<InteractionResult> {
    for (let i = 0; i < menuPath.length; i++) {
      const itemName = menuPath[i];
      const controlType = 'MenuItem';

      // Wait briefly for menu to appear (after first click)
      if (i > 0) {
        await this.sleep(200);
      }

      const result = await this.clickElement(itemName, { controlType });
      if (!result.success) {
        return {
          success: false,
          error: `Menu navigation failed at "${itemName}" (step ${i + 1}/${menuPath.length}): ${result.error}`,
        };
      }
    }

    return {
      success: true,
      method: 'MenuPath',
      action: 'click',
    };
  }

  /**
   * Fill a form by field name → value mapping.
   *
   * Example:
   *   await driver.fillForm({
   *     'First Name': 'John',
   *     'Last Name': 'Doe',
   *     'Email': 'john@example.com',
   *   });
   */
  async fillForm(
    fields: Record<string, string>,
  ): Promise<{ success: boolean; results: Record<string, InteractionResult> }> {
    const results: Record<string, InteractionResult> = {};
    let allSuccess = true;

    for (const [fieldName, value] of Object.entries(fields)) {
      const result = await this.typeInElement(fieldName, value);
      results[fieldName] = result;
      if (!result.success) {
        allSuccess = false;
        console.log(`   ⚠️ Failed to fill "${fieldName}": ${result.error}`);
      }
    }

    return { success: allSuccess, results };
  }

  // ════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Build script arguments for the find-element scripts.
   * Returns an array of -Key Value pairs that work for both PS1 and SH scripts.
   */
  private buildFindArgs(query: ElementQuery): string[] {
    const args: string[] = [];

    if (query.name) args.push('-Name', query.name);
    if (query.automationId) args.push('-AutomationId', query.automationId);
    if (query.controlType) args.push('-ControlType', query.controlType);
    if (query.processId ?? this.defaultProcessId) {
      args.push('-ProcessId', String(query.processId ?? this.defaultProcessId));
    }
    if (query.maxResults) args.push('-MaxResults', String(query.maxResults));

    return args;
  }

  /**
   * Invoke an action on an element.
   *
   * On Windows: calls invoke-element.ps1 (UIA Patterns)
   * On macOS: calls interact-element.sh → invoke-element.jxa (System Events)
   */
  private async invokeAction(opts: {
    name?: string;
    automationId?: string;
    action: string;
    value?: string;
    processId: number;
    controlType?: string;
  }): Promise<InteractionResult> {
    if (this.platform === 'unsupported') {
      return { success: false, error: `UIDriver: unsupported platform ${process.platform}` };
    }

    const args: string[] = [
      '-Action', opts.action,
      '-ProcessId', String(opts.processId),
    ];

    if (opts.name) args.push('-Name', opts.name);
    if (opts.automationId) args.push('-AutomationId', opts.automationId);
    if (opts.controlType) args.push('-ControlType', opts.controlType);
    if (opts.value) args.push('-Value', opts.value);

    try {
      let result: any;

      if (this.platform === 'win32') {
        // Windows: Use PowerShell invoke-element.ps1 for standard actions,
        // interact-element.ps1 for sendkeys
        if (opts.action === 'sendkeys') {
          result = await this.runPowerShell(WIN_INTERACT_SCRIPT, args);
        } else {
          result = await this.runPowerShell(WIN_INVOKE_SCRIPT, args);
        }
      } else {
        // macOS: Use interact-element.sh which routes to the appropriate JXA script
        result = await this.runShellScript(MAC_INTERACT_SCRIPT, args);
      }

      return result as InteractionResult;
    } catch (err) {
      return {
        success: false,
        error: `Invoke failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Run a PowerShell script and parse its JSON output. (Windows only)
   *
   * All PowerShell scripts in clawd-cursor follow the convention:
   * - Output JSON to stdout
   * - Include 'error' key on failure
   * - Include 'success' key for action scripts
   */
  private async runPowerShell(scriptPath: string, args: string[] = []): Promise<any> {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...args,
      ],
      {
        timeout: SCRIPT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      },
    );

    if (stderr && stderr.trim()) {
      console.warn(`   ⚠️ PowerShell stderr: ${stderr.substring(0, 200)}`);
    }

    return this.parseScriptOutput(stdout, scriptPath);
  }

  /**
   * Run a Bash shell script and parse its JSON output. (macOS only)
   *
   * All macOS shell scripts follow the same JSON output convention as Windows scripts.
   */
  private async runShellScript(scriptPath: string, args: string[] = []): Promise<any> {
    const { stdout, stderr } = await execFileAsync(
      'bash',
      [scriptPath, ...args],
      {
        timeout: SCRIPT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, PATH: `/usr/bin:/usr/local/bin:${process.env.PATH || ''}` },
      },
    );

    if (stderr && stderr.trim()) {
      console.warn(`   ⚠️ Shell stderr: ${stderr.substring(0, 200)}`);
    }

    return this.parseScriptOutput(stdout, scriptPath);
  }

  /**
   * Parse JSON output from a script (shared between PS and Bash).
   */
  private parseScriptOutput(stdout: string, scriptPath: string): any {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(`Empty output from ${path.basename(scriptPath)}`);
    }

    try {
      const result = JSON.parse(trimmed);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Invalid JSON from ${path.basename(scriptPath)}: ${trimmed.substring(0, 200)}`,
        );
      }
      throw err;
    }
  }

  /** Promise-based sleep */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
