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
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const IS_MAC = os.platform() === 'darwin';
import { NativeDesktop } from './native-desktop';
import { AIBrain } from './ai-brain';
import { LocalTaskParser } from './local-parser';
import { SafetyLayer } from './safety';
import { AccessibilityBridge } from './accessibility';
import { ActionRouter } from './action-router';
import { SafetyTier } from './types';
import { ComputerUseBrain } from './computer-use';
import { GenericComputerUse, isGenericComputerUseSupported } from './generic-computer-use';
import { classifyTask } from './task-classifier';
import { A11yReasoner } from './a11y-reasoner';
import { OcrEngine } from './ocr-engine';
import { OcrReasoner } from './ocr-reasoner';
import { SkillCache } from './skill-cache';
import { TaskLogger, CompletionStatus } from './task-logger';
import { WorkspaceState } from './workspace-state';
import { TaskVerifier } from './verifiers';
import { DeterministicFlows } from './deterministic-flows';
import { BrowserLayer } from './browser-layer';
import { loadPipelineConfig } from './doctor';
import { detectProvider, type PipelineConfig } from './providers';
import { getBrowserExePath, getBrowserProcessRegex } from './browser-config';
import { callTextLLM, LLMBillingError, LLMAuthError } from './llm-client';
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
  private genericComputerUse: GenericComputerUse | null = null;
  private reasoner: A11yReasoner | null = null;
  private ocrEngine: OcrEngine;
  private ocrReasoner: OcrReasoner | null = null;
  private skillCache: SkillCache;
  private deterministicFlows: DeterministicFlows;
  private browserLayer: BrowserLayer | null = null;
  private logger: TaskLogger;
  private workspace: WorkspaceState;
  private verifier: TaskVerifier;
  private config: ClawdConfig;
  private hasApiKey: boolean;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;
  private taskExecutionLocked = false;

  constructor(config: ClawdConfig) {
    this.config = config;
    this.desktop = new NativeDesktop(config);
    this.brain = new AIBrain(config);
    this.parser = new LocalTaskParser();
    this.safety = new SafetyLayer(config);
    this.a11y = new AccessibilityBridge();
    this.router = new ActionRouter(this.a11y, this.desktop);
    this.deterministicFlows = new DeterministicFlows(this.a11y, this.desktop);
    this.logger = new TaskLogger();
    this.workspace = new WorkspaceState();
    // Load pipeline config from doctor (if available)
    const pipelineConfig = loadPipelineConfig();
    this.verifier = new TaskVerifier(this.a11y, pipelineConfig ?? undefined);

    // A11y Reasoner kept for compatibility but no longer used in pipeline
    // (unified reasoner handles both OCR + A11y perception)
    if (pipelineConfig && pipelineConfig.layer2.enabled) {
      this.reasoner = new A11yReasoner(this.a11y, this.desktop, pipelineConfig);
    }

    // Unified Reasoner: parallel OCR + A11y perception → single LLM call
    this.ocrEngine = new OcrEngine();
    this.skillCache = new SkillCache();
    this.skillCache.load();

    if (pipelineConfig && pipelineConfig.layer2.enabled) {
      this.ocrReasoner = new OcrReasoner(this.ocrEngine, this.desktop, this.a11y, pipelineConfig);
      const ocrStatus = this.ocrEngine.isAvailable() ? 'OCR+A11y' : 'A11y-only';
      console.log(`👁️ Layer 2 (Unified Reasoner): ${pipelineConfig.layer2.model} — ${ocrStatus} perception active`);
    }
    const skillStats = this.skillCache.getStats();
    if (skillStats.total > 0) {
      console.log(`📚 Layer 2 (Skill Cache): ${skillStats.total} cached skills`);
    }

    // hasApiKey gates LLM decomposition — true if cloud key OR local LLM (Ollama) is available
    const hasCloudKey = !!(config.ai.apiKey && config.ai.apiKey.length > 0);
    const hasVisionKey = !!(config.ai.visionApiKey && config.ai.visionApiKey.length > 0);
    const hasLocalLLM = !!this.reasoner;  // If reasoner loaded, we have an LLM for decomposition
    this.hasApiKey = hasCloudKey || hasVisionKey || hasLocalLLM;

    // If no cloud key but Ollama is available, reconfigure brain to use Ollama for decomposition
    // IMPORTANT: preserve vision credentials so Layer 3 can still use cloud vision (e.g. Anthropic)
    if (!hasCloudKey && hasLocalLLM && pipelineConfig) {
      const ollamaModel = pipelineConfig.layer2.model;
      this.config = {
        ...config,
        ai: {
          ...config.ai,
          provider: 'ollama' as any,
          model: ollamaModel,
          apiKey: '',  // Ollama doesn't need a key
          // Preserve vision credentials for Layer 3 fallback
          visionApiKey: config.ai.visionApiKey,
          visionBaseUrl: config.ai.visionBaseUrl,
          visionModel: config.ai.visionModel,
        },
      };
      this.brain = new AIBrain(this.config);
      console.log(`🔄 Brain reconfigured: using Ollama/${ollamaModel} for decomposition`);
    }

    if (!this.hasApiKey) {
      console.log(`⚡ Running in offline mode (no API key or local LLM). Local parser + action router only.`);
      console.log(`   To unlock AI fallback, set AI_API_KEY (or run: clawdcursor doctor)`);
    }
  }

  private inferProviderLabel(apiKey?: string, baseUrl?: string, fallback?: string): string {
    const inferredFromUrl = this.inferProviderFromBaseUrl(baseUrl);
    if (inferredFromUrl) return inferredFromUrl;

    if (apiKey && apiKey.length > 0) {
      return detectProvider(apiKey, fallback);
    }

    return fallback || 'unknown';
  }

  private inferProviderFromBaseUrl(baseUrl?: string): string | null {
    const url = (baseUrl || '').toLowerCase();
    if (!url) return null;
    if (url.includes('anthropic')) return 'anthropic';
    if (url.includes('moonshot') || url.includes('kimi')) return 'kimi';
    if (url.includes('11434') || url.includes('ollama')) return 'ollama';
    if (url.includes('openai')) return 'openai';
    if (url.includes('groq')) return 'groq';
    if (url.includes('together')) return 'together';
    if (url.includes('deepseek')) return 'deepseek';
    if (url.includes('nvidia') || url.includes('integrate.api')) return 'nvidia';
    if (url.includes('mistral')) return 'mistral';
    if (url.includes('fireworks')) return 'fireworks';
    return null;
  }

  /** Maximize a window via Win32 ShowWindow API. If pid is provided, finds the window by process ID. */
  private async maximizeForegroundWindow(pid?: number): Promise<void> {
    if (process.platform !== 'win32') {
      await this.desktop.keyPress(process.platform === 'darwin' ? 'ctrl+cmd+f' : 'Super+Up');
      return;
    }
    try {
      // Win11 snap layouts are persistent — use SetWindowPos to forcefully resize, then maximize.
      const typeDef = `'using System; using System.Runtime.InteropServices; public class WinMax { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'`;
      const cmd = pid
        ? `$p = Get-Process -Id ${pid} -ErrorAction Stop; $h = $p.MainWindowHandle; if ($h -ne [IntPtr]::Zero) { Add-Type -TypeDefinition ${typeDef}; $w=[WinMax]::GetSystemMetrics(0); $ht=[WinMax]::GetSystemMetrics(1); [WinMax]::ShowWindow($h,1)|Out-Null; Start-Sleep -m 100; [WinMax]::SetWindowPos($h,[IntPtr]::Zero,0,0,$w,$ht,0x0040)|Out-Null; Start-Sleep -m 100; [WinMax]::SetForegroundWindow($h)|Out-Null; [WinMax]::ShowWindow($h,3)|Out-Null; Write-Host "pid=${pid} hwnd=$h OK" } else { Write-Host "pid=${pid} no-main-window" }`
        : `Add-Type -TypeDefinition ${typeDef}; $h = [WinMax]::GetForegroundWindow(); [WinMax]::ShowWindow($h,3)|Out-Null; Write-Host "hwnd=$h OK"`;
      console.log(`   📐 Maximizing window${pid ? ` (pid ${pid})` : ''}...`);
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 5000, windowsHide: true });
      console.log(`   📐 ${stdout.trim()}`);
    } catch (e: any) {
      console.warn(`   ⚠️ PowerShell maximize failed: ${e?.message} — falling back to Alt+Space`);
      await this.desktop.keyPress('alt+space');
      await new Promise(r => setTimeout(r, 150));
      await this.desktop.keyPress('x');
    }
  }

  private async getDefaultBrowser(): Promise<string> {
    // Detect system default browser dynamically
    if (IS_MAC) {
      try {
        const { stdout } = await execFileAsync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']);
        if (stdout.includes('chrome')) return 'Google Chrome';
        if (stdout.includes('firefox')) return 'Firefox';
        if (stdout.includes('brave')) return 'Brave Browser';
        if (stdout.includes('arc')) return 'Arc';
      } catch { /* fall through */ }
      return 'Safari'; // macOS fallback
    } else {
      try {
        const { stdout } = await execFileAsync('powershell.exe', ['-Command',
          `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId`
        ]);
        const progId = stdout.trim().toLowerCase();
        if (progId.includes('chrome')) return 'Google Chrome';
        if (progId.includes('firefox')) return 'Firefox';
        if (progId.includes('brave')) return 'Brave Browser';
        if (progId.includes('opera')) return 'Opera';
        if (progId.includes('arc')) return 'Arc';
      } catch { /* fall through */ }
      return 'Microsoft Edge'; // Windows fallback
    }
  }

  /**
   * Launch a browser directly with a URL as a command-line argument.
   * Far more reliable than Ctrl+L navigation because:
   * - Bypasses Edge session restore interference
   * - Bypasses Win11 focus-stealing prevention
   * - URL loads in a new window even if old tabs are restored
   */
  private async launchBrowserWithUrl(browser: string, url: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const customExe = getBrowserExePath(this.config);
    const isChrome = /chrome/i.test(browser);
    const exePaths = customExe
      ? [customExe]
      : isChrome
        ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
        : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
    const { existsSync } = await import('fs');
    for (const exePath of exePaths) {
      if (!existsSync(exePath)) continue;
      try {
        console.log(`   🚀 ${isChrome ? 'Chrome' : 'Edge'} → ${url}`);
        const child = spawn(exePath, [
          '--profile-directory=Default',
          '--disable-session-crashed-bubble',
          '--no-first-run',
          '--new-window',
          url,
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        // Wait for window to appear, force to front, and maximize
        await new Promise(r => setTimeout(r, 3000));
        // Use HWND_TOPMOST trick to bypass Win11 focus-stealing prevention
        try {
          const forceCmd = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WF { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int ht,uint f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); }'; $p = Get-Process ${isChrome ? 'chrome' : 'msedge'} -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1; if ($p) { $h=$p.MainWindowHandle; $w=[WF]::GetSystemMetrics(0); $ht=[WF]::GetSystemMetrics(1); [WF]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x0001 -bor 0x0002)|Out-Null; Start-Sleep -m 50; [WF]::SetWindowPos($h,[IntPtr](-2),0,0,$w,$ht,0x0040)|Out-Null; Start-Sleep -m 100; [WF]::SetForegroundWindow($h)|Out-Null; [WF]::ShowWindow($h,3)|Out-Null; Write-Host "forced-front pid=$($p.Id)" }`;
          const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forceCmd], { timeout: 5000, windowsHide: true });
          console.log(`   📐 ${stdout.trim()}`);
        } catch (e: any) {
          console.warn(`   ⚠️ Force-front failed: ${e?.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
        return true;
      } catch { continue; }
    }
    return false;
  }

  /**
   * Navigate the current browser tab to a URL via Ctrl+L (fallback method).
   */
  private async navigateBrowserToUrl(url: string): Promise<void> {
    const windows = await this.a11y.getWindows().catch(() => []);
    const browserRe = getBrowserProcessRegex(this.config);
    const browserWin = windows.find(w => browserRe.test(w.processName) && !w.isMinimized);
    if (browserWin) {
      await this.a11y.focusWindow(undefined, browserWin.processId).catch(() => null);
      await new Promise(r => setTimeout(r, 400));
    }
    await this.desktop.keyPress('Escape');
    await new Promise(r => setTimeout(r, 200));
    await this.desktop.keyPress('Control+l');
    await new Promise(r => setTimeout(r, 300));
    await this.desktop.typeText(url);
    await new Promise(r => setTimeout(r, 200));
    await this.desktop.keyPress('Return');
    await new Promise(r => setTimeout(r, 3000));
    if (browserWin) {
      await this.maximizeForegroundWindow(browserWin.processId);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async connect(): Promise<void> {
    await this.desktop.connect();

    // Minimize the terminal/console window running this agent so it never
    // appears in screenshots and the vision LLM can't accidentally close it.
    if (!IS_MAC) {
      try {
        await execFileAsync('powershell.exe', ['-Command',
          `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
[WinAPI]::ShowWindow([WinAPI]::GetConsoleWindow(), 2)`  // SW_MINIMIZE = 2
        ]);
      } catch { /* non-fatal — just cosmetic */ }
    }

    // Initialize Browser Layer (Layer 0) — Playwright for browser tasks
    const pipelineConfig = loadPipelineConfig();
    // Pipeline config (from .clawdcursor-config.json) takes priority for actual model selection
    const textModel = pipelineConfig?.layer2?.model || this.config.ai.model || 'unavailable';
    const visionModel = pipelineConfig?.layer3?.model || this.config.ai.visionModel || 'unavailable';

    const textProvider = this.inferProviderLabel(
      this.config.ai.textApiKey || this.config.ai.apiKey,
      pipelineConfig?.layer2?.baseUrl || this.config.ai.textBaseUrl || this.config.ai.baseUrl,
      pipelineConfig?.providerKey || this.config.ai.provider,
    );
    const visionProvider = this.inferProviderLabel(
      this.config.ai.visionApiKey || this.config.ai.apiKey,
      pipelineConfig?.layer3?.baseUrl || this.config.ai.visionBaseUrl || this.config.ai.baseUrl,
      pipelineConfig?.providerKey || this.config.ai.provider,
    );

    console.log(`🤖 Active models: text=${textModel} (${textProvider}) | vision=${visionModel} (${visionProvider})`);

    this.browserLayer = new BrowserLayer(this.config, pipelineConfig || {} as PipelineConfig);
    // Browser layer initialized

    // Warm up the PSRunner bridge so assembly loading happens in background
    this.a11y.warmup().catch(() => {});

    // Initialize Computer Use for Anthropic or mixed-provider pipeline overrides
    const computerUseOverrides = pipelineConfig?.layer3?.computerUse
      ? {
          enabled: pipelineConfig.layer3.computerUse,
          apiKey: pipelineConfig.layer3.apiKey,
          model: pipelineConfig.layer3.model,
          baseUrl: pipelineConfig.layer3.baseUrl,
        }
      : undefined;

    // Only enable Anthropic Computer Use if the pipeline provider IS Anthropic.
    // Otherwise, a stale Anthropic key from OpenClaw auth-profiles causes false positives.
    const pipelineIsAnthropic = pipelineConfig?.providerKey === 'anthropic';
    if (pipelineIsAnthropic && ComputerUseBrain.isSupported(this.config, computerUseOverrides)) {
      this.computerUse = new ComputerUseBrain(this.config, this.desktop, this.a11y, this.safety, computerUseOverrides);
      this.computerUse.setVerifier(this.verifier);
      console.log(`🖥️  Computer Use API enabled (Anthropic native tool + accessibility)`);
    } else if (isGenericComputerUseSupported(this.config, pipelineConfig)) {
      // Non-Anthropic provider with a vision model — use the universal OpenAI-compat loop
      this.genericComputerUse = new GenericComputerUse(this.config, this.desktop, this.a11y, this.safety, pipelineConfig);
      this.genericComputerUse.setVerifier(this.verifier);
      const visionModel = pipelineConfig?.layer3?.model || this.config.ai.visionModel || 'unknown';
      console.log(`🌐 Generic Computer Use enabled (${visionModel})`);
    }

    const size = this.desktop.getScreenSize();
    this.brain.setScreenSize(size.width, size.height);
  }

  /** Maximum wall-clock time for a single task */
  private static readonly TASK_TIMEOUT_MS = 120 * 1000; // 120s — multi-step tasks need more time

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
    const startTime = Date.now();

    // Wrap the entire task pipeline with a global wall-clock timeout.
    // Individual layers have their own iteration limits, but a deadlocked
    // LLM call or runaway Computer Use loop could still exceed the limit.
    // IMPORTANT: Clear the timer when the task completes to prevent stale
    // timeouts from aborting future tasks (the aborted flag is shared).
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<TaskResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        this.aborted = true;
        console.warn(`\n⏱ Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`);
        resolve({
          success: false,
          steps: [{ action: 'error', description: `Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        });
      }, Agent.TASK_TIMEOUT_MS);
    });

    try {
      return await Promise.race([this._executeTaskInternal(task, startTime), timeoutPromise]);
    } finally {
      // Always clear the 10-minute timer so it doesn't keep the process alive
      // and hold a closure reference to this Agent instance after the task ends.
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.taskExecutionLocked = false;
    }
  }

  private async _executeTaskInternal(task: string, startTime: number): Promise<TaskResult> {

    console.log(`\n🐾 Starting task: ${task}`);
    this.logger.startTask(task);
    this.workspace.reset();
    // Reset all stateful components between tasks — prevents contamination
    this.brain.resetConversation();
    // Reset Layer 2 state between tasks — clears circuit breaker, disabledApps, CDP cache
    if (this.reasoner) this.reasoner.reset();

    // Create isolated virtual desktop for this task
    await this.createIsolatedDesktop();

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

    // Add a context accumulator to track what pre-processing already did
    const priorContext: string[] = [];

    this.state = {
      status: 'thinking',
      currentTask: task,
      stepsCompleted: 0,
      stepsTotal: 1,
    };

    // ── LLM-based task pre-processor ──
    // One cheap LLM call decomposes ANY natural language into structured intent.
    // Replaces brittle regex patterns ("open X and Y", "open X on Y") with universal parsing.
    const preprocessed = await this.preprocessTask(task);
    if (preprocessed) {
      const isBrowser = /^(edge|microsoft edge|chrome|google chrome|firefox|brave)$/i.test(preprocessed.app || '');

      // ── Browser + URL: launch browser directly with URL as argument ──
      // This is far more reliable than launching blank then navigating via Ctrl+L
      // because Win11 focus-stealing prevention + Edge session restore make Ctrl+L unreliable.
      if (isBrowser && preprocessed.navigate) {
        // Normalize common URLs: ensure English locale for Wikipedia
        let navTarget = preprocessed.navigate;
        if (/^(https?:\/\/)?(www\.)?wikipedia\.org/i.test(navTarget)) {
          navTarget = navTarget.replace(/wikipedia\.org/i, 'en.wikipedia.org');
        }
        console.log(`   🌐 Launching ${preprocessed.app} directly with ${navTarget}...`);
        try {
          const url = /^https?:\/\//i.test(navTarget) ? navTarget : `https://${navTarget}`;
          const launched = await this.launchBrowserWithUrl(preprocessed.app!, url);
          if (launched) {
            priorContext.push(`Opened "${preprocessed.app}" and navigated to ${preprocessed.navigate} — page is loading. Browser is focused and maximized.`);
            console.log(`   ✅ ${preprocessed.app} launched with ${preprocessed.navigate}`);
          } else {
            // Fallback: open browser then navigate via Ctrl+L
            console.log(`   ⚠️ Direct launch failed — trying router + Ctrl+L fallback`);
            await this.router.route(`open ${preprocessed.app}`).catch(() => null);
            await new Promise(r => setTimeout(r, 1000));
            await this.navigateBrowserToUrl(preprocessed.navigate);
            priorContext.push(`Navigated to ${preprocessed.navigate} — page is loading. Browser is focused.`);
          }
        } catch (err) {
          console.log(`   ⚠️ Browser+URL launch failed: ${err}`);
          priorContext.push(`Navigate to: ${preprocessed.navigate} (attempted but may need retry)`);
        }
      }
      // ── Non-browser app: open via router ──
      else if (preprocessed.app) {
        console.log(`   Opening "${preprocessed.app}"...`);
        try {
          const openResult = await this.router.route(`open ${preprocessed.app}`);
          if (openResult.handled) {
            priorContext.push(`Opened "${preprocessed.app}" — it is ALREADY the active, focused, maximized window. Do NOT reopen it. Do NOT press Windows key. Start interacting with it IMMEDIATELY.`);
            // WebView2 apps (Outlook, Teams, etc.) need extra time before UIA queries
            const webview2Apps = /outlook|teams|slack|discord|spotify|vscode/i;
            const heavyApps = /word|excel|powerpoint/i;
            const settleMs = webview2Apps.test(preprocessed.app!) ? 4000 : heavyApps.test(preprocessed.app!) ? 2000 : 500;
            await new Promise(r => setTimeout(r, settleMs));
            try {
              const appWin = await this.a11y.findWindow(preprocessed.app!);
              if (appWin) {
                await this.a11y.focusWindow(undefined, appWin.processId);
                await new Promise(r => setTimeout(r, 200));
                await this.maximizeForegroundWindow(appWin.processId);
                await new Promise(r => setTimeout(r, 300));
                console.log(`   ✅ ${preprocessed.app} focused & maximized (pid ${appWin.processId})`);
              }
            } catch { /* non-critical */ }
          }
        } catch (err) {
          console.log(`   ⚠️ Pre-open failed: ${err} — proceeding with full task`);
        }
      }

      // ── URL navigation without explicit browser app (use default browser) ──
      if (preprocessed.navigate && !isBrowser) {
        if (!preprocessed.app) {
          const defaultBrowser = await this.getDefaultBrowser();
          console.log(`   🌐 Launching ${defaultBrowser} with ${preprocessed.navigate}...`);
          try {
            const url = /^https?:\/\//i.test(preprocessed.navigate) ? preprocessed.navigate : `https://${preprocessed.navigate}`;
            const launched = await this.launchBrowserWithUrl(defaultBrowser, url);
            if (launched) {
              priorContext.push(`Opened "${defaultBrowser}" and navigated to ${preprocessed.navigate} — page is loading. Browser is focused and maximized.`);
            } else {
              await this.router.route(`open ${defaultBrowser}`).catch(() => null);
              await new Promise(r => setTimeout(r, 1000));
              await this.navigateBrowserToUrl(preprocessed.navigate);
              priorContext.push(`Navigated to ${preprocessed.navigate} — page is loading. Browser is focused.`);
            }
          } catch (err) {
            console.log(`   ⚠️ Default browser launch failed: ${err}`);
            priorContext.push(`Navigate to: ${preprocessed.navigate} (attempted but may need retry)`);
          }
        } else {
          // Non-browser app already opened above, but also has a navigate URL — use Ctrl+L
          console.log(`   🌐 Navigating to ${preprocessed.navigate}...`);
          try {
            await this.navigateBrowserToUrl(preprocessed.navigate);
            priorContext.push(`Navigated to ${preprocessed.navigate} — page is loading.`);
          } catch (err) {
            console.log(`   ⚠️ Navigation failed: ${err}`);
            priorContext.push(`Navigate to: ${preprocessed.navigate} (attempted but may need retry)`);
          }
        }
      }

      // Use the refined task from LLM
      if (preprocessed.task && preprocessed.task !== task) {
        task = preprocessed.task;
        console.log(`   ➡️ Continuing with: "${task}"`);
      }

      // Store context hints for shortcut matching
      if (preprocessed.contextHints?.length) {
        priorContext.push(`Context: ${preprocessed.contextHints.join(', ')}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // TWO COMPLETELY SEPARATE PATHS:
    //
    // PATH A: Computer Use (Anthropic)
    //   → Full task goes directly to Computer Use API (vision LLM)
    //   → Vision LLM screenshots, plans with visual context, executes
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
        await this.closeIsolatedDesktop();
        return result;
      }
      // Browser layer couldn't handle it — fall through
      if (browserResult.handled === false) {
        console.log(`   🌐 Browser Layer: not handled — falling through to Action Router`);
      }
    }

    // ── Layer 1: Action Router + Shortcuts (regex + a11y, zero LLM calls) ──
    // Only runs when the preprocessor did NOT already act (priorContext empty).
    // When the preprocessor opened an app and refined the task, the remaining work
    // needs OCR/vision reasoning — the router would claim success on "type X" without typing.
    const skipTopRouter = priorContext.length > 0;
    {
      this.state.status = 'acting';
      if (skipTopRouter) {
        console.log(`\n⚡ Action Router: SKIPPED — preprocessor already handled app launch, task needs OCR reasoning`);
      } else {
      console.log(`\n⚡ Action Router: attempting "${task}"`);
      }
      const routeResult = skipTopRouter
        ? { handled: false, description: 'Skipped — preprocessed task needs OCR reasoning' }
        : await this.router.route(task);
      const telemetry = this.router.getTelemetry();
      // Telemetry logged silently
      if (routeResult.handled) {
        const routeLatency = Date.now() - startTime;
        const step: StepResult = {
          action: 'action-router',
          description: routeResult.description,
          success: !routeResult.error,
          timestamp: Date.now(),
          layer: 'router',
          method: 'a11y_invoke',
          latencyMs: routeLatency,
        };
        console.log(`[ROUTER] Step 1: route "${task}" a11y_invoke → ${step.success ? 'SUCCESS' : 'FAILED'} (${routeLatency}ms)`);
        this.logger.logStep({
          layer: 1,
          actionType: 'route',
          result: step.success ? 'success' : 'fail',
          actionParams: { task },
          durationMs: routeLatency,
        });
        const result: TaskResult = {
          success: !routeResult.error,
          steps: [step],
          duration: Date.now() - startTime,
        };
        console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s — Action Router (0 LLM calls, $0)`);
        this.state = { status: 'idle', stepsCompleted: 1, stepsTotal: 1 };
        await this.closeIsolatedDesktop();
        return result;
      }
      console.log(`   ⚡ Action Router: not matched — falling through`);
    }

    // ── Layer 2+: Decompose → A11y Reasoner → vision fallback per subtask ──
    // Always decompose first so the a11y reasoner gets single-step subtasks.
    // Computer Use is used as a per-subtask fallback inside executeWithDecomposeAndRoute,
    // not as a first-class handler for the whole task.
    return this.executeWithDecomposeAndRoute(task, debugDir, startTime, priorContext);
  }

  /**
   * macOS only: extract the first recognisable app name from the task string
   * and bring it to the foreground with `open -a` so Computer Use gets a
   * clean screenshot of the right window immediately.
   *
   * Returns the app name that was focused, or null if nothing was found.
   * Safe no-op on Windows/Linux.
   */
  private async prefocusAppForTask(task: string): Promise<string | null> {
    if (!IS_MAC) return null;

    // Map of keywords → macOS app names (case-insensitive search in task text)
    const APP_HINTS: Array<{ pattern: RegExp; appName: string }> = [
      { pattern: /\bcodex\b/i,                         appName: 'Codex' },
      { pattern: /\bcursor\b/i,                        appName: 'Cursor' },
      { pattern: /\bvscode\b|\bvisual studio code\b/i, appName: 'Visual Studio Code' },
      { pattern: /\bchrome\b|\bgoogle chrome\b/i,      appName: 'Google Chrome' },
      { pattern: /\bsafari\b/i,                        appName: 'Safari' },
      { pattern: /\bfirefox\b/i,                       appName: 'Firefox' },
      { pattern: /\bslack\b/i,                         appName: 'Slack' },
      { pattern: /\bdiscord\b/i,                       appName: 'Discord' },
      { pattern: /\bfigma\b/i,                         appName: 'Figma' },
      { pattern: /\bspotify\b/i,                       appName: 'Spotify' },
      { pattern: /\bterminal\b/i,                      appName: 'Terminal' },
      { pattern: /\biterm\b/i,                         appName: 'iTerm' },
      { pattern: /\bwezterm\b/i,                       appName: 'WezTerm' },
      { pattern: /\bfinder\b/i,                        appName: 'Finder' },
      { pattern: /\bcalculator\b/i,                    appName: 'Calculator' },
      { pattern: /\bnotes\b/i,                         appName: 'Notes' },
      { pattern: /\bmail\b/i,                          appName: 'Mail' },
      { pattern: /\bxcode\b/i,                         appName: 'Xcode' },
    ];

    for (const { pattern, appName } of APP_HINTS) {
      if (pattern.test(task)) {
        try {
          // 1. Bring the app to front
          await execFileAsync('open', ['-a', appName]);
          await new Promise(r => setTimeout(r, 600));

          // 2. Move its front window to the primary screen so nut-js screen.grab()
          //    captures it (nut-js only grabs the primary/main display).
          //    This is critical for multi-monitor setups.
          const jxa = `
            var se = Application("System Events");
            var procs = se.processes.whose({name: "${appName}"});
            if (procs.length > 0) {
              var proc = procs[0];
              if (proc.windows.length > 0) {
                var win = proc.windows[0];
                win.position.set([120, 80]);
                win.size.set([1280, 900]);
              }
            }
          `.trim();
          await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa]).catch(() => {
            // Non-fatal — window stays where it is
          });

          await new Promise(r => setTimeout(r, 400)); // let window settle after move
          console.log(`   🎯 Pre-focused: ${appName} → moved to primary screen`);
          return appName;
        } catch {
          // App not installed or name mismatch — skip silently
        }
      }
    }
    return null;
  }

  /**
   * LLM-based task pre-processor.
   * One cheap text LLM call parses any natural language command into structured intent.
   * Returns null if no LLM is available (falls back to direct execution).
   */
  private async preprocessTask(task: string): Promise<{
    app?: string;
    navigate?: string;
    task: string;
    contextHints?: string[];
  } | null> {
    // Need a text model to pre-process
    if (!this.hasApiKey && !this.reasoner) return null;

    // Skip pre-processing only for genuinely simple, non-compound tasks.
    // A compound task ("open X and send email", "open X then type Y") MUST go through
    // pre-processing so it gets decomposed properly.
    const hasCompound = /(?:,|\b(?:and|then)\b)/i.test(task.trim());
    if (!hasCompound) {
      const routerHandled = [
        /^(?:open|launch|start|run)\s+\S/i,
        /^(?:type|enter|write|input)\s+/i,
        /^(?:go to|navigate to|visit|browse to)\s+/i,
        /^(?:press|hit)\s+/i,
        /^(?:click|tap)\s+/i,
        /^(?:focus|switch to|bring up|activate)\s+/i,
        /^(?:close|minimize|maximize)\s+/i,
        /^(?:find|search in page)\s+/i,
        /^(?:scroll|copy|paste|undo|redo|save|refresh|back|forward)\b/i,
      ];
      if (routerHandled.some(p => p.test(task.trim()))) return null;
    }

    const systemPrompt = `You are a task pre-processor for an AI desktop agent. Parse the user's command into structured JSON.

Your job: identify what app/browser to open FIRST (if any), what URL to navigate to (if any), and what the REMAINING task is after the app is open.

RULES:
- "open X on Y" where Y is a browser → app is the browser, navigate is X, task is remaining work
- "open X and Y" → app is X, task is Y
- "go to X" or "check X" where X is a website → app is null (will default to system browser), navigate is X
- If the task mentions a specific browser (Edge, Chrome, Firefox, Brave, Safari), use it
- If no app needs opening, set app to null
- contextHints: list relevant platforms/sites (e.g. "reddit", "twitter", "gmail") for shortcut matching
- The "task" field MUST contain ALL remaining work after the FIRST app is opened and URL navigated
- CRITICAL: If the command involves multiple apps (e.g. "copy from X then paste in Y"), the task field MUST include the full chain of remaining actions including switching to other apps
- If the whole task is just "open X", task should be empty string

SMART URL RULE — VERY IMPORTANT:
When the task involves creating, searching, or navigating directly to content on a website, use the DIRECT ACTION URL that skips the homepage. The agent navigates to this URL immediately, so it must land on the right page.

Creation URLs:
- "write in a new google doc" → navigate: "docs.google.com/document/create" (NOT docs.google.com)
- "create a new spreadsheet" → navigate: "docs.google.com/spreadsheets/create"
- "create a new presentation" → navigate: "docs.google.com/presentation/create"
- "create a github repo" → navigate: "github.com/new"
- "create a new notion page" → navigate: "notion.so/new"
- "compose an email in gmail" → navigate: "mail.google.com/mail/u/0/#inbox?compose=new"
- "create a new codepen" → navigate: "codepen.io/pen/"
- "post on twitter" → navigate: "twitter.com/compose/tweet"

Search URLs (use query parameters to skip manual search):
- "google search for cats" → navigate: "google.com/search?q=cats"
- "search google for speed of light" → navigate: "google.com/search?q=speed+of+light"
- "search youtube for music" → navigate: "youtube.com/results?search_query=music"
- "search amazon for laptops" → navigate: "amazon.com/s?k=laptops"
- "search wikipedia for Python" → navigate: "en.wikipedia.org/wiki/Python"
- "search github for react" → navigate: "github.com/search?q=react"
For search queries, URL-encode spaces as + and special chars as %XX.

Apply this pattern to ANY website you know has a direct create/search/action URL. If unsure, use the base URL.

VALIDATION RULE: The task field combined with app+navigate must account for EVERY action in the original command. If you drop any part, the agent will fail.

NEVER RULES:
- NEVER summarize or shorten the task. Include the EXACT remaining actions word for word.
- NEVER omit steps involving multiple apps, copying/pasting, saving, or switching between applications.
- NEVER assume steps are "obvious" or can be inferred - spell out every action explicitly.

Browser name mapping:
- edge → Microsoft Edge
- chrome → Google Chrome  
- firefox → Firefox
- brave → Brave
- safari → Safari

Respond with ONLY valid JSON, no markdown:
{"app": "string or null", "navigate": "url or null", "task": "remaining task", "contextHints": ["hint1"]}

Examples:
- "open reddit on edge" → {"app": "Microsoft Edge", "navigate": "reddit.com", "task": "", "contextHints": ["reddit"]}
- "open paint and draw a cat" → {"app": "Paint", "navigate": null, "task": "draw a cat", "contextHints": ["paint"]}
- "check my email in chrome" → {"app": "Google Chrome", "navigate": "gmail.com", "task": "check email", "contextHints": ["gmail"]}
- "go to youtube and find a funny video" → {"app": null, "navigate": "youtube.com", "task": "find a funny video", "contextHints": ["youtube"]}
- "go to wikipedia" → {"app": null, "navigate": "wikipedia.org", "task": "", "contextHints": ["wikipedia"]}
- "scroll down" → {"app": null, "navigate": null, "task": "scroll down", "contextHints": []}
- "open reddit on edge and scroll down through posts and interact with one" → {"app": "Microsoft Edge", "navigate": "reddit.com", "task": "scroll down through posts and interact with one", "contextHints": ["reddit"]}
- "open wikipedia on edge, copy a sentence, then paste it in google docs" → {"app": "Microsoft Edge", "navigate": "wikipedia.org", "task": "scroll through an article, copy an interesting sentence, then open Google Docs and paste it there", "contextHints": ["wikipedia", "google docs"]}
- "open wikipedia, copy a sentence, then open notepad and paste it" → {"app": null, "navigate": "wikipedia.org", "task": "copy a sentence from wikipedia, then open notepad and paste the sentence", "contextHints": ["wikipedia", "notepad"]}
- "search for cats on google, copy the first result link, then open email and paste it" → {"app": null, "navigate": "google.com/search?q=cats", "task": "copy the first result link, then open email application and paste the link", "contextHints": ["google", "email"]}
- "open amazon and find a book, then save the title to a text file" → {"app": null, "navigate": "amazon.com", "task": "find a book, copy or note the title, then open text editor and save the title to a file", "contextHints": ["amazon", "text file"]}
- "compare prices between amazon and ebay for laptops" → {"app": null, "navigate": "amazon.com", "task": "search for laptops and note prices, then open ebay in new tab and compare laptop prices", "contextHints": ["amazon", "ebay"]}
- "drag an image from browser to desktop" → {"app": null, "navigate": null, "task": "drag an image from browser window to desktop", "contextHints": ["browser", "desktop"]}`;

    const startTime = Date.now();
    try {
      console.log(`\n🧠 Pre-processing task with LLM...`);

      let response: string;

      if (this.reasoner) {
        // Use shared LLM client — correctly handles Anthropic (/messages) and OpenAI (/chat/completions)
        const pipelineConfig = loadPipelineConfig();
        if (!pipelineConfig) return null;

        response = await callTextLLM(pipelineConfig, {
          system: systemPrompt,
          user: `Parse this command: "${task}"`,
          maxTokens: 300,
          timeoutMs: 10000,
        });
      } else {
        return null;
      }

      const elapsed = Date.now() - startTime;
      console.log(`   ⚡ Pre-processed in ${elapsed}ms`);
      this.logger.logStep({ layer: 'preprocess', actionType: 'llm_preprocess', result: 'success', durationMs: elapsed, llmReasoning: response.substring(0, 200) });
      this.logger.recordLlmCall();

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`   ⚠️ Pre-processor returned no JSON — skipping`);
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`   📋 Intent: app=${parsed.app || 'none'}, navigate=${parsed.navigate || 'none'}, task="${parsed.task || task}"`);

      return {
        app: parsed.app || undefined,
        navigate: parsed.navigate || undefined,
        task: parsed.task || task,
        contextHints: parsed.contextHints || [],
      };
    } catch (err) {
      // Propagate auth/billing errors so the task fails immediately with a clear message
      if (err instanceof LLMBillingError || err instanceof LLMAuthError) throw err;
      const elapsed = Date.now() - startTime;
      console.log(`   ⚠️ Pre-processor failed: ${err} — proceeding with raw task`);
      this.logger.logStep({ layer: 'preprocess', actionType: 'llm_preprocess', result: 'fail', durationMs: elapsed, error: String(err).substring(0, 200) });
      return null;
    }
  }

  /**
   * PATH A: Anthropic Computer Use
   * Give the full task to the vision LLM — it screenshots, plans, and executes.
   */
  private async executeWithComputerUse(
    task: string,
    debugDir: string | null,
    startTime: number,
    priorContext?: string[],
  ): Promise<TaskResult> {
    console.log(`   🖥️  Using Computer Use API (screenshot-first)\n`);

    // macOS: bring the target app to front before the first screenshot
    await this.prefocusAppForTask(task);

    this.state.status = 'acting';
    try {
      const cuResult = await this.computerUse!.executeSubtask(task, debugDir, 0, priorContext, this.logger);

      const result: TaskResult = {
        success: cuResult.success,
        steps: cuResult.steps,
        duration: Date.now() - startTime,
      };

      console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${cuResult.steps.length} steps (${cuResult.llmCalls} LLM call(s))`);
      return result;
    } catch (err) {
      if (err instanceof LLMBillingError) {
        console.error(`\n❌ API credits exhausted — task cannot proceed.`);
        return {
          success: false,
          steps: [{ action: 'error', description: `API credits exhausted: ${err.message}`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        };
      }
      if (err instanceof LLMAuthError) {
        console.error(`\n❌ API authentication failed — check your API key.`);
        return {
          success: false,
          steps: [{ action: 'error', description: `API auth failed: ${err.message}`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        };
      }
      console.error(`\n❌ Computer Use crashed:`, err);
      return {
        success: false,
        steps: [{ action: 'error', description: `Computer Use crashed: ${err}`, success: false, timestamp: Date.now() }],
        duration: Date.now() - startTime,
      };
    } finally {
      await this.closeIsolatedDesktop();
      this.state.status = 'idle';
      this.state.currentTask = undefined;
    }
  }

  /**
   * PATH B: Decompose → A11y Reasoner → Computer Use fallback per subtask.
   * Always used now — Computer Use runs per-subtask, not on the whole task.
   */
  private async executeWithDecomposeAndRoute(
    task: string,
    debugDir: string | null,
    startTime: number,
    priorContext?: string[],
  ): Promise<TaskResult> {
    const steps: StepResult[] = [];
    let llmCallCount = 0;

    // decompose → a11y → vision pipeline

    try {

    // ─── Decompose ───────────────────────────────────────────────
    // decomposing task
    const decompositionStart = Date.now();
    let subtasks: string[];

    // If pre-processing ran (priorContext array exists), try local decomposition.
    // Even after preprocessing, the remaining task may be compound ("type X. Then save as Y").
    // The local parser is instant (no API call) so there's no cost to trying it.
    const wasPreprocessed = priorContext !== undefined && priorContext.length > 0;
    if (wasPreprocessed) {
      // Try local parser first — splits on "then", "and then", comma+verb
      const localSplit = this.parser.decomposeTask(task);
      if (localSplit && localSplit.length > 1) {
        subtasks = localSplit;
        console.log(`   ⚡ Pre-processed task decomposed locally: ${localSplit.length} subtask(s) (${Date.now() - decompositionStart}ms)`);
      } else {
        subtasks = [task];
        console.log(`   ⚡ Pre-processed task — straight to Layer 2 (${Date.now() - decompositionStart}ms)`);
      }
    } else {
    // No pre-processing context — try local parser first (instant, no API call)
    const localResult = this.parser.decomposeTask(task);
    if (localResult) {
      subtasks = localResult;
      console.log(`   ⚡ Local parser handled in ${Date.now() - decompositionStart}ms (offline)`);
    } else if (this.hasApiKey) {
      console.log(`   🧠 Using LLM to decompose task...`);
      subtasks = await this.brain.decomposeTask(task);
      llmCallCount = 1;
      console.log(`   Decomposed via LLM in ${Date.now() - decompositionStart}ms`);
    } else {
      console.log(`   ❌ Task too complex for offline mode.`);
      return {
        success: false,
        steps: [{ action: 'error', description: 'Task too complex for offline mode. Set AI_API_KEY or run clawdcursor doctor to unlock AI fallback.', success: false, timestamp: Date.now() }],
        duration: Date.now() - startTime,
      };
    }
    } // close the priorContext else block

    console.log(`   ${subtasks.length} subtask(s):`);
    subtasks.forEach((st, i) => console.log(`   ${i + 1}. "${st}"`));
    this.state.stepsTotal = subtasks.length;

    // ─── Execute each subtask ────────────────────────────────────
    // executing subtasks

    for (let i = 0; i < subtasks.length; i++) {
      if (this.aborted) {
        steps.push({ action: 'aborted', description: 'User aborted', success: false, timestamp: Date.now() });
        break;
      }

      const subtask = subtasks[i];
      const classification = classifyTask(subtask);
      console.log(`\n── Subtask ${i + 1}/${subtasks.length}: "${subtask}" ──`);
      console.log(`   📊 ${classification.category} (${(classification.confidence * 100).toFixed(0)}%${classification.needsVision ? ', vision-required' : ''})`);
      this.state.currentStep = subtask;
      this.state.stepsCompleted = i;

      // ── SPATIAL TASKS: skip text-only layers, go straight to Vision ──
      if (classification.needsVision) {
        console.log(`   ⏩ Skipping Layers 1-2 — spatial task needs vision`);
        // Jump directly to Layer 3 block below (skip router + unified)
      }

      // Try router — for mechanical/navigation tasks, or as retry for pre-processed tasks
      const skipRouter = classification.needsVision || false; // Only skip for spatial
      this.state.status = 'acting';
      const routeResult = skipRouter
        ? { handled: false, description: 'Skipped — task needs vision/reasoning' }
        : await this.router.route(subtask);

      if (routeResult.handled) {
        console.log(`[ROUTER] Step ${i + 1}: route "${subtask}" a11y_invoke → SUCCESS`);
        this.logger.logStep({
          layer: 1,
          actionType: 'route',
          result: 'success',
          actionParams: { subtask },
        });
        console.log(`   ✅ Router: ${routeResult.description}`);
        steps.push({ action: 'routed', description: routeResult.description, success: true, timestamp: Date.now(), layer: 'router', method: 'a11y_invoke' });
        const isLaunch = routeResult.description.toLowerCase().includes('launch');
        const isTimeout = routeResult.description.toLowerCase().includes('timeout');
        await this.delay(isLaunch ? 150 : 50);

        // If router reported a timeout/warning OR this is a click that might not have worked,
        // AND there are remaining subtasks, hand off remaining work to Computer Use
        if (isTimeout && subtasks.length > 1 && i < subtasks.length - 1 && this.computerUse) {
          const remainingTask = subtasks.slice(i + 1).join(', then ');
          console.log(`   ⚠️ Router had timeout — handing remaining ${subtasks.length - i - 1} subtask(s) to Computer Use`);
          console.log(`   🖥️  Remaining: "${remainingTask}"`);
          const fallbackResult = await this.executeLLMFallback(remainingTask, steps, debugDir, i + 1);
          llmCallCount += fallbackResult.llmCalls;
          break; // Computer Use handled the rest
        }
        continue;
      }

      // If this is a browser task, ensure the browser has focus before Layer 2 reads the active window.
      // The preprocessor navigates but may leave the terminal with focus.
      const browserProcessRe = getBrowserProcessRegex(this.config);
      const isBrowserTask = priorContext?.some(c => /navigated to|opened.*(?:edge|chrome|browser)/i.test(c));
      let browserProcessName: string | undefined;
      if (isBrowserTask) {
        try {
          const windows = await this.a11y?.getWindows().catch(() => []) ?? [];
          const edgeWin = windows.find(w => browserProcessRe.test(w.processName) && !w.isMinimized);
          if (edgeWin) {
            browserProcessName = edgeWin.processName; // remember target process
            // Try focus up to 3 times with increasing delay
            for (let attempt = 0; attempt < 3; attempt++) {
              await this.a11y?.focusWindow(undefined, edgeWin.processId).catch(() => null);
              await this.delay(500 + attempt * 300);
              const checkWin = await this.a11y?.getActiveWindow().catch(() => null);
              if (checkWin && browserProcessRe.test(checkWin.processName)) break;
            }
          }
        } catch { /* non-critical */ }
      }

      // ── Layer 2: Skill Cache — replay learned paths ─────────────
      let activeWin = await this.a11y?.getActiveWindow().catch(() => null);
      if (!activeWin) {
        await this.delay(400);
        activeWin = await this.a11y?.getActiveWindow().catch(() => null);
      }
      const activeProcessForSkill = browserProcessName || activeWin?.processName || '';

      const cachedSkill = this.skillCache.findSkill(subtask, activeProcessForSkill);
      if (cachedSkill) {
        const skillResult = await this.skillCache.executeSkill(cachedSkill, this.desktop, this.a11y);
        if (skillResult === 'success') {
          steps.push({ action: 'done', description: `Skill cache: "${cachedSkill.taskPattern}" replayed`, success: true, timestamp: Date.now() });
          continue;
        }
        // miss → fall through to OCR or A11y
        console.log(`   🔄 Skill cache miss — falling through`);
      }

      // ── Layer 1.5: Deterministic Flows — zero-LLM verified workflows ──
      const activeForFlow = await this.a11y?.getActiveWindow().catch(() => null);
      const flowApp = activeForFlow?.processName || activeForFlow?.title || '';
      const flowResult = await this.deterministicFlows.tryFlow(subtask, flowApp);
      if (flowResult?.handled) {
        console.log(`   ⚡ Deterministic flow completed: ${flowResult.description} (${flowResult.stepsCompleted} steps)`);
        steps.push({
          action: 'done',
          description: flowResult.description,
          success: true,
          timestamp: Date.now(),
          layer: 'deterministic',
          method: 'deterministic_flow',
        });
        this.logger.logStep({
          layer: 1.5,
          actionType: 'deterministic_flow',
          result: 'success',
          actionParams: { subtask, steps: flowResult.stepsCompleted },
          durationMs: 0,
        });
        continue;
      }
      if (flowResult && !flowResult.handled) {
        console.log(`   🔄 Deterministic flow failed at step ${flowResult.failedAtStep}: ${flowResult.description} — falling through to OCR`);
      }

      // ── Layer 1.8: Action Router (retry for pre-processed tasks) ──
      // Even when the top-level router was skipped, individual subtasks like
      // "type [text]", "save as [filename]" can be handled cheaply by the router.
      if (!classification.needsVision && !routeResult.handled) {
        const retryRouteResult = await this.router.route(subtask);
        if (retryRouteResult.handled) {
          console.log(`[ROUTER] Step ${i + 1}: route "${subtask}" (retry) → SUCCESS`);
          this.logger.logStep({
            layer: 1,
            actionType: 'route',
            result: 'success',
            actionParams: { subtask, retried: true },
          });
          console.log(`   ✅ Router (retry): ${retryRouteResult.description}`);
          steps.push({ action: 'routed', description: retryRouteResult.description, success: true, timestamp: Date.now(), layer: 'router', method: 'a11y_invoke' });
          await this.delay(50);
          continue;
        }
      }

      // ── Layer 2: Unified Reasoner — parallel OCR + A11y perception ──
      // SKIP for spatial tasks (needsVision) — they go straight to Layer 3
      let unifiedResult: { handled: boolean; success: boolean; description: string; steps: number; fallbackReason?: string; needsHuman?: boolean; actionLog: Array<{ action: string; description: string }> } | null = null;
      if (this.ocrReasoner && !classification.needsVision) {
        console.log(`\n👁️ Layer 2 (Unified): "${subtask}"`);
        const unifiedStart = Date.now();
        unifiedResult = await this.ocrReasoner.run(subtask, priorContext, () => this.aborted);
        const unifiedDuration = Date.now() - unifiedStart;

        if (unifiedResult.handled && unifiedResult.success) {
          steps.push({
            action: 'done',
            description: unifiedResult.description,
            success: true,
            timestamp: Date.now(),
            layer: 'unified',
            method: 'unified_perception',
            latencyMs: unifiedDuration,
          });
          console.log(`[Unified] Step ${i + 1}: ${unifiedResult.steps} steps for "${subtask}" → SUCCESS (${(unifiedDuration / 1000).toFixed(1)}s)`);
          for (const entry of unifiedResult.actionLog) {
            console.log(`  [Unified] ${entry.action}: ${entry.description}`);
          }
          this.logger.logStep({
            layer: 2,
            actionType: 'unified_reason',
            result: 'success',
            actionParams: { subtask, steps: unifiedResult.steps },
            durationMs: unifiedDuration,
          });
          // Record for skill promotion
          const uSteps = unifiedResult.actionLog
            .filter(a => a.action !== 'done' && a.action !== 'parse_error' && a.action !== 'error')
            .map(a => ({ type: a.action as any, description: a.description }));
          this.skillCache.recordSuccess(subtask, activeProcessForSkill, uSteps);
          console.log(`   ✅ Unified Reasoner done (${unifiedResult.steps} steps, ${(unifiedDuration / 1000).toFixed(1)}s)`);
          continue;
        }

        // Check if needs human intervention (payment, captcha, 2FA, etc.)
        if (unifiedResult.needsHuman) {
          console.log(`[Unified] Step ${i + 1}: "${subtask}" → NEEDS_HUMAN: ${(unifiedResult.description ?? 'unknown').substring(0, 100)}`);
          this.logger.logStep({
            layer: 2,
            actionType: 'unified_reason',
            result: 'blocked',
            actionParams: { subtask },
            durationMs: unifiedDuration,
            error: 'needs_human: ' + (unifiedResult.description ?? 'unknown').substring(0, 200),
          });
          console.log(`\n🙋 NEEDS HUMAN INTERVENTION: ${unifiedResult.description ?? 'unknown'}`);
          steps.push({
            action: 'needs-human',
            description: unifiedResult.description,
            success: false,
            timestamp: Date.now(),
            layer: 'unified',
          });
          break; // Stop processing — do NOT fall through to Layer 3
        }

        // Unified Reasoner failed — log and fall through to Layer 3
        console.log(`[Unified] Step ${i + 1}: "${subtask}" → FAILED (${unifiedResult.steps} steps, ${(unifiedDuration / 1000).toFixed(1)}s)`);
        for (const entry of unifiedResult.actionLog) {
          console.log(`  [Unified] ${entry.action}: ${entry.description}`);
        }
        this.logger.logStep({
          layer: 2,
          actionType: 'unified_reason',
          result: 'fail',
          actionParams: { subtask, steps: unifiedResult.steps, actions: unifiedResult.actionLog.map(a => `${a.action}:${(a.description ?? 'unknown').substring(0,80)}`).join(' | ') },
          durationMs: unifiedDuration,
          error: unifiedResult.description?.substring(0, 200),
        });
        console.log(`   🤷 Unified → Layer 3 (${unifiedResult.steps} steps, ${(unifiedDuration / 1000).toFixed(1)}s): ${(unifiedResult.description ?? 'no description').substring(0, 100)}`);
      }

      // Layer 3: Vision fallback — Computer Use takes over when Unified Reasoner cannot proceed
      const enrichedContext = [...(priorContext ?? [])];
      if (unifiedResult?.actionLog && unifiedResult.actionLog.length > 0) {
        enrichedContext.push(
          `Unified Reasoner already tried these actions (do NOT repeat them):\n` +
          unifiedResult.actionLog.map((a, idx) => `  ${idx + 1}. ${a.action} — ${a.description}`).join('\n')
        );
      }

      if (this.computerUse || this.genericComputerUse || this.hasApiKey) {
        const remainingTask = subtasks.slice(i).join(', then ');
        if (this.computerUse) {
          // Anthropic native Computer Use
          console.log(`[CU] Step ${i + 1}: Anthropic Computer Use "${remainingTask.substring(0, 80)}"`);
          console.log(`   🖥️  Layer 3 (Anthropic): "${remainingTask}"`);
          const cuStart = Date.now();
          try {
            const cuResult = await this.computerUse.executeSubtask(remainingTask, debugDir, i, enrichedContext, this.logger);
            const cuDuration = Date.now() - cuStart;
            const cuSuccess = cuResult.steps.some(s => s.success);
            console.log(`[CU] Step ${i + 1}: → ${cuSuccess ? 'SUCCESS' : 'FAILED'} (${cuResult.steps.length} steps, ${cuResult.llmCalls} LLM calls, ${(cuDuration / 1000).toFixed(1)}s)`);
            this.logger.logStep({
              layer: 3,
              actionType: 'computer_use_anthropic',
              result: cuSuccess ? 'success' : 'fail',
              actionParams: { task: remainingTask.substring(0, 200), steps: cuResult.steps.length, llmCalls: cuResult.llmCalls },
              durationMs: cuDuration,
            });
            for (const s of cuResult.steps) {
              s.layer = 'computer-use';
              s.method = 'mouse';
            }
            steps.push(...cuResult.steps);
            llmCallCount += cuResult.llmCalls;
          } catch (err) {
            // Propagate auth/billing errors to the outer catch for clear messaging
            if (err instanceof LLMBillingError || err instanceof LLMAuthError) throw err;
            const cuDuration = Date.now() - cuStart;
            console.log(`[CU] Step ${i + 1}: → CRASHED: ${err}`);
            this.logger.logStep({
              layer: 3,
              actionType: 'computer_use_anthropic',
              result: 'fail',
              actionParams: { task: remainingTask.substring(0, 200) },
              durationMs: cuDuration,
              error: String(err).substring(0, 200),
            });
            steps.push({ action: 'error', description: `Computer Use failed: ${err}`, success: false, timestamp: Date.now(), layer: 'computer-use' });
          }
        } else if (this.genericComputerUse) {
          // Generic OpenAI-compat vision loop (GPT-4o, Gemini, Groq, Llama-vision, etc.)
          console.log(`[CU] Step ${i + 1}: Generic Computer Use "${remainingTask.substring(0, 80)}"`);
          console.log(`   🌐 Layer 3 (Generic): "${remainingTask}"`);
          const cuStart = Date.now();
          try {
            const cuResult = await this.genericComputerUse.executeSubtask(remainingTask, debugDir, i, enrichedContext, this.logger, () => this.aborted);
            const cuDuration = Date.now() - cuStart;
            const cuSuccess = cuResult.steps.some(s => s.success);
            console.log(`[CU] Step ${i + 1}: → ${cuSuccess ? 'SUCCESS' : 'FAILED'} (${cuResult.steps.length} steps, ${cuResult.llmCalls} LLM calls, ${(cuDuration / 1000).toFixed(1)}s)`);
            this.logger.logStep({
              layer: 3,
              actionType: 'computer_use_generic',
              result: cuSuccess ? 'success' : 'fail',
              actionParams: { task: remainingTask.substring(0, 200), steps: cuResult.steps.length, llmCalls: cuResult.llmCalls },
              durationMs: cuDuration,
            });
            for (const s of cuResult.steps) {
              s.layer = 'computer-use';
              s.method = 'mouse';
            }
            steps.push(...cuResult.steps);
            llmCallCount += cuResult.llmCalls;
          } catch (err) {
            // Propagate auth/billing errors to the outer catch for clear messaging
            if (err instanceof LLMBillingError || err instanceof LLMAuthError) throw err;
            const cuDuration = Date.now() - cuStart;
            console.log(`[CU] Step ${i + 1}: → CRASHED: ${err}`);
            this.logger.logStep({
              layer: 3,
              actionType: 'computer_use_generic',
              result: 'fail',
              actionParams: { task: remainingTask.substring(0, 200) },
              durationMs: cuDuration,
              error: String(err).substring(0, 200),
            });
            steps.push({ action: 'error', description: `Generic Computer Use failed: ${err}`, success: false, timestamp: Date.now(), layer: 'computer-use' });
          }
        } else {
          // Legacy fallback — vision LLM without structured tool schema
          await this.delay(150);
          console.log(`[CU] Step ${i + 1}: Legacy vision fallback "${remainingTask.substring(0, 80)}"`);
          console.log(`   🧠 Layer 3 (legacy fallback): "${remainingTask}"`);
          const legacyStart = Date.now();
          const fallbackResult = await this.executeLLMFallback(remainingTask, steps, debugDir, i);
          const legacyDuration = Date.now() - legacyStart;
          console.log(`[CU] Step ${i + 1}: legacy → ${fallbackResult.success ? 'SUCCESS' : 'FAILED'} (${fallbackResult.llmCalls} LLM calls, ${(legacyDuration / 1000).toFixed(1)}s)`);
          this.logger.logStep({
            layer: 3,
            actionType: 'vision_legacy',
            result: fallbackResult.success ? 'success' : 'fail',
            actionParams: { task: remainingTask.substring(0, 200), llmCalls: fallbackResult.llmCalls },
            durationMs: legacyDuration,
          });
          llmCallCount += fallbackResult.llmCalls;
          if (!fallbackResult.success) {
            console.log(`   ❌ Legacy fallback failed: "${subtask}"`);
          }
        }
        break;
      } else {
        steps.push({ action: 'skipped', description: `Skipped "${subtask}" — no API key or vision model configured`, success: false, timestamp: Date.now() });
      }
    }

    // Update workspace state after all subtasks
    try {
      const windows = await this.a11y.getWindows().catch(() => []);
      this.workspace.updateWindows(windows);
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      if (activeWin?.processId) this.workspace.setActiveWindow(activeWin.processId);
      const clip = await this.a11y.readClipboard().catch(() => '');
      if (clip) this.workspace.updateClipboard(clip, 'post-task');
    } catch { /* non-critical */ }

    // Determine success: either an explicit 'done' step from OCR/CU, or ALL router steps succeeded
    const hasDoneStep = steps.some(s => s.action === 'done' && s.success);
    const allRouterStepsSucceeded = steps.length > 0 && steps.every(s => s.success);
    const isSuccess = hasDoneStep || allRouterStepsSucceeded;
    // Distinguish verified vs unverified success
    const hasVerifiedDone = steps.some(s => s.action === 'done' && s.success && s.description?.includes('verified'));
    const hasNeedsHuman = steps.some(s => s.action === 'needs-human' || s.description?.includes('needs_human'));

    let finalStatus: CompletionStatus;
    if (hasNeedsHuman) finalStatus = 'needs_human';
    else if (hasVerifiedDone) finalStatus = 'verified_success';
    else if (hasDoneStep) finalStatus = 'unverified_success';
    else if (allRouterStepsSucceeded) finalStatus = 'unverified_success';
    else finalStatus = 'failed';

    const result: TaskResult = {
      success: isSuccess,
      steps,
      duration: Date.now() - startTime,
    };

    const statusIcon = finalStatus === 'verified_success' ? '✅' : finalStatus === 'unverified_success' ? '⚠️' : '❌';
    console.log(`\n${statusIcon} Task ${finalStatus.toUpperCase()} | ${(result.duration / 1000).toFixed(1)}s | ${steps.length} steps | ${llmCallCount} LLM calls`);
    console.log(`   Workspace: ${this.workspace.getSummary()}`);
    this.logger.endTask(finalStatus, { refinedTask: task });
    return result;

    } catch (err) {
      // Auth/billing errors: fail immediately with a clear, actionable message
      if (err instanceof LLMBillingError) {
        console.error(`\n❌ API credits exhausted — task cannot proceed. Top up your account or switch providers.`);
        this.logger.endTask('failed');
        return {
          success: false,
          steps: [...steps, { action: 'error', description: `API credits exhausted: ${err.message}`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        };
      }
      if (err instanceof LLMAuthError) {
        console.error(`\n❌ API authentication failed — check your API key.`);
        this.logger.endTask('failed');
        return {
          success: false,
          steps: [...steps, { action: 'error', description: `API auth failed: ${err.message}`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        };
      }
      console.error(`\n❌ Decompose+Route crashed:`, err);
      this.logger.endTask('failed');
      return {
        success: false,
        steps: [...steps, { action: 'error', description: `Pipeline crashed: ${err}`, success: false, timestamp: Date.now() }],
        duration: Date.now() - startTime,
      };
    } finally {
      await this.closeIsolatedDesktop();
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
          // retrying after parse error
          steps.push({ action: 'retry', description: `Retryable: ${decision.error.substring(0, 100)}`, success: false, timestamp: Date.now() });
          this.brain.resetConversation(); // clear bad history so next attempt starts fresh
          continue;
        }
        console.log(`   ❌ ${decision.error}`);
        steps.push({ action: 'error', description: decision.error, success: false, timestamp: Date.now() });
        return { success: false, llmCalls };
      }

      // Wait?
      if (decision.waitMs) {
        // waiting
        await this.delay(decision.waitMs);
        stepDescriptions.push(decision.description);
        continue;
      }

      // Handle SEQUENCE
      if (decision.sequence) {
        // executing sequence

        for (const seqStep of decision.sequence.steps) {
          if (this.aborted) break;

          const tier = this.safety.classify(seqStep, seqStep.description);
          // seq step

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
          console.log(`   ❌ Stuck: repeated "${actionKey}"`);
          steps.push({ action: 'stuck', description: `Stuck: repeated "${actionKey}"`, success: false, timestamp: Date.now() });
          return { success: false, llmCalls };
        }

        // Safety check
        const tier = this.safety.classify(decision.action, decision.description);
        // action classified

        if (this.safety.isBlocked(decision.description)) {
          console.log(`   ❌ BLOCKED: ${decision.description}`);
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
    this.logger.endTask('aborted');
    this.state = { status: 'idle', stepsCompleted: 0, stepsTotal: 0 };
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getSafety(): SafetyLayer {
    return this.safety;
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

  private async executeA11yAction(action: A11yAction): Promise<void> {
    const actionMap: Record<string, 'click' | 'set-value' | 'get-value' | 'focus'> = {
      'a11y_click': 'click',
      'a11y_set_value': 'set-value',
      'a11y_get_value': 'get-value',
      'a11y_focus': 'focus',
    };
    const a11yAction = actionMap[action.kind];
    if (!a11yAction) throw new Error(`Unknown a11y action: ${action.kind}`);

    const result = await this.a11y.invokeElement({
      name: action.name,
      automationId: action.automationId,
      controlType: action.controlType,
      action: a11yAction,
      value: action.value,
    });

    this.a11y.invalidateCache();

    if (!result.success && !result.clickPoint) {
      throw new Error(result.error || 'A11y action failed');
    }

    // Coordinate fallback: bridge couldn't invoke but gave us bounds
    if (result.clickPoint) {
      const mc = this.desktop.physicalToMouse(result.clickPoint.x, result.clickPoint.y);
      await this.desktop.mouseClick(mc.x, mc.y);
      this.a11y.invalidateCache();
    }
  }

  /**
   * Minimize ALL windows on the current desktop (called before desktop switch).
   * Uses Shell.Application COM object for a clean slate.
   */
  private async minimizeAllWindows(): Promise<void> {
    if (IS_MAC) return;
    try {
      await execFileAsync('powershell.exe', ['-Command',
        `$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()`
      ]);
      await new Promise(r => setTimeout(r, 400));
    } catch { /* non-fatal */ }
  }

  /**
   * Minimize all windows EXCEPT those matching processName (called after app opens
   * on the isolated desktop to hide anything that leaked through).
   */
  private async minimizeAllExcept(processName: string): Promise<void> {
    if (IS_MAC) return;
    try {
      await execFileAsync('powershell.exe', ['-Command',
        `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
}
"@
$target = "${processName}".ToLower()
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Name.ToLower() -notlike "*$target*" -and $_.Name.ToLower() -notlike "*clawdcursor*" -and $_.Name.ToLower() -notlike "*powershell*" }
foreach ($p in $procs) { [Win32]::ShowWindow($p.MainWindowHandle, 2) | Out-Null }`
      ]);
      await new Promise(r => setTimeout(r, 400));
    } catch { /* non-fatal */ }
  }

  /**
   * Create an isolated Windows virtual desktop so the agent works in a clean
   * environment away from the user's open windows.
   * 1. Minimize all windows first (so they don't follow to the new desktop)
   * 2. Win+Ctrl+D creates a new desktop and switches to it
   */
  private async createIsolatedDesktop(): Promise<void> {
    // Disabled: isolated virtual desktops hide the app that pre-processing just opened,
    // causing vision/screenshots to see an empty desktop and waste time re-opening apps.
    // The agent now works on the user's current desktop directly.
    return;
  }

  /**
   * Close the isolated virtual desktop — no-op since we no longer create one.
   */
  private async closeIsolatedDesktop(): Promise<void> {
    return;
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

