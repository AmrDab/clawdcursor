// NOTE: On Bash/macOS, use && to chain commands (e.g., cd dir && npm start)
// On PowerShell (Windows), use ; instead of && (e.g., cd dir; npm start)

/**
 * Smart Interaction Layer — Layer 1.5 in the pipeline.
 *
 * Sits between BrowserLayer (Layer 0) and Computer Use (Layer 2).
 * Uses CDPDriver for browser DOM tasks and UIDriver for native app tasks.
 *
 * Strategy:
 *   1. Determine if the task is browser-oriented or native-app-oriented
 *   2. Gather context (DOM elements via CDP, or accessibility tree via UIDriver)
 *   3. Make ONE cheap LLM call (text-only) with context + task → get an action plan
 *   4. Execute each planned step via CDPDriver or UIDriver
 *   5. Return success/failure — if not handled, caller falls through to Computer Use
 *
 * Cost model:
 *   - 1 LLM call (text-only, cheapest model) → $0.001 or free (Ollama)
 *   - 0 screenshots, 0 vision calls
 *   - vs Computer Use: 18+ LLM calls with screenshots → $0.20+
 *
 * Pipeline position:
 *   Layer 0: BrowserLayer (Playwright) — navigation only
 *   Layer 1.5: SmartInteractionLayer (THIS) — CDPDriver + UIDriver
 *   Layer 2: Computer Use — screenshot+vision fallback (expensive)
 */

import { CDPDriver } from './cdp-driver';
import { UIDriver } from './ui-driver';
import { AccessibilityBridge } from './accessibility';
import { BrowserLayer } from './browser-layer';
import { NativeDesktop } from './native-desktop';
import { extractJsonObject } from './safe-json';
import { PROVIDERS } from './providers';
import { uiKnowledge } from './ui-knowledge';
import type { PipelineConfig, ProviderProfile } from './providers';
import type { ClawdConfig, StepResult } from './types';

// ── Types ──

/** A single planned step from the LLM */
export interface PlannedStep {
  /** Action to perform: click, type, pressKey, select, focus, wait, fillForm */
  action: string;
  /** Target element — text content, CSS selector, aria-label, or element name */
  target: string;
  /** How to find the target: "text", "selector", "label", "name", "automationId" */
  method: string;
  /** Text to type (for "type" and "fillForm" actions) */
  text?: string;
  /** Key to press (for "pressKey" action) */
  key?: string;
  /** Wait duration in ms (for "wait" action) */
  waitMs?: number;
  /** Form fields (for "fillForm" action) */
  fields?: Record<string, string>;
}

/** Result of the entire smart interaction attempt */
export interface SmartInteractionResult {
  /** Whether this layer handled the task (false = fall through to Computer Use) */
  handled: boolean;
  /** Whether the task succeeded (only meaningful if handled=true) */
  success: boolean;
  /** Detailed step results */
  steps: StepResult[];
  /** Number of LLM calls used (should be 0 or 1) */
  llmCalls: number;
  /** Optional description */
  description?: string;
  /** Summary of what was accomplished before falling through — passed to Computer Use as prior context */
  contextSummary?: string;
}

// ── System prompt for the planning LLM call ──

const DESCRIBE_SYSTEM_PROMPT = `You are a screen-reading assistant. Given the accessibility tree of the current screen, describe what the user sees in clear, concise plain English (2–4 sentences). Focus on the active window and the most prominent content visible. Do not mention accessibility tree internals or element IDs.`;

const PLANNING_SYSTEM_PROMPT = `You are a UI automation planner. Given a task and the current page/app context (list of interactive elements), return a JSON plan of steps to accomplish the task.

RESPONSE FORMAT — return ONLY valid JSON, no other text:
{
  "steps": [
    {"action": "click", "target": "Compose", "method": "text"},
    {"action": "type", "target": "[aria-label=\\"To recipients\\"]", "text": "user@email.com", "method": "selector"},
    {"action": "click", "target": "Send", "method": "text"}
  ],
  "canHandle": true,
  "reasoning": "Brief explanation of the plan"
}

AVAILABLE ACTIONS (browser tasks via CDP):
- navigate: Navigate to a URL. target=URL. Skip if already on that page.
- click: Click an element. method="text" (by visible text), "selector" (CSS), "label" (aria-label)
- type: Type text into a field. method="label" (PREFERRED — uses aria-label/for), "selector" (CSS)
- pressKey: Press a keyboard key. target=key name (e.g. "Enter", "Tab", "Control+a")
- select: Select dropdown option. method="selector", text=option value
- focus: Focus an element. method="selector" or "label"
- wait: Wait for something. waitMs=duration in ms
- fillForm: Fill multiple fields at once. fields={"Label": "value", ...}. PREFERRED for forms.

AVAILABLE ACTIONS (native app tasks via UIDriver):
- click: Click by element name. method="name" or "automationId"
- type: Type into element. method="name" or "automationId", text=value
- typeAtFocus: Type text directly at the currently focused element (no element lookup needed). Use after Tab navigation. text=value to type.
- pressKey: Press keyboard key. target=key combo
- focus: Focus element. method="name"
- select: Select item. method="name"
- toggle: Toggle checkbox. method="name"
- expand: Expand tree/combo. method="name"
- menuPath: Navigate menu. target=comma-separated path (e.g. "File,Save As...")

RULES:
1. Use ONLY elements visible in the context. Don't invent selectors — use exact aria-labels from the context.
2. For browser: prefer method="text" for buttons/links, method="label" for typing into inputs (uses exact aria-label from context).
3. For native apps: prefer method="name" for most elements.
4. If the task requires elements NOT in the context, set canHandle=false.
5. Keep plans SHORT — fewest steps possible. Prefer fillForm for multiple fields.
6. For keyboard shortcuts, use pressKey (e.g. "Control+s" for save).
7. Return {"canHandle": false, "reasoning": "explanation"} if the task is too complex or elements are missing.
8. After typing in a recipient/to field, add a pressKey "Tab" step to confirm the entry.
9. IMPORTANT: UI elements only exist AFTER their parent action. For example, Gmail compose fields only appear AFTER clicking "Compose". Plan sequentially: click to open a dialog/form FIRST, then add a wait step (1000-2000ms), then interact with the new elements.
10. For email compose flows: click Compose → wait 2000ms → click/type each field individually. Do NOT use fillForm unless all fields are visible in the current context.
11. When the context shows an inbox/list view, you MUST click "Compose"/"New"/"Reply" first before trying to fill email fields.
12. Prefer clicking fields by selector (e.g. [aria-label="To recipients"]) then typing, over fillForm — it's more reliable.
13. CRITICAL: Window titles (e.g. "Mail - John - Outlook", "Inbox - Gmail") are NOT clickable UI elements. Never use a window title as a click target. The window is already focused — proceed directly to interacting with its contents (buttons, fields, etc.).
14. For Outlook: to compose a new email use pressKey "Control+n" (new message shortcut) rather than trying to click "New Email" button — it's more reliable.`;

