// NOTE: On Bash/macOS, use && to chain commands (e.g., cd dir && npm start)
// On PowerShell (Windows), use ; instead of && (e.g., cd dir; npm start)

/**
 * Agent — the main orchestration loop.
 *
 * v3 Flow (API key optional):
 * 1. Decompose task:
 *    a. Try LocalTaskParser first (regex, no LLM, instant)
 *    b. If parser returns null AND API key is set → LLM decomposition
 *    c. If parser returns null AND no API key → error: task too complex
 * 2. For each subtask:
 *    a. Try Action Router (accessibility + native desktop, NO LLM) ← handles 80%+ of tasks
 *    b. If router can't handle it AND API key set → LLM vision fallback
 *    c. If router can't handle it AND no API key → skip subtask
 * 3. Track what approach worked for each subtask
 *
 * No API key = works for 80% of tasks (regex + accessibility)
 * With API key = unlocks LLM fallback for complex/unknown tasks
 */

import * as fs from 'fs';
import { writeFile } from 'fs/promises';
import * as path from 'path';
import { NativeDesktop } from './native-desktop';
import { AIBrain } from './ai-brain';
import { LocalTaskParser } from './local-parser';
import { SafetyLayer } from './safety';
import { AccessibilityBridge } from './accessibility';
import { ActionRouter } from './action-router';
import { SafetyTier } from './types';
import { ComputerUseBrain } from './computer-use';
import { A11yReasoner } from './a11y-reasoner';
import { BrowserLayer } from './browser-layer';
import { SmartInteractionLayer } from './smart-interaction';
import { loadPipelineConfig } from './doctor';
import type { PipelineConfig } from './providers';
import type { ClawdConfig, AgentState, TaskResult, StepResult, InputAction, A11yAction } from './types';

const MAX_STEPS = 15;
const MAX_SIMILAR_ACTION = 3;
const MAX_LLM_FALLBACK_STEPS = 10;

export class Agent {
  private desktop: NativeDesktop;
  private brain: AIBrain;
  private parser: LocalTaskParser;
  private safety: SafetyLayer;
  private a11y: AccessibilityBridge;
  private router: ActionRouter;
  private computerUse: ComputerUseBrain | null = null;
  private reasoner: A11yReasoner | null = null;
  private browserLayer: BrowserLayer | null = null;
  private smartInteraction: SmartInteractionLayer | null = null;
  private config: ClawdConfig;
  private hasApiKey: boolean;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;

  constructor(config: ClawdConfig) {
    this.config = config;
    this.desktop = new NativeDesktop(config);
    this.brain = new AIBrain(config);
    this.parser = new LocalTaskParser();
    this.safety = new SafetyLayer(config);
    this.a11y = new AccessibilityBridge();
    this.router = new ActionRouter(this.a11y, this.desktop);
    this.hasApiKey = !!(config.ai.apiKey && config.ai.apiKey.length > 0);

    if (!this.hasApiKey) {
      console.log(`⚡ Running in offline mode (no API key). Local parser + action router only.`);
      console.log(`   To unlock AI vision fallback, set AI_API_KEY in .env`);
    }

    // Load pipeline config from doctor (if available)
    const pipelineConfig = loadPipelineConfig();
    if (pipelineConfig && pipelineConfig.layer2.enabled) {
      this.reasoner = new A11yReasoner(this.a11y, pipelineConfig);
      console.log(`🧠 Layer 2 (Accessibility Reasoner): ${pipelineConfig.layer2.model}`);
    }
  }

