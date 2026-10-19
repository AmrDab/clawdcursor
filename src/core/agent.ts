/**
 * Agent — thin entry point that drives the desktop using the unified
 * agent loop (runAgent) with the configured model. The pipeline morph
 * machinery has been removed; a capable configured model self-drives
 * the full toolbox.
 *
 * Construction is intentionally minimal — the agent owns the desktop /
 * a11y / OCR primitives and forwards everything else to runAgent.
 */

import { NativeDesktop } from '../platform/native-desktop';
import { AccessibilityBridge } from '../platform/accessibility';
import { OcrEngine } from '../platform/ocr-engine';
import { loadPipelineConfig } from '../surface/doctor';
import { runAgent } from './agent-loop/agent';
import { getPlatform } from '../platform';
import { controlBanner } from './banner';
import { pauseGate, type PauseOutcome } from './pause-gate';
import type { ClawdConfig, AgentState, TaskResult, StepResult } from '../types';
import type { ResolvedConfig } from '../llm/config';

/**
 * Provider-agnostic Anthropic-endpoint detector. Anthropic native endpoints
 * use the `/messages` API shape; everything else (OpenAI, Groq, Together,
 * Kimi, DeepSeek, Ollama, Gemini-via-OpenAI-compat) uses `/chat/completions`.
 * Local endpoints and Ollama always take the OpenAI-compat path even if their
 * host happens to match an Anthropic-ish substring.
 */
function isAnthropicEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  if (baseUrl.includes('localhost')) return false;
  if (baseUrl.includes('11434')) return false; // Ollama default port
  return baseUrl.includes('anthropic.com');
}

export class Agent {
  private desktop: NativeDesktop;
  private a11y: AccessibilityBridge;
  private ocrEngine: OcrEngine;
  private config: ClawdConfig;
  private resolvedConfig: ResolvedConfig | null = null;
  private hasApiKey: boolean;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;
  /** Cancels the in-flight LLM fetch on abort(). Fresh per executeTask(). */
  private abortCtl: AbortController | null = null;
  /** The in-flight task promise — lets /stop wait for the abort to settle. */
  private currentRun: Promise<TaskResult> | null = null;
  private taskExecutionLocked = false;
  /** Time spent paused for the user this task — excluded from the task cap. */
  private pausedMs = 0;
  private pausedSince: number | null = null;

  constructor(config: ClawdConfig, resolvedConfig?: ResolvedConfig) {
    this.config = config;
    this.resolvedConfig = resolvedConfig ?? null;
    this.desktop = new NativeDesktop(config);
    this.a11y = new AccessibilityBridge();
    this.ocrEngine = new OcrEngine();

    // hasApiKey gates the offline-mode banner — true if any cloud key is
    // configured. Local LLM (Ollama) is always available via the loop,
    // so absence of cloud keys just means we'll print an offline notice.
    const hasCloudKey = !!(config.ai.apiKey && config.ai.apiKey.length > 0);
    const hasVisionKey = !!(config.ai.visionApiKey && config.ai.visionApiKey.length > 0);
    this.hasApiKey = hasCloudKey || hasVisionKey;

    if (!this.hasApiKey) {
      console.log(`⚡ Running in offline mode (no API key).`);
      console.log(`   To unlock AI, set AI_API_KEY (or run: clawdcursor doctor)`);
    }
  }

  async connect(): Promise<void> {
    await this.desktop.connect();

    // Warm up the PSRunner bridge so assembly loading happens in background
    this.a11y.warmup().catch(() => {});

    // Touch the OCR engine so any first-call latency is paid up front.
    void this.ocrEngine;
  }

  /** Safety-net timeout — only fires if task is truly stuck (stagnation + abort didn't catch it) */
  private static readonly TASK_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