/** System prompt for the ReAct-style per-step native task handler */
const REACT_STEP_SYSTEM_PROMPT = `You are a UI automation agent controlling a native desktop app via accessibility APIs. You operate ONE STEP AT A TIME in a reactive loop.

You will receive:
- The current TASK
- The current ACCESSIBILITY TREE (fresh snapshot of visible UI elements)
- The HISTORY of actions taken so far (with results)

You must decide the SINGLE NEXT action to take. Respond with ONLY valid JSON, no other text.

RESPONSE FORMAT — one of:
{"action": "click", "target": "Button Name", "method": "name", "reasoning": "Why this click"}
{"action": "type", "target": "Field Name", "text": "text to type", "method": "name", "reasoning": "Why typing this"}
{"action": "pressKey", "target": "Control+n", "reasoning": "Keyboard shortcut to open new message"}
{"action": "focus", "target": "Element Name", "method": "name", "reasoning": "Focus this element"}
{"action": "select", "target": "Item Name", "method": "name", "reasoning": "Select this item"}
{"action": "toggle", "target": "Checkbox Name", "method": "name", "reasoning": "Toggle checkbox"}
{"action": "expand", "target": "Tree Item", "method": "name", "reasoning": "Expand this item"}
{"action": "menuPath", "target": "File,Save As...", "reasoning": "Navigate menu path"}
{"action": "wait", "waitMs": 1000, "reasoning": "Wait for UI to update"}
{"action": "done", "reasoning": "Task is complete because X"}
{"action": "give_up", "reasoning": "Cannot complete because X"}

AVAILABLE ACTIONS:
- click: Click by element name/automationId. method="name" or "automationId"
- type: Type into element. method="name" or "automationId", text=value
- typeAtFocus: Type text directly at the currently focused element (no element lookup needed). Use after Tab navigation. text=value to type.
- pressKey: Press keyboard key combo. target=key combo (e.g. "Control+n", "Tab", "Return", "Escape")
- focus: Focus element. method="name"
- select: Select item. method="name"
- toggle: Toggle checkbox. method="name"
- expand: Expand tree/combo. method="name"
- menuPath: Navigate menu. target=comma-separated path
- wait: Wait for UI to settle. waitMs=duration in ms
- done: Task is complete — explain why in reasoning
- give_up: Cannot complete — explain why in reasoning

RULES:
1. Decide ONE action at a time based on what you SEE in the current accessibility tree.
2. Use ONLY elements visible in the current tree. Don't guess at elements that might appear later.
3. If the previous action failed, adapt — try an alternative approach (different element, keyboard shortcut, etc.).
4. If you see an unexpected dialog/popup in the tree, handle it first (Escape or click its button) before continuing.
5. Window titles like "Mail - John - Outlook" are NOT clickable. The window is already focused.
6. For Outlook: use pressKey "Control+n" for new message rather than clicking buttons.
7. After typing in a recipient/to field, use pressKey "Tab" to confirm.
8. If you've been going in circles or the same action keeps failing, give_up.
9. When the task appears complete based on what you see, return done.
10. Prefer keyboard shortcuts when they're reliable (Control+s for save, Control+n for new, etc.).
11. If an element is not found by name, try Tab key navigation or keyboard shortcuts instead. Do NOT give_up immediately — try at least 2 alternatives first.
12. KEYBOARD-FIRST RULE: For email composition in any mail app (Outlook, Gmail, etc.), ALWAYS use this exact sequence: pressKey Control+n → pressKey Tab → typeAtFocus (recipient) → pressKey Tab → typeAtFocus (subject) → pressKey Tab → typeAtFocus (body) → pressKey Control+Enter (send). Never try to click field names — use Tab navigation + typeAtFocus instead.`;

/**
 * SmartInteractionLayer — the orchestration layer between BrowserLayer and Computer Use.
 */
export class SmartInteractionLayer {
  private a11y: AccessibilityBridge;
  private config: ClawdConfig;
  private pipelineConfig: PipelineConfig | null;
  private desktop: NativeDesktop;

  // Lazy-initialized drivers
  private cdpDriver: CDPDriver | null = null;
  private uiDriver: UIDriver | null = null;

  // Circuit breaker
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 3;
  private disabled = false;

  // For state change polling
  private lastWindowTitle = '';

  constructor(
    a11y: AccessibilityBridge,
    config: ClawdConfig,
    pipelineConfig: PipelineConfig | null,
    desktop: NativeDesktop,
  ) {
    this.a11y = a11y;
    this.config = config;
    this.pipelineConfig = pipelineConfig;
    this.desktop = desktop;
  }

  /** Check if this layer is available (has a text model configured) */
  isAvailable(): boolean {
    if (this.disabled) return false;
    // Need either pipeline config with text model, or an API key
    if (this.pipelineConfig?.layer2.enabled) return true;
    if (this.config.ai.apiKey && this.config.ai.apiKey.length > 0) return true;
    return false;
  }