  async connect(): Promise<void> {
    await this.desktop.connect();

    // Initialize Browser Layer (Layer 0) — Playwright for browser tasks
    const pipelineConfig = loadPipelineConfig();
    this.browserLayer = new BrowserLayer(this.config, pipelineConfig || {} as PipelineConfig);
    console.log(`🌐 Layer 0 (Browser): Playwright — CDP or managed Chromium`);

    // Initialize Smart Interaction Layer (Layer 1.5) — CDPDriver + UIDriver
    this.smartInteraction = new SmartInteractionLayer(
      this.a11y,
      this.config,
      pipelineConfig || null,
    );
    if (this.smartInteraction.isAvailable()) {
      console.log(`🧩 Layer 1.5 (Smart Interaction): CDPDriver + UIDriver — 1 LLM call planning`);
    }

    // Initialize Computer Use if Anthropic provider
    if (ComputerUseBrain.isSupported(this.config)) {
      this.computerUse = new ComputerUseBrain(this.config, this.desktop, this.a11y, this.safety);
      console.log(`🖥️  Computer Use API enabled (Anthropic native tool + accessibility)`);
    }

    const size = this.desktop.getScreenSize();
    this.brain.setScreenSize(size.width, size.height);
  }

  async executeTask(task: string): Promise<TaskResult> {
    // Atomic concurrency guard — prevent TOCTOU race on simultaneous /task requests
    if (this.state.status !== 'idle') {
      return {
        success: false,
        steps: [{ action: 'error', description: 'Agent is busy', success: false, timestamp: Date.now() }],
        duration: 0,
      };
    }

    this.aborted = false;
    const startTime = Date.now();

    console.log(`\n🐾 Starting task: ${task}`);

    // Setup debug directory (only when --debug flag is set)
    const debugDir = this.config.debug ? path.join(process.cwd(), 'debug') : null;
    if (debugDir) {
      try {
        if (fs.existsSync(debugDir)) {
          for (const f of fs.readdirSync(debugDir)) fs.unlinkSync(path.join(debugDir, f));
        } else {
          fs.mkdirSync(debugDir);
        }
      } catch { /* non-fatal */ }
      console.log(`   🐛 Debug mode: screenshots will be saved to ${debugDir}`);
    }

    this.state = {
      status: 'thinking',
      currentTask: task,
      stepsCompleted: 0,
      stepsTotal: 1,
    };

    // ═══════════════════════════════════════════════════════════════
    // TWO COMPLETELY SEPARATE PATHS:
    //
    // PATH A: Computer Use (Anthropic)
    //   → Full task goes directly to Claude Computer Use API
    //   → Claude screenshots, plans with visual context, executes
    //   → No decomposer, no router, no blind text parsing
    //
    // PATH B: Decompose + Route (OpenAI / offline)
    //   → LLM or regex decomposes into subtasks
    //   → Router handles simple subtasks
    //   → LLM vision fallback for complex ones
    // ═══════════════════════════════════════════════════════════════

    // ── Layer 0: Browser (Playwright) ──
    // If the task is browser-related, try Playwright first — instant, no screenshots needed
    const isBrowserTask = BrowserLayer.isBrowserTask(task);
    if (this.browserLayer && isBrowserTask) {
      this.state.status = 'acting';
      const browserResult = await this.browserLayer.executeTask(task);
      if (browserResult.handled && browserResult.success) {
        const result: TaskResult = {
          success: true,
          steps: browserResult.steps || [],
          duration: Date.now() - startTime,
        };
        console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${result.steps.length} steps (0 LLM calls — Playwright)`);
        this.state = { status: 'idle', stepsCompleted: result.steps.length, stepsTotal: result.steps.length };
        return result;
      }
      // Browser layer couldn't handle it — fall through to Smart Interaction
      if (browserResult.handled === false) {
        console.log(`   🌐 Browser Layer: falling through to Smart Interaction`);
      }
    }

    // ── Layer 1: Action Router (regex + a11y, zero LLM calls) ──
    // Pattern-matched tasks: refresh, go back, zoom, find, open app, etc.
    // Instant execution — no screenshots, no API calls.
    if (!isBrowserTask) {
      this.state.status = 'acting';
      console.log(`\n⚡ Action Router: attempting "${task}"`);
      const routeResult = await this.router.route(task);
      if (routeResult.handled) {
        const step: StepResult = {
          action: 'action-router',
          description: routeResult.description,
          success: !routeResult.error,
          timestamp: Date.now(),
        };
        const result: TaskResult = {
          success: !routeResult.error,
          steps: [step],
          duration: Date.now() - startTime,
        };
        console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s — Action Router (0 LLM calls, $0)`);
        this.state = { status: 'idle', stepsCompleted: 1, stepsTotal: 1 };
        return result;
      }
      console.log(`   ⚡ Action Router: not matched — falling through`);
    }