  async executeTask(task: string): Promise<TaskResult> {
    // Atomic concurrency guard — boolean lock prevents TOCTOU race
    // where two simultaneous /task requests both see status === 'idle'
    if (this.taskExecutionLocked || this.state.status !== 'idle') {
      return {
        success: false,
        steps: [{ action: 'error', description: 'Agent is busy', success: false, timestamp: Date.now() }],
        duration: 0,
      };
    }
    this.taskExecutionLocked = true;

    this.aborted = false;
    this.abortCtl = new AbortController();
    const startTime = Date.now();

    // Wrap the entire task with a global wall-clock timeout. Time the user
    // spends on a pause (signing in, solving a CAPTCHA) does not count against it.
    this.pausedMs = 0;
    this.pausedSince = null;
    const deadline = () => startTime + Agent.TASK_TIMEOUT_MS + this.pausedMs
      + (this.pausedSince !== null ? Date.now() - this.pausedSince : 0);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<TaskResult>((resolve) => {
      const arm = () => { timeoutHandle = setTimeout(fire, Math.max(1000, deadline() - Date.now())); };
      const fire = () => {
        if (Date.now() < deadline()) return arm(); // a pause moved the deadline
        this.aborted = true;
        console.warn(`\n⏱ Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`);
        resolve({
          success: false,
          steps: [{ action: 'error', description: `Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        });
      };
      arm();
    });

    // Transparency: the on-screen banner stays up for the WHOLE task so a
    // human at the machine always knows automation is live (and can
    // double-click it to stop). Pin/unpin — tool-activity touches must not
    // hide it mid-task.
    controlBanner.pin();
    try {
      this.currentRun = this._executeTask(task, startTime);
      return await Promise.race([this.currentRun, timeoutPromise]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.taskExecutionLocked = false;
      this.currentRun = null;
      controlBanner.unpin();
    }
  }

  /**
   * Wait until the in-flight task settles (or the timeout elapses). Used by
   * the /stop path so an abort can print its "aborted by user"
   * acknowledgment before the process exits — previously stop was a hard
   * kill 500ms after the HTTP response, mid-turn, with zero output.
   */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const run = this.currentRun;
    if (!run) return;
    await Promise.race([
      run.then(() => undefined, () => undefined),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * Thin task executor — runs the unified agent loop with the configured model.
   * No pipeline morph, no mode ladder, no verifier. A capable model self-drives
   * the full toolbox.
   */
  private async _executeTask(task: string, startTime: number): Promise<TaskResult> {
    // Resolve the LLM configuration from the disk config + CLI overlay.
    const pipelineConfig = loadPipelineConfig(this.resolvedConfig);

    const hasTextModel   = !!(pipelineConfig?.layer2.model && pipelineConfig.layer2.baseUrl);
    const hasVisionModel = !!(pipelineConfig?.layer3?.model && pipelineConfig?.layer3?.baseUrl);

    // Build direct LLM configs for the unified agent. Prefer text; fall back
    // to vision model if text is absent (vision models handle tool_use too).
    const textConfig = hasTextModel && pipelineConfig
      ? {
          baseUrl: pipelineConfig.layer2.baseUrl,
          model: pipelineConfig.layer2.model,
          apiKey: pipelineConfig.layer2.apiKey || pipelineConfig.apiKey || '',
          isAnthropic: isAnthropicEndpoint(pipelineConfig.layer2.baseUrl),
          maxTokens: 1024,
        }
      : undefined;

    const visionLayer = pipelineConfig?.layer3;
    const visionConfig = hasVisionModel && visionLayer && pipelineConfig
      ? {
          baseUrl: visionLayer.baseUrl,
          model: visionLayer.model,
          apiKey: visionLayer.apiKey || pipelineConfig.apiKey || '',
          isAnthropic: isAnthropicEndpoint(visionLayer.baseUrl),
          maxTokens: 1024,
        }
      : undefined;

    if (!hasTextModel && !hasVisionModel) {
      console.log('⚡ No AI model configured. Run `clawdcursor doctor` to configure a provider.');
    }

    // Clear lastResult at task start so a poller can't read a stale result
    // from a prior run while a new task is in flight.
    this.state = { ...this.state, status: 'thinking', currentTask: task, stepsCompleted: 0, stepsTotal: 0, lastResult: undefined };

    // Get the platform adapter. Lazy-initialised per call (cheap re-call).
    const adapter = await getPlatform();

    // Resolve CDP driver if wired externally.
    const cdp = (this as { cdpDriver?: import('../platform/cdp-driver').CDPDriver }).cdpDriver ?? null;

    // Resolve UIMapHolder if wired externally (by cli.ts daemon setup).
    const uiMaps = (this as { uiMapHolder?: import('./sense/ui-map-holder').UIMapHolder }).uiMapHolder ?? undefined;

    // Run the thin agent loop with the FULL toolbox.
    // The agent loop prefers a11y-first (cheapest) and only calls screenshot
    // when it genuinely needs pixels.
    const agentResult = await runAgent(
      {
        task,
        isAborted: () => this.aborted,
        abortSignal: this.abortCtl?.signal,
        pause: req => this.pauseForUser(req.message),
      },
      {
        adapter,
        llm: { text: textConfig, vision: visionConfig },
        cdp,
        uiMaps,
      },
    );

    const steps: StepResult[] = agentResult.steps.length > 0
      ? agentResult.steps.map(s => ({
          action: s.toolName,
          description: s.result.text,
          success: s.result.success,
          timestamp: Date.now(),
          layer: 'unified' as const,
          method: s.toolName,
          latencyMs: s.durationMs,
        }))
      : [{
          action: agentResult.exit,
          description: agentResult.text,
          success: agentResult.success,
          timestamp: Date.now(),
          layer: 'unified' as const,
        }];

    if (agentResult.text) {
      console.log(`   ${agentResult.text}`);
    }

    const taskResult: TaskResult = {
      success: agentResult.success,
      steps,
      duration: Date.now() - startTime,
    };
    this.state = { ...this.state, status: 'idle', lastResult: taskResult };
    return taskResult;
  }

  /**
   * Hand the desktop to the user and wait for their answer (pause-gate.ts).
   * Null when nobody can see the prompt — the loop then fails fast as before.
   */
  private async pauseForUser(message: string): Promise<Exclude<PauseOutcome, 'replied'> | { replied: string } | null> {
    if (!pauseGate.available() || this.aborted) return null;
    this.pausedSince = Date.now();
    this.state = { ...this.state, status: 'paused', currentStep: message };
    console.log(`
⏸ Paused for the user: ${message}`);
    try {
      const r = await pauseGate.requestWithReply({ message }, { signal: this.abortCtl?.signal });
      return r.outcome === 'replied' ? { replied: r.reply ?? '' } : r.outcome;
    } finally {
      this.pausedMs += Date.now() - this.pausedSince;
      this.pausedSince = null;
      if (!this.aborted) this.state = { ...this.state, status: 'thinking', currentStep: undefined };
    }
  }

  abort(): void {
    this.aborted = true;
    // Cancel the in-flight LLM fetch too — the cooperative flag alone only
    // takes effect at the next loop checkpoint, i.e. after the current
    // (up to 45s) LLM call returns.
    this.abortCtl?.abort();
    this.state = { status: 'idle', stepsCompleted: 0, stepsTotal: 0 };
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getDesktop(): NativeDesktop {
    return this.desktop;
  }

  getA11y(): AccessibilityBridge {
    return this.a11y;
  }

  disconnect(): void {
    this.desktop.disconnect();
  }
}