  /**
   * Try to handle a task using CDP (browser) or UIDriver (native app).
   *
   * @param task The full task string
   * @param isBrowserTask Whether BrowserLayer detected this as a browser task
   * @returns SmartInteractionResult — check .handled to decide whether to fall through
   */
  async tryHandle(task: string, isBrowserTask: boolean): Promise<SmartInteractionResult> {
    if (!this.isAvailable()) {
      return { handled: false, success: false, steps: [], llmCalls: 0, description: 'SmartInteraction disabled' };
    }

    const startTime = Date.now();

    try {
      let result: SmartInteractionResult;

      // Fast path: tasks that require a visual loop (screenshot → read → respond → repeat)
      // cannot be planned by a text LLM up-front — skip straight to Computer Use.
      if (this.isVisualLoopTask(task)) {
        console.log(`   ⏭️  Smart Interaction: visual loop task detected — handing off to Computer Use`);
        return { handled: false, success: false, steps: [], llmCalls: 0, description: 'Visual loop task — Computer Use required' };
      }

      // Fast path: describe/read-only tasks are answered directly from a11y context
      // — no Computer Use (screenshot + vision) needed.
      if (this.isDescribeTask(task)) {
        result = await this.handleDescribeTask(task);
      } else if (isBrowserTask) {
        result = await this.handleBrowserTask(task);
        // CDP failed → fall back to UIDriver (accessibility tree) before giving up
        if (!result.handled || !result.success) {
          console.log(`   🔄 Smart Interaction: CDP path failed — trying UIDriver (accessibility tree)`);
          result = await this.handleNativeTask(task);
        }
      } else {
        result = await this.handleNativeTask(task);
      }

      if (result.handled && result.success) {
        this.consecutiveFailures = 0;
        console.log(`   ✅ Smart Interaction handled in ${Date.now() - startTime}ms (${result.llmCalls} LLM call)`);
      }

      return result;
    } catch (err) {
      this.consecutiveFailures++;
      console.log(`   ⚠️ Smart Interaction error (${this.consecutiveFailures}/${this.MAX_FAILURES}): ${err}`);

      if (this.consecutiveFailures >= this.MAX_FAILURES) {
        this.disabled = true;
        console.log(`   🔴 Smart Interaction circuit breaker tripped — disabled for this session`);
      }

      return {
        handled: false,
        success: false,
        steps: [{ action: 'error', description: `Smart Interaction error: ${err}`, success: false, timestamp: Date.now() }],
        llmCalls: 0,
      };
    }
  }

  /** Reset circuit breaker */
  reset(): void {
    this.disabled = false;
    this.consecutiveFailures = 0;
  }

  /** Clean up resources */
  async disconnect(): Promise<void> {
    if (this.cdpDriver) {
      await this.cdpDriver.disconnect();
      this.cdpDriver = null;
    }
    // UIDriver doesn't need cleanup
  }

  // ════════════════════════════════════════════════════════════════════
  // BROWSER TASK HANDLING (CDPDriver)
  // ════════════════════════════════════════════════════════════════════

  private async handleBrowserTask(task: string): Promise<SmartInteractionResult> {
    const steps: StepResult[] = [];

    // Lazy-connect CDPDriver
    if (!this.cdpDriver) {
      this.cdpDriver = new CDPDriver();
    }

    const connected = await this.cdpDriver.isConnected() || await this.cdpDriver.connect();
    if (!connected) {
      console.log(`   ⚠️ Smart Interaction: CDPDriver can't connect to CDP port — falling through`);
      return { handled: false, success: false, steps: [], llmCalls: 0, description: 'CDP connection failed' };
    }

    // Get page context (DOM elements)
    console.log(`   🔌 Smart Interaction: getting page context via CDP...`);
    const pageContext = await this.cdpDriver.getPageContext();

    if (!pageContext || pageContext.includes('unavailable')) {
      return { handled: false, success: false, steps: [], llmCalls: 0, description: 'Page context unavailable' };
    }

    // Make ONE LLM call to plan actions
    console.log(`   🧠 Smart Interaction: planning with text LLM...`);
    const plan = await this.planActions(task, pageContext, 'browser');

    if (!plan || !plan.canHandle) {
      console.log(`   🤷 Smart Interaction: LLM says can't handle — ${plan?.reasoning || 'no plan'}`);
      return {
        handled: false,
        success: false,
        steps: [{ action: 'plan', description: `Can't handle: ${plan?.reasoning || 'unknown'}`, success: false, timestamp: Date.now() }],
        llmCalls: 1,
        description: plan?.reasoning,
      };
    }

    steps.push({
      action: 'plan',
      description: `Planned ${plan.steps.length} steps: ${plan.reasoning || ''}`,
      success: true,
      timestamp: Date.now(),
    });

    // Execute each planned step — continue on non-critical failures
    let criticalFailure = false;
    for (const plannedStep of plan.steps) {
      const stepResult = await this.executeBrowserStep(plannedStep);
      steps.push(stepResult);

      if (!stepResult.success) {
        console.log(`   ⚠️ Step failed: ${stepResult.description}`);
        // For critical actions (type, fillForm), abort — data won't be entered
        const criticalActions = ['type', 'fillForm'];
        if (criticalActions.includes(plannedStep.action)) {
          console.log(`   ❌ Critical step failed — falling through`);
          criticalFailure = true;
          break;
        }
        // Non-critical (navigate, wait, focus) — continue
        console.log(`   ⏭️ Non-critical, continuing...`);
      }

      // Small delay between actions for UI to settle
      await this.delay(500);
    }

    if (criticalFailure) {
      return { handled: false, success: false, steps, llmCalls: 1, description: 'Critical step failed' };
    }

    return {
      handled: true,
      success: true,
      steps,
      llmCalls: 1,
      description: `Completed ${plan.steps.length} browser actions`,
    };
  }