    // ── Layer 1.5: Smart Interaction (CDPDriver + UIDriver) ──
    // Uses 1 cheap LLM call to read context + plan, then executes all steps free.
    // For browser tasks: CDPDriver via CDP port 9222
    // For native tasks: UIDriver via Windows UI Automation
    if (this.smartInteraction?.isAvailable()) {
      this.state.status = 'acting';
      console.log(`\n🧩 Smart Interaction Layer: attempting "${task}"`);
      const smartResult = await this.smartInteraction.tryHandle(task, isBrowserTask);
      if (smartResult.handled && smartResult.success) {
        const result: TaskResult = {
          success: true,
          steps: smartResult.steps,
          duration: Date.now() - startTime,
        };
        console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${result.steps.length} steps (${smartResult.llmCalls} LLM call — Smart Interaction)`);
        this.state = { status: 'idle', stepsCompleted: result.steps.length, stepsTotal: result.steps.length };
        return result;
      }
      // Smart Interaction couldn't handle it — fall through to Computer Use
      if (!smartResult.handled) {
        console.log(`   🧩 Smart Interaction: falling through to Computer Use — ${smartResult.description || 'not handled'}`);
      }
    }

    // ── Layer 2: Computer Use / Decompose+Route (expensive fallback) ──
    if (this.computerUse) {
      return this.executeWithComputerUse(task, debugDir, startTime);
    } else {
      return this.executeWithDecomposeAndRoute(task, debugDir, startTime);
    }
  }

  /**
   * PATH A: Anthropic Computer Use
   * Give the full task to Claude — it screenshots, plans, and executes.
   */
  private async executeWithComputerUse(
    task: string,
    debugDir: string | null,
    startTime: number,
  ): Promise<TaskResult> {
    console.log(`   🖥️  Using Computer Use API (screenshot-first)\n`);

    // Minimize all windows so target apps get clean focus
    try {
      await this.desktop.keyPress('Super+d');
      await new Promise(r => setTimeout(r, 500));
    } catch { /* non-critical */ }

    this.state.status = 'acting';
    try {
      const cuResult = await this.computerUse!.executeSubtask(task, debugDir, 0);

      const result: TaskResult = {
        success: cuResult.success,
        steps: cuResult.steps,
        duration: Date.now() - startTime,
      };

      console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${cuResult.steps.length} steps (${cuResult.llmCalls} LLM call(s))`);
      return result;
    } catch (err) {
      console.error(`\n❌ Computer Use crashed:`, err);
      return {
        success: false,
        steps: [{ action: 'error', description: `Computer Use crashed: ${err}`, success: false, timestamp: Date.now() }],
        duration: Date.now() - startTime,
      };
    } finally {
      this.state.status = 'idle';
      this.state.currentTask = undefined;
    }
  }

  /**
   * PATH B: Decompose + Route + LLM Fallback
   * For non-Anthropic providers or offline mode.
   */
  private async executeWithDecomposeAndRoute(
    task: string,
    debugDir: string | null,
    startTime: number,
  ): Promise<TaskResult> {
    const steps: StepResult[] = [];
    let llmCallCount = 0;

    console.log(`   Using decompose → route → LLM fallback pipeline\n`);

    try {

    // ─── Decompose ───────────────────────────────────────────────
    console.log(`📋 Decomposing task...`);
    const decompositionStart = Date.now();
    let subtasks: string[];

    if (this.hasApiKey) {
      console.log(`   🧠 Using LLM to decompose task...`);
      subtasks = await this.brain.decomposeTask(task);
      llmCallCount = 1;
      console.log(`   Decomposed via LLM in ${Date.now() - decompositionStart}ms`);
    } else {
      const localResult = this.parser.decomposeTask(task);
      if (localResult) {
        subtasks = localResult;
        console.log(`   ⚡ Local parser handled in ${Date.now() - decompositionStart}ms (offline)`);
      } else {
        console.log(`   ❌ Task too complex for offline mode.`);
        return {
          success: false,
          steps: [{ action: 'error', description: 'Task too complex for offline mode. Set AI_API_KEY to unlock AI fallback.', success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        };
      }
    }

    console.log(`   ${subtasks.length} subtask(s):`);
    subtasks.forEach((st, i) => console.log(`   ${i + 1}. "${st}"`));
    this.state.stepsTotal = subtasks.length;

    // ─── Execute each subtask ────────────────────────────────────
    console.log(`\n⚡ Executing subtasks...`);

    for (let i = 0; i < subtasks.length; i++) {
      if (this.aborted) {
        steps.push({ action: 'aborted', description: 'User aborted', success: false, timestamp: Date.now() });
        break;
      }

      const subtask = subtasks[i];
      console.log(`\n── Subtask ${i + 1}/${subtasks.length}: "${subtask}" ──`);
      this.state.currentStep = subtask;
      this.state.stepsCompleted = i;

      // Try router first
      this.state.status = 'acting';
      const routeResult = await this.router.route(subtask);

      if (routeResult.handled) {
        console.log(`   ✅ Router: ${routeResult.description}`);
        steps.push({ action: 'routed', description: routeResult.description, success: true, timestamp: Date.now() });
        const isLaunch = routeResult.description.toLowerCase().includes('launch');
        await this.delay(isLaunch ? 150 : 50);
        continue;
      }

      console.log(`   ⚠️ Router can't handle: ${routeResult.description}`);

      // Layer 2: Accessibility Reasoner (text-only LLM, no screenshot)
      if (this.reasoner?.isAvailable()) {
        const reasonResult = await this.reasoner.reason(subtask);
        if (reasonResult.handled) {
          if (reasonResult.action) {
            try {
              await this.executeAction(reasonResult.action as InputAction & { description?: string });
              steps.push({ action: reasonResult.action.kind, description: reasonResult.description, success: true, timestamp: Date.now() });
              await this.delay(100);
              continue;
            } catch (err) {
              console.log(`   ⚠️ Layer 2 action failed: ${err} → falling through to Layer 3`);
            }
          } else {
            // Task done per reasoner
            steps.push({ action: 'done', description: reasonResult.description, success: true, timestamp: Date.now() });
            continue;
          }
        }
        // If unsure or failed, fall through to Layer 3
      }

      // Layer 3: LLM vision fallback (screenshot)
      if (this.hasApiKey) {
        await this.delay(150);
        console.log(`   🧠 LLM vision fallback...`);
        const fallbackResult = await this.executeLLMFallback(subtask, steps, debugDir, i);
        llmCallCount += fallbackResult.llmCalls;
        if (!fallbackResult.success) {
          console.log(`   ❌ LLM fallback failed for: "${subtask}"`);
        }
      } else {
        steps.push({ action: 'skipped', description: `Skipped "${subtask}" — no API key`, success: false, timestamp: Date.now() });
      }
    }

    const result: TaskResult = {
      success: steps.length > 0 && steps.some(s => s.success),
      steps,
      duration: Date.now() - startTime,
    };

    console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${steps.length} steps (${llmCallCount} LLM call(s))`);
    return result;

    } catch (err) {
      console.error(`\n❌ Decompose+Route crashed:`, err);
      return {
        success: false,
        steps: [...steps, { action: 'error', description: `Pipeline crashed: ${err}`, success: false, timestamp: Date.now() }],
        duration: Date.now() - startTime,
      };
    } finally {
      this.state.status = 'idle';
      this.state.currentTask = undefined;
      this.brain.resetConversation();
    }
  }

  /**
   * LLM vision fallback — used when the action router can't handle a subtask.
   * Takes screenshots, sends to LLM, executes returned actions.
   */
  private async executeLLMFallback(
    subtask: string,
    steps: StepResult[],
    debugDir: string | null,
    subtaskIndex: number,
  ): Promise<{ success: boolean; llmCalls: number }> {
    const stepDescriptions: string[] = [];
    const recentActions: string[] = [];
    let llmCalls = 0;

    for (let j = 0; j < MAX_LLM_FALLBACK_STEPS; j++) {
      if (this.aborted) break;

      // ── Perf Opt #2: Parallelize screenshot + a11y fetch ──
      console.log(`   📸 LLM step ${j + 1}: Capturing screen + a11y context...`);
      if (j > 0) await this.delay(500); // pause between LLM retries to let UI settle

      const [screenshot, a11yContext] = await Promise.all([
        this.desktop.captureForLLM(),
        this.a11y.getScreenContext().catch(() => undefined as string | undefined),
      ]);

      // ── Debug screenshot save (only when --debug flag is set) ──
      if (debugDir) {
        const ext = screenshot.format === 'jpeg' ? 'jpg' : 'png';
        writeFile(
          path.join(debugDir, `subtask-${subtaskIndex}-step-${j}.${ext}`),
          screenshot.buffer,
        ).catch(() => {});
        console.log(`   💾 Debug screenshot saved (${(screenshot.buffer.length / 1024).toFixed(0)}KB, ${screenshot.llmWidth}x${screenshot.llmHeight})`);
      }

      // Ask AI what to do
      this.state.status = 'thinking';
      llmCalls++;
      const decision = await this.brain.decideNextAction(screenshot, subtask, stepDescriptions, a11yContext);

      // Done with this subtask?
      if (decision.done) {
        console.log(`   ✅ Subtask complete: ${decision.description}`);
        steps.push({ action: 'done', description: decision.description, success: true, timestamp: Date.now() });
        return { success: true, llmCalls };
      }

      // Error?
      if (decision.error) {
        const isParseError = decision.error.startsWith('Parse error:') || decision.error.startsWith('Failed to parse');
        if (isParseError) {
          // Parse errors are retryable — LLM returned prose or bad JSON, take a fresh screenshot and try again
          console.log(`   ⚠️ LLM returned bad JSON, retrying... (${decision.error.substring(0, 80)})`);
          steps.push({ action: 'retry', description: `Retryable: ${decision.error.substring(0, 100)}`, success: false, timestamp: Date.now() });
          this.brain.resetConversation(); // clear bad history so next attempt starts fresh
          continue;
        }
        console.log(`   ❌ LLM error: ${decision.error}`);
        steps.push({ action: 'error', description: decision.error, success: false, timestamp: Date.now() });
        return { success: false, llmCalls };
      }

      // Wait?
      if (decision.waitMs) {
        console.log(`   ⏳ Waiting ${decision.waitMs}ms: ${decision.description}`);
        await this.delay(decision.waitMs);
        stepDescriptions.push(decision.description);
        continue;
      }

      // Handle SEQUENCE
      if (decision.sequence) {
        console.log(`   📋 Sequence: ${decision.sequence.description} (${decision.sequence.steps.length} steps)`);

        for (const seqStep of decision.sequence.steps) {
          if (this.aborted) break;

          const tier = this.safety.classify(seqStep, seqStep.description);
          console.log(`   ${tierEmoji(tier)} ${seqStep.description}`);

          if (tier === SafetyTier.Confirm) {
            this.state.status = 'waiting_confirm';
            const approved = await this.safety.requestConfirmation(seqStep, seqStep.description);
            if (!approved) {
              steps.push({ action: 'rejected', description: `USER REJECTED: ${seqStep.description}`, success: false, timestamp: Date.now() });
              break;
            }
          }

          try {
            await this.executeAction(seqStep);
            steps.push({ action: seqStep.kind, description: seqStep.description, success: true, timestamp: Date.now() });
            stepDescriptions.push(seqStep.description);
            await this.delay(80);
          } catch (err) {
            console.error(`   Failed:`, err);
            steps.push({ action: seqStep.kind, description: `FAILED: ${seqStep.description}`, success: false, error: String(err), timestamp: Date.now() });
          }
        }
        continue; // Take new screenshot after sequence
      }

      // Handle SINGLE ACTION
      if (decision.action) {
        // Duplicate detection
        const actionKey = decision.action.kind + ('x' in decision.action ? `@${(decision.action as any).x},${(decision.action as any).y}` : ('key' in decision.action ? `@${(decision.action as any).key}` : ''));
        recentActions.push(actionKey);
        const lastN = recentActions.slice(-MAX_SIMILAR_ACTION);
        if (lastN.length >= MAX_SIMILAR_ACTION && lastN.every(a => a === lastN[0])) {
          console.log(`   🔄 Same action repeated ${MAX_SIMILAR_ACTION} times — giving up on this subtask`);
          steps.push({ action: 'stuck', description: `Stuck: repeated "${actionKey}"`, success: false, timestamp: Date.now() });
          return { success: false, llmCalls };
        }

        // Safety check
        const tier = this.safety.classify(decision.action, decision.description);
        console.log(`   ${tierEmoji(tier)} Action: ${decision.description}`);

        if (this.safety.isBlocked(decision.description)) {
          console.log(`   🚫 BLOCKED: ${decision.description}`);
          steps.push({ action: 'blocked', description: `BLOCKED: ${decision.description}`, success: false, timestamp: Date.now() });
          return { success: false, llmCalls };
        }

        if (tier === SafetyTier.Confirm) {
          this.state.status = 'waiting_confirm';
          this.state.currentStep = `Confirm: ${decision.description}`;
          const approved = await this.safety.requestConfirmation(decision.action, decision.description);
          if (!approved) {
            steps.push({ action: 'rejected', description: `USER REJECTED: ${decision.description}`, success: false, timestamp: Date.now() });
            continue;
          }
        }

        // Execute
        this.state.status = 'acting';
        try {
          await this.executeAction(decision.action);
          steps.push({ action: decision.action.kind, description: decision.description, success: true, timestamp: Date.now() });
          stepDescriptions.push(decision.description);
        } catch (err) {
          console.error(`   Failed:`, err);
          steps.push({ action: decision.action.kind, description: `FAILED: ${decision.description}`, success: false, error: String(err), timestamp: Date.now() });
        }
      }
    }

    return { success: false, llmCalls };
  }

  /**
   * Execute a single action (mouse, keyboard, or a11y).
   */
  private async executeAction(action: InputAction & { description?: string }): Promise<void> {
    if (action.kind.startsWith('a11y_')) {
      await this.executeA11yAction(action as A11yAction);
    } else if ('x' in action) {
      await this.desktop.executeMouseAction(action as any);
    } else {
      await this.desktop.executeKeyboardAction(action as any);
    }
  }

  // ─── Legacy executeTask (kept for backward compat) ──────────────
  // The old flow is removed; all task execution goes through the optimized path.

  abort(): void {
    this.aborted = true;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getSafety(): SafetyLayer {
    return this.safety;
  }

  disconnect(): void {
    this.desktop.disconnect();
    this.smartInteraction?.disconnect().catch(() => {});
  }

  private async executeA11yAction(action: A11yAction): Promise<void> {
    const actionMap: Record<string, 'click' | 'set-value' | 'get-value' | 'focus'> = {
      'a11y_click': 'click',
      'a11y_set_value': 'set-value',
      'a11y_get_value': 'get-value',
      'a11y_focus': 'focus',
    };
    const a11yAction = actionMap[action.kind];
    if (!a11yAction) throw new Error(`Unknown a11y action: ${action.kind}`);

    console.log(`   ♿ A11y ${a11yAction}: ${action.name || action.automationId} [${action.controlType || 'any'}]`);

    const result = await this.a11y.invokeElement({
      name: action.name,
      automationId: action.automationId,
      controlType: action.controlType,
      action: a11yAction,
      value: action.value,
    });

    if (!result.success) {
      throw new Error(result.error || 'A11y action failed');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function tierEmoji(tier: SafetyTier): string {
  switch (tier) {
    case SafetyTier.Auto: return '🟢';
    case SafetyTier.Preview: return '🟡';
    case SafetyTier.Confirm: return '🔴';
  }
}
