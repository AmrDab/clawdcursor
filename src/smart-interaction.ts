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
12. Prefer clicking fields by selector (e.g. [aria-label="To recipients"]) then typing, over fillForm — it's more reliable.`;

/**
 * SmartInteractionLayer — the orchestration layer between BrowserLayer and Computer Use.
 */
export class SmartInteractionLayer {
  private a11y: AccessibilityBridge;
  private config: ClawdConfig;
  private pipelineConfig: PipelineConfig | null;

  // Lazy-initialized drivers
  private cdpDriver: CDPDriver | null = null;
  private uiDriver: UIDriver | null = null;

  // Circuit breaker
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 3;
  private disabled = false;

  constructor(
    a11y: AccessibilityBridge,
    config: ClawdConfig,
    pipelineConfig: PipelineConfig | null,
  ) {
    this.a11y = a11y;
    this.config = config;
    this.pipelineConfig = pipelineConfig;
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

      // Fast path: describe/read-only tasks are answered directly from a11y context
      // — no Computer Use (screenshot + vision) needed.
      if (this.isDescribeTask(task)) {
        result = await this.handleDescribeTask(task);
      } else if (isBrowserTask) {
        result = await this.handleBrowserTask(task);
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

    // Lazy-create UIDriver (no connection needed)
    if (!this.uiDriver) {
      this.uiDriver = new UIDriver();
    }

    // Get accessibility tree context
    console.log(`   ♿ Smart Interaction: getting accessibility context...`);
    const activeWindow = await this.a11y.getActiveWindow();
    const a11yContext = await this.a11y.getScreenContext(activeWindow?.processId).catch(() => '');

    if (!a11yContext || a11yContext.includes('unavailable')) {
      return { handled: false, success: false, steps: [], llmCalls: 0, description: 'A11y context unavailable' };
    }

    // Make ONE LLM call to plan actions
    console.log(`   🧠 Smart Interaction: planning with text LLM...`);
    const plan = await this.planActions(task, a11yContext, 'native');

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
      description: `Planned ${plan.steps.length} native steps: ${plan.reasoning || ''}`,
      success: true,
      timestamp: Date.now(),
    });

    // Execute each planned step — continue on non-critical failures
    let nativeCriticalFail = false;
    for (const plannedStep of plan.steps) {
      const stepResult = await this.executeNativeStep(plannedStep);
      steps.push(stepResult);

      if (!stepResult.success) {
        console.log(`   ⚠️ Step failed: ${stepResult.description}`);
        const criticalActions = ['type', 'fillForm', 'click'];
        if (criticalActions.includes(plannedStep.action)) {
          console.log(`   ❌ Critical step failed — falling through`);
          nativeCriticalFail = true;
          break;
        }
        console.log(`   ⏭️ Non-critical, continuing...`);
      }

      // Delay between actions for UI to settle
      await this.delay(300);
    }

    if (nativeCriticalFail) {
      return { handled: false, success: false, steps, llmCalls: 1, description: 'Critical step failed' };
    }

    return {
      handled: true,
      success: true,
      steps,
      llmCalls: 1,
      description: `Completed ${plan.steps.length} native actions`,
    };
  }

  private async executeNativeStep(step: PlannedStep): Promise<StepResult> {
    const ui = this.uiDriver!;
    const ts = Date.now();

    try {
      switch (step.action) {
        case 'click': {
          const result = await ui.clickElement(step.target, {
            controlType: step.method === 'automationId' ? undefined : undefined,
          });
          return { action: 'click', description: `Click "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'type': {
          const result = await ui.typeInElement(step.target, step.text || '');
          return { action: 'type', description: `Type "${step.text}" into "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'pressKey': {
          // UIDriver doesn't have pressKey — use a11y bridge keyboard action
          // Return the key info so the agent can execute via native desktop
          return {
            action: 'pressKey',
            description: `Press ${step.target} (delegated to native)`,
            success: true, // Mark as success — the key press step is informational
            timestamp: ts,
          };
        }

        case 'focus': {
          const result = await ui.focusElement(step.target);
          return { action: 'focus', description: `Focus "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'toggle': {
          const result = await ui.toggleElement(step.target);
          return { action: 'toggle', description: `Toggle "${step.target}"`, success: result.success, error: result.error, timestamp: ts };
        }

        case 'expand': {
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
            const result = await ui.fillForm(step.fields);
            const desc = Object.keys(step.fields).join(', ');
            return { action: 'fillForm', description: `Fill form: ${desc}`, success: result.success, timestamp: ts };
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

    // For Anthropic, use Haiku; for others use their cheap model
    const modelMap: Record<string, string> = {
      anthropic: 'claude-haiku-3-5-20241022',
      openai: 'gpt-4o-mini',
      ollama: 'qwen2.5:7b',
      kimi: 'moonshot-v1-8k',
    };
    const baseUrlMap: Record<string, string> = {
      anthropic: 'https://api.anthropic.com/v1',
      openai: 'https://api.openai.com/v1',
      ollama: 'http://localhost:11434/v1',
      kimi: 'https://api.moonshot.cn/v1',
    };

    const model = modelMap[providerKey] || 'gpt-4o-mini';
    const baseUrl = baseUrlMap[providerKey] || 'https://api.openai.com/v1';

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
}