  private async executeBrowserStep(step: PlannedStep): Promise<StepResult> {
    const cdp = this.cdpDriver!;
    const ts = Date.now();

    try {
      switch (step.action) {
        case 'click': {
          const result = step.method === 'selector'
            ? await cdp.click(step.target)
            : step.method === 'label'
              ? await cdp.clickByText(step.target)
              : await cdp.clickByText(step.target); // default: text
          return { action: 'click', description: `Click "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'type': {
          const result = step.method === 'selector'
            ? await cdp.typeInField(step.target, step.text || '')
            : step.method === 'label'
              ? await cdp.typeByLabel(step.target, step.text || '')
              : await cdp.typeByLabel(step.target, step.text || ''); // default: label
          return { action: 'type', description: `Type "${step.text}" into "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'pressKey': {
          const result = await cdp.pressKey(step.target);
          return { action: 'pressKey', description: `Press ${step.target}`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'select': {
          const result = await cdp.selectOption(step.target, step.text || '');
          return { action: 'select', description: `Select "${step.text}" in "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'focus': {
          const result = step.method === 'selector'
            ? await cdp.focus(step.target)
            : await cdp.focus(step.target);
          return { action: 'focus', description: `Focus "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'fillForm': {
          if (step.fields) {
            const result = await cdp.fillFormByLabels(step.fields);
            const desc = Object.keys(step.fields).join(', ');
            return { action: 'fillForm', description: `Fill form: ${desc}`, success: result.success, timestamp: ts };
          }
          return { action: 'fillForm', description: 'No fields provided', success: false, timestamp: ts };
        }

        case 'wait': {
          await this.delay(step.waitMs || 1000);
          return { action: 'wait', description: `Wait ${step.waitMs || 1000}ms`, success: true, timestamp: ts };
        }

        case 'navigate': {
          // Navigation may already be done by BrowserLayer — skip if URL matches
          const page = (cdp as any).activePage;
          if (page && step.target) {
            const currentUrl = page.url();
            if (currentUrl.includes(step.target.replace('https://', '').replace('http://', '').split('/')[0])) {
              return { action: 'navigate', description: `Already at ${step.target} — skipped`, success: true, timestamp: ts };
            }
            await page.goto(step.target, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
          return { action: 'navigate', description: `Navigate to ${step.target}`, success: true, timestamp: ts };
        }

        case 'skip':
          return { action: 'skip', description: step.target || 'Skipped', success: true, timestamp: ts };

        default:
          return { action: step.action, description: `Unknown action: ${step.action}`, success: false, timestamp: ts };
      }
    } catch (err) {
      return {
        action: step.action,
        description: `Exception in ${step.action}: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        error: String(err),
        timestamp: ts,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // NATIVE APP TASK HANDLING (UIDriver)
  // ════════════════════════════════════════════════════════════════════

  private async handleNativeTask(task: string): Promise<SmartInteractionResult> {
    const steps: StepResult[] = [];
    const MAX_REACT_STEPS = 10;
    let llmCalls = 0;

    // Lazy-create UIDriver (no connection needed)
    if (!this.uiDriver) {
      this.uiDriver = new UIDriver();
    }

    // Get accessibility tree context (initial check)
    console.log(`   ♿ Smart Interaction: getting accessibility context...`);
    const activeWindow = await this.a11y.getActiveWindow();

    // Fast path: if task requires opening an app that isn't currently active,
    // skip planning — Computer Use handles app launching much better.
    const openAppMatch = task.match(/^open\s+(\w+)/i);
    if (openAppMatch) {
      const targetApp = openAppMatch[1].toLowerCase();
      const activeWindowTitle = (activeWindow?.title || '').toLowerCase();
      const activeWindowProcess = (activeWindow?.processName || '').toLowerCase();
      if (!activeWindowTitle.includes(targetApp) && !activeWindowProcess.includes(targetApp)) {
        console.log(`   ⏭️ Smart Interaction: "${targetApp}" not in active window — skipping to Computer Use`);
        return { handled: false, success: false, steps: [], llmCalls: 0, description: `Target app "${targetApp}" not active` };
      }
    }

    // ── UI Knowledge Layer: load app-specific instruction set ──
    const currentWindow = await this.a11y.getActiveWindow();
    const windowTitle = currentWindow?.title || '';
    const knowledgeContext = await uiKnowledge.getContextForTask(task, windowTitle).catch(() => null);

    // ── ReAct Loop: step-by-step reactive execution ──
    const actionHistory: Array<{ action: string; target?: string; text?: string; success: boolean; error?: string; stateAfter?: string }> = [];
    let successfulActions = 0; // Track meaningful progress for partial-success detection
    let elementNotFoundRetries = 0; // Separate retry counter for Tab-key fallbacks

    console.log(`   🔄 Smart Interaction: starting ReAct loop (max ${MAX_REACT_STEPS} steps)...`);

    // Track current a11y state for polling
    let currentA11yState = '';

    for (let step = 0; step < MAX_REACT_STEPS; step++) {
      // 1. Get FRESH a11y snapshot each iteration
      const currentWindow = await this.a11y.getActiveWindow();
      const a11yContext = await this.a11y.getScreenContext(currentWindow?.processId).catch(() => '');
      currentA11yState = a11yContext;

      if (!a11yContext || a11yContext.includes('unavailable')) {
        if (step === 0) {
          return { handled: false, success: false, steps, llmCalls, description: 'A11y context unavailable' };
        }
        // Mid-loop: context lost, give up
        console.log(`   ⚠️ ReAct step ${step + 1}: a11y context lost — giving up`);
        break;
      }

      // 2. Build history string for LLM context
      const historyStr = actionHistory.length > 0
        ? actionHistory.map((h, i) =>
            `Step ${i + 1}: ${h.action}${h.target ? ` "${h.target}"` : ''}${h.text ? ` text="${h.text}"` : ''} → ${h.success ? 'SUCCESS' : `FAILED: ${h.error || 'unknown'}`}${h.stateAfter ? `\n  State after: ${h.stateAfter}` : ''}`
          ).join('\n')
        : '(no actions taken yet)';

      const knowledgeSection = knowledgeContext ? `\nAPP INSTRUCTION MANUAL:\n${knowledgeContext}\n` : '';
      const userMessage = `TASK: ${task}${knowledgeSection}\n\nACTION HISTORY:\n${historyStr}\n\nCURRENT ACCESSIBILITY TREE:\n${a11yContext}`;

      // 3. LLM decides ONE next action
      console.log(`   🧠 ReAct step ${step + 1}/${MAX_REACT_STEPS}: asking LLM...`);
      llmCalls++;

      let response: string;
      try {
        response = await this.callTextModel(userMessage, REACT_STEP_SYSTEM_PROMPT);
      } catch (err) {
        console.log(`   ⚠️ ReAct step ${step + 1}: LLM call failed — ${err}`);
        steps.push({ action: 'error', description: `LLM call failed: ${err}`, success: false, timestamp: Date.now() });
        break;
      }

      // 4. Parse LLM response
      const decision = extractJsonObject(response) as any;
      if (!decision) {
        console.log(`   ⚠️ ReAct step ${step + 1}: no valid JSON in LLM response`);
        actionHistory.push({ action: 'parse_error', success: false, error: 'LLM returned no valid JSON' });
        continue;
      }

      const action = decision.action;
      const reasoning = decision.reasoning || '';

      // Handle "wait" action — make it free (no step counter increment)
      if (action === 'wait') {
        // Don't count as a step — just poll silently
        console.log(`   ⏳ Auto-polling for state change (free step)...`);
        currentA11yState = await this.pollUntilStateChanges(currentA11yState, 3000);
        continue; // don't increment step counter
      }

      // 5. Handle terminal actions
      if (action === 'done') {
        console.log(`   ✅ ReAct: done — ${reasoning}`);
        steps.push({ action: 'done', description: `ReAct complete: ${reasoning}`, success: true, timestamp: Date.now() });
        return {
          handled: true,
          success: true,
          steps,
          llmCalls,
          description: `ReAct completed in ${step + 1} steps: ${reasoning}`,
        };
      }

      if (action === 'give_up') {
        if (successfulActions > 0) {
          // Partial progress was made — report success so caller can continue with Computer Use
          console.log(`   🔄 ReAct: give_up but ${successfulActions} actions succeeded — reporting partial progress`);
          const completedSteps = actionHistory
            .filter(h => h.success && h.action !== 'parse_error' && h.action !== 'wait')
            .map(h => `${h.action}${h.target ? ` "${h.target}"` : ''}${h.text ? ` text="${h.text}"` : ''}`)
            .join(', ');
          const contextSummary = `Completed ${successfulActions} actions: ${completedSteps}. Gave up because: ${reasoning}`;
          steps.push({ action: 'give_up_partial', description: `ReAct partial progress: ${reasoning}`, success: true, timestamp: Date.now() });
          return {
            handled: false,
            success: false,
            steps,
            llmCalls,
            description: `ReAct gave up after ${step + 1} steps (${successfulActions} succeeded): ${reasoning}`,
            contextSummary,
          };
        }
        console.log(`   🤷 ReAct: give_up (zero progress) — ${reasoning}`);
        steps.push({ action: 'give_up', description: `ReAct gave up: ${reasoning}`, success: false, timestamp: Date.now() });
        return {
          handled: false,
          success: false,
          steps,
          llmCalls,
          description: `ReAct gave up after ${step + 1} steps: ${reasoning}`,
        };
      }

      // 6. Build PlannedStep and execute
      const plannedStep: PlannedStep = {
        action: action || 'click',
        target: decision.target || '',
        method: decision.method || 'name',
        text: decision.text,
        key: decision.key,
        waitMs: decision.waitMs,
        fields: decision.fields,
      };

      console.log(`   ▶️ ReAct step ${step + 1}: ${action} "${plannedStep.target || ''}" — ${reasoning}`);

      let stepResult = await this.executeNativeStep(plannedStep);

      // After pressKey or typeAtFocus — poll for state change instead of burning LLM steps
      if (stepResult.action === 'pressKey' || stepResult.action === 'typeAtFocus') {
        const updatedState = await this.pollUntilStateChanges(currentA11yState, 5000);
        if (updatedState !== currentA11yState) {
          currentA11yState = updatedState;
          console.log(`   ✅ State changed after ${stepResult.description} — proceeding`);
        }
      }

      // Fallback: if click fails with "Element not found", try Tab key navigation
      if (!stepResult.success && action === 'click' && stepResult.error?.includes('not found') && elementNotFoundRetries < 3) {
        elementNotFoundRetries++;
        console.log(`   🔄 Element not found — trying Tab key fallback (retry ${elementNotFoundRetries}/3)`);
        const tabStep: PlannedStep = { action: 'pressKey', target: 'Tab', method: 'name' };
        const tabResult = await this.executeNativeStep(tabStep);
        steps.push(tabResult);
        await this.delay(300);

        // Retry the original click after Tab
        stepResult = await this.executeNativeStep(plannedStep);
        if (stepResult.success) {
          console.log(`   ✅ Tab fallback worked — element found after keyboard navigation`);
          elementNotFoundRetries = 0; // Reset on success
        }
        // If fallback also fails, count as a normal step (LLM will adapt)
      }

      steps.push(stepResult);

      // 7. Capture fresh a11y state AFTER the action for verification
      // Small delay for UI to settle before capturing state
      const postActionDelay = action === 'typeAtFocus' ? 300 : action === 'pressKey' ? 500 : 400;
      await this.delay(postActionDelay);

      let stateAfter: string | undefined;
      let focusVerification = '';
      try {
        // Always check focused element after action — this is the KEY checkpoint
        const focused = await this.a11y.getFocusedElement();
        if (focused) {
          focusVerification = `Focus: [${focused.controlType}] "${focused.name}"`;
          if (focused.value) focusVerification += ` value="${focused.value.substring(0, 80)}"`;
          focusVerification += ` @${focused.bounds.x},${focused.bounds.y}`;

          // VERIFICATION: After type/typeAtFocus, confirm text was actually entered
          if ((action === 'type' || action === 'typeAtFocus') && stepResult.success && plannedStep.text) {
            const typedText = plannedStep.text.substring(0, 20);
            if (focused.value && focused.value.includes(typedText)) {
              focusVerification += ' ✓ TEXT CONFIRMED';
            } else if (focused.value === '' || !focused.value) {
              focusVerification += ' ⚠️ VALUE EMPTY — text may not have been entered';
              // Mark as potentially failed so LLM can retry
              stepResult = { ...stepResult, description: stepResult.description + ' (⚠️ verification: value empty)' };
            }
          }
        }

        const postWindow = await this.a11y.getActiveWindow();
        this.a11y.invalidateCache(); // force fresh context
        const postA11y = await this.a11y.getScreenContext(postWindow?.processId).catch(() => '');
        if (postA11y && !postA11y.includes('unavailable')) {
          stateAfter = `${focusVerification}\n${postA11y.substring(0, 500)}`;
        } else {
          stateAfter = focusVerification;
        }
      } catch {
        // Non-fatal — state capture failed
      }

      // Record result with post-action state for next iteration's history
      actionHistory.push({
        action,
        target: plannedStep.target,
        text: plannedStep.text,
        success: stepResult.success,
        error: stepResult.error,
        stateAfter,
      });

      if (stepResult.success && action !== 'wait') {
        successfulActions++;
      }

      if (!stepResult.success) {
        console.log(`   ⚠️ ReAct step ${step + 1} failed: ${stepResult.error || stepResult.description} — LLM will adapt`);
      }
    }

    // Exhausted max steps without done/give_up — build context summary of what was accomplished
    console.log(`   ⏰ ReAct: exhausted ${MAX_REACT_STEPS} steps — falling through to Computer Use`);
    let contextSummary: string | undefined;
    if (successfulActions > 0) {
      const completedSteps = actionHistory
        .filter(h => h.success && h.action !== 'parse_error' && h.action !== 'wait')
        .map(h => `${h.action}${h.target ? ` "${h.target}"` : ''}${h.text ? ` text="${h.text}"` : ''}`)
        .join(', ');
      contextSummary = `Completed ${successfulActions} of ${MAX_REACT_STEPS} steps: ${completedSteps}. Exhausted max steps — remaining work needs to be continued.`;
    }
    return {
      handled: false,
      success: false,
      steps,
      llmCalls,
      description: `ReAct exhausted ${MAX_REACT_STEPS} steps without completing`,
      contextSummary,
    };
  }

  /**
   * Execute a native UI action.
   *
   * PRIMARY path: AccessibilityBridge → PSRunner (persistent PS, fuzzy matching, <50ms/call)
   * FALLBACK path: UIDriver (spawns PS process, exact matching, 15s timeout)
   *
   * This is the key reliability fix: ps-bridge.ps1 has fuzzy name matching
   * (case-insensitive contains) and is ~100x faster than per-call PS spawns.
   */
  private async executeNativeStep(step: PlannedStep): Promise<StepResult> {
    const ui = this.uiDriver!;
    const ts = Date.now();

    // Get current active window's processId for scoped element search
    const activeWin = await this.a11y.getActiveWindow().catch(() => null);
    const activePid = activeWin?.processId;

    try {
      switch (step.action) {
        case 'click': {
          // Window titles are NOT clickable — skip them
          const isWindowTitle = /\s[-–]\s/.test(step.target) && step.target.length > 20;
          if (isWindowTitle) {
            console.log(`   ⏭️ Skipping window-title click target "${step.target}" — window already focused`);
            return { action: 'click', description: `Skipped window-title: "${step.target}"`, success: true, timestamp: ts };
          }

          // PRIMARY: Use AccessibilityBridge (PSRunner — fast, fuzzy matching)
          const a11yResult = await this.a11y.invokeElement({
            name: step.target,
            action: 'click',
            processId: activePid,
          });

          if (a11yResult.success) {
            return { action: 'click', description: `Click "${step.target}" (PSRunner)`, success: true, timestamp: ts };
          }

          // If PSRunner returned a clickPoint (no InvokePattern), do coordinate click
          if (a11yResult.clickPoint) {
            await this.desktop.mouseClick(a11yResult.clickPoint.x, a11yResult.clickPoint.y);
            return { action: 'click', description: `Click "${step.target}" at (${a11yResult.clickPoint.x},${a11yResult.clickPoint.y})`, success: true, timestamp: ts };
          }

          // FALLBACK: UIDriver (slower, but has more click strategies)
          console.log(`   🔄 PSRunner click failed — trying UIDriver fallback`);
          const uiResult = await ui.clickElement(step.target);
          return { action: 'click', description: `Click "${step.target}"`, success: uiResult.success, error: uiResult.error || a11yResult.error, timestamp: ts };
        }

        case 'type': {
          // PRIMARY: Use AccessibilityBridge set-value (PSRunner — fast, fuzzy matching)
          const a11yResult = await this.a11y.invokeElement({
            name: step.target,
            action: 'set-value',
            value: step.text || '',
            processId: activePid,
          });

          if (a11yResult.success) {
            return { action: 'type', description: `Type "${step.text}" into "${step.target}" (PSRunner)`, success: true, timestamp: ts };
          }

          // FALLBACK 1: Focus element + type at focus
          console.log(`   🔄 PSRunner set-value failed — trying focus + typeAtFocus`);
          const focusResult = await this.a11y.invokeElement({
            name: step.target,
            action: 'focus',
            processId: activePid,
          });
          if (focusResult.success) {
            await this.delay(100); // brief settle after focus
            const typeResult = await ui.typeAtCurrentFocus(step.text || '');
            if (typeResult.success) {
              return { action: 'type', description: `Type "${step.text}" into "${step.target}" (focus+type)`, success: true, timestamp: ts };
            }
          }

          // FALLBACK 2: UIDriver typeInElement (spawns PS, has its own fallback chain)
          console.log(`   🔄 Focus+type failed — trying UIDriver fallback`);
          const uiResult = await ui.typeInElement(step.target, step.text || '');
          if (!uiResult.success) {
            // Last resort: type at current focus (assumes focus is already correct)
            console.log(`   🔄 UIDriver type failed — last resort: typeAtFocus`);
            const fallback = await ui.typeAtCurrentFocus(step.text || '');
            return { action: 'type', description: `Type "${step.text}" (typeAtFocus fallback)`, success: fallback.success, error: fallback.error, timestamp: ts };
          }
          return { action: 'type', description: `Type "${step.text}" into "${step.target}"`, success: uiResult.success, error: uiResult.error, timestamp: ts };
        }

        case 'typeAtFocus': {
          // Type directly at current focus — no element lookup needed
          const result = await ui.typeAtCurrentFocus(step.text || '');

          // POST-ACTION VERIFICATION: Read focused element value to confirm text was entered
          let verified = false;
          if (result.success) {
            try {
              const focused = await this.a11y.getFocusedElement();
              if (focused?.value && focused.value.includes((step.text || '').substring(0, 10))) {
                verified = true;
              }
            } catch { /* verification non-fatal */ }
          }

          const desc = result.success
            ? `Typed at focus: '${step.text}'${verified ? ' ✓ verified' : ' — ⚠️ UNVERIFIED'}`
            : `Typed at focus: '${step.text}' — FAILED`;
          return { action: 'typeAtFocus', description: desc, success: result.success, error: result.error, timestamp: ts };
        }

        case 'pressKey': {
          await this.desktop.keyPress(step.target);
          return {
            action: 'pressKey',
            description: `Pressed ${step.target}`,
            success: true,
            timestamp: ts,
          };
        }

        case 'focus': {
          // PRIMARY: PSRunner (fast)
          const a11yResult = await this.a11y.invokeElement({
            name: step.target,
            action: 'focus',
            processId: activePid,
          });
          if (a11yResult.success) {
            return { action: 'focus', description: `Focus "${step.target}" (PSRunner)`, success: true, timestamp: ts };
          }
          // FALLBACK: UIDriver
          const result = await ui.focusElement(step.target);
          return { action: 'focus', description: `Focus "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'toggle': {
          const result = await ui.toggleElement(step.target);
          return { action: 'toggle', description: `Toggle "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'expand': {
          // PSRunner supports expand
          const a11yResult = await this.a11y.invokeElement({
            name: step.target,
            action: 'expand',
            processId: activePid,
          });
          if (a11yResult.success) {
            return { action: 'expand', description: `Expand "${step.target}" (PSRunner)`, success: true, timestamp: ts };
          }
          const result = await ui.expandElement(step.target);
          return { action: 'expand', description: `Expand "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'select': {
          const result = await ui.selectElement(step.target);
          return { action: 'select', description: `Select "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'menuPath': {
          const menuItems = step.target.split(',').map(s => s.trim());
          const result = await ui.clickMenuPath(menuItems);
          return { action: 'menuPath', description: `Menu: ${step.target}`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'fillForm': {
          if (step.fields) {
            // Fill each field via PSRunner with focus verification
            let allSuccess = true;
            const fieldNames: string[] = [];
            for (const [fieldName, value] of Object.entries(step.fields)) {
              fieldNames.push(fieldName);
              const setResult = await this.a11y.invokeElement({
                name: fieldName,
                action: 'set-value',
                value,
                processId: activePid,
              });
              if (!setResult.success) {
                // Fallback: focus + type
                const focusR = await this.a11y.invokeElement({ name: fieldName, action: 'focus', processId: activePid });
                if (focusR.success) {
                  await this.delay(100);
                  const typeR = await ui.typeAtCurrentFocus(value);
                  if (!typeR.success) allSuccess = false;
                } else {
                  allSuccess = false;
                }
              }
            }
            return { action: 'fillForm', description: `Fill form: ${fieldNames.join(', ')}`, success: allSuccess, timestamp: ts };
          }
          return { action: 'fillForm', description: 'No fields provided', success: false, timestamp: ts };
        }

        case 'wait': {
          if (step.target) {
            const el = await ui.waitForElement(step.target, step.waitMs || 5000);
            return { action: 'wait', description: `Wait for "${step.target}"`, success: el !== null, timestamp: ts };
          }
          await this.delay(step.waitMs || 1000);
          return { action: 'wait', description: `Wait ${step.waitMs || 1000}ms`, success: true, timestamp: ts };
        }

        default:
          return { action: step.action, description: `Unknown native action: ${step.action}`, success: false, timestamp: ts };
      }
    } catch (err) {
      return {
        action: step.action,
        description: `Exception in ${step.action}: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        error: String(err),
        timestamp: ts,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // DESCRIBE TASK HANDLING
  // ════════════════════════════════════════════════════════════════════

  /**
   * Returns true if the task is purely a read/describe request that requires
   * no UI actions — only a plain-English summary of what's on screen.
   */
  /**
   * Tasks that require repeated screenshot → vision → act cycles can't be
   * pre-planned by a text LLM. Detect them early and skip to Computer Use.
   */
  private isVisualLoopTask(task: string): boolean {
    const t = task.toLowerCase();
    // Explicit loop / repeat / until keywords combined with screenshot or visual monitoring
    const hasLoop = /\b(loop|repeat|keep doing|every time|until (done|complete|nothing left|finished))\b/.test(t);
    const hasScreenshot = /\b(screenshot|take a screenshot|screen capture)\b/.test(t);
    const hasWaitAndRespond = /\b(wait for.*(respond|response|reply)|monitor progress)\b/.test(t);
    // Drawing tasks require visual feedback loops (draw -> look -> adjust -> repeat)
    const isDrawingTask = /\bdraw\b/i.test(task);
    return (hasLoop && hasScreenshot) || (hasLoop && hasWaitAndRespond) || isDrawingTask;
  }

  private isDescribeTask(task: string): boolean {
    const t = task.trim();
    return /^(describe|what(?:'s| is)|tell me|show me|explain)\s+(what'?s?\s+)?(on|the|in|about)?\s*(screen|page|window|app|visible|open|current)/i.test(t)
      || /^what(?:'s| is)\s+(on\s+)?(my\s+)?(screen|page|window|display)/i.test(t)
      || /^(look at|read)\s+(the\s+)?(screen|page|window)/i.test(t);
  }

  /**
   * Handle describe-only tasks by fetching the a11y context and asking the LLM
   * to summarise it in plain English — no screenshot or Computer Use needed.
   */
  private async handleDescribeTask(task: string): Promise<SmartInteractionResult> {
    console.log(`   🔍 Smart Interaction: describe task detected — using a11y context directly`);

    const activeWindow = await this.a11y.getActiveWindow();
    const a11yContext = await this.a11y.getScreenContext(activeWindow?.processId).catch(() => '');

    if (!a11yContext || a11yContext.includes('unavailable')) {
      console.log(`   ⚠️ Smart Interaction: a11y context unavailable for describe task — falling through`);
      return { handled: false, success: false, steps: [], llmCalls: 0, description: 'A11y context unavailable' };
    }

    const userMessage = `TASK: ${task}\n\nACCESSIBILITY CONTEXT:\n${a11yContext}`;
    const description = await this.callTextModel(userMessage, DESCRIBE_SYSTEM_PROMPT).catch(() => null);

    if (!description) {
      return { handled: false, success: false, steps: [], llmCalls: 1, description: 'Description LLM call failed' };
    }

    return {
      handled: true,
      success: true,
      steps: [{ action: 'describe', description, success: true, timestamp: Date.now() }],
      llmCalls: 1,
      description,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // LLM PLANNING
  // ════════════════════════════════════════════════════════════════════

  /**
   * Make a single LLM call to plan the sequence of actions.
   * Uses the cheapest available text model.
   */
  private async planActions(
    task: string,
    context: string,
    mode: 'browser' | 'native',
  ): Promise<{ canHandle: boolean; steps: PlannedStep[]; reasoning?: string } | null> {
    const modeHint = mode === 'browser'
      ? 'This is a BROWSER task. Use CDP actions (click by text, type by selector/label, etc.).'
      : 'This is a NATIVE APP task. Use UIDriver actions (click by name, type by name, menu paths, etc.).';

    const userMessage = `${modeHint}\n\nTASK: ${task}\n\nCURRENT UI CONTEXT:\n${context}`;

    try {
      const response = await this.callTextModel(userMessage);

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`   ⚠️ Smart Interaction: no JSON in LLM response`);
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.canHandle === false) {
        return { canHandle: false, steps: [], reasoning: parsed.reasoning };
      }

      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        return { canHandle: false, steps: [], reasoning: 'No steps in plan' };
      }

      // Validate and normalize steps
      const steps: PlannedStep[] = parsed.steps.map((s: any) => ({
        action: s.action || 'click',
        target: s.target || '',
        method: s.method || (mode === 'browser' ? 'text' : 'name'),
        text: s.text,
        key: s.key,
        waitMs: s.waitMs,
        fields: s.fields,
      }));

      return { canHandle: true, steps, reasoning: parsed.reasoning };
    } catch (err) {
      console.log(`   ⚠️ Smart Interaction: LLM planning failed: ${err}`);
      return null;
    }
  }

  /**
   * Call the cheapest available text model.
   * Prefers: Ollama local → Haiku → whatever is configured.
   * @param systemPrompt Optional override; defaults to PLANNING_SYSTEM_PROMPT.
   */
  private async callTextModel(userMessage: string, systemPrompt = PLANNING_SYSTEM_PROMPT): Promise<string> {
    // Use pipeline config if available
    if (this.pipelineConfig?.layer2.enabled) {
      const { model, baseUrl } = this.pipelineConfig.layer2;
      const apiKey = this.pipelineConfig.apiKey;
      const provider = this.pipelineConfig.provider;

      return this.callLLM(baseUrl, model, apiKey, provider, userMessage, systemPrompt);
    }

    // Fallback: use the main config's provider
    const providerKey = this.config.ai.provider;
    const apiKey = this.config.ai.apiKey || '';

    // Prefer provider registry defaults to stay universal as providers evolve
    const providerProfile = PROVIDERS[providerKey] || PROVIDERS['openai'];
    const model = providerProfile.textModel || this.config.ai.model || 'gpt-4o-mini';
    const baseUrl = providerProfile.baseUrl || this.config.ai.baseUrl || 'https://api.openai.com/v1';

    // Build a minimal provider profile for the call
    const isAnthropic = providerKey === 'anthropic';
    const provider: ProviderProfile = {
      name: providerKey,
      baseUrl,
      authHeader: isAnthropic
        ? (key: string): Record<string, string> => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })
        : (key: string): Record<string, string> => {
            const headers: Record<string, string> = {};
            if (key) headers['Authorization'] = `Bearer ${key}`;
            return headers;
          },
      textModel: model,
      visionModel: model,
      openaiCompat: !isAnthropic,
      computerUse: false,
    };

    return this.callLLM(baseUrl, model, apiKey, provider, userMessage, systemPrompt);
  }

  private async callLLM(
    baseUrl: string,
    model: string,
    apiKey: string,
    provider: ProviderProfile,
    userMessage: string,
    systemPrompt = PLANNING_SYSTEM_PROMPT,
  ): Promise<string> {
    if (provider.openaiCompat || baseUrl.includes('localhost') || baseUrl.includes('11434')) {
      // OpenAI-compatible (Ollama, OpenAI, Kimi)
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.authHeader(apiKey),
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content || '';
    } else {
      // Anthropic Messages API
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.authHeader(apiKey),
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.content?.[0]?.text || '';
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Poll the a11y tree every 500ms until it changes from the baseline, or until timeoutMs elapses.
   * Returns the new state string, or the original if nothing changed.
   * This replaces burning LLM "wait" steps — completely free, zero LLM calls.
   */
  private async pollUntilStateChanges(baselineState: string, timeoutMs = 5000): Promise<string> {
    const interval = 500;
    const attempts = Math.ceil(timeoutMs / interval);
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, interval));
      try {
        const activeWindow = await this.a11y.getActiveWindow();
        const newState = await this.a11y.getScreenContext(activeWindow?.processId).catch(() => '');
        // Meaningful change = active window title changed OR element count differs significantly
        const baselineLines = baselineState.split('\n').length;
        const newLines = newState.split('\n').length;
        const titleChanged = (activeWindow?.title || '') !== this.lastWindowTitle;
        const elementCountChanged = Math.abs(newLines - baselineLines) > 3;
        if (titleChanged || elementCountChanged) {
          this.lastWindowTitle = activeWindow?.title || '';
          return newState; // state changed — return new snapshot
        }
      } catch { /* continue polling */ }
    }
    return baselineState; // timed out — return original
  }
}
