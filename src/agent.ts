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
import { execFile } from 'child_process';
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
import { A11yReasoner } from './a11y-reasoner';
import { BrowserLayer } from './browser-layer';
import { SmartInteractionLayer } from './smart-interaction';
import { loadPipelineConfig } from './doctor';
import { detectProvider, type PipelineConfig } from './providers';
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
    // Load pipeline config from doctor (if available)
    const pipelineConfig = loadPipelineConfig();

    if (pipelineConfig && pipelineConfig.layer2.enabled) {
      this.reasoner = new A11yReasoner(this.a11y, pipelineConfig);
      console.log(`🧠 Layer 2 (Accessibility Reasoner): ${pipelineConfig.layer2.model}`);
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
      console.log(`   To unlock AI fallback, configure your OpenClaw agent provider (or set AI_API_KEY in standalone mode) and run: clawdcursor doctor`);
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

  async connect(): Promise<void> {
    await this.desktop.connect();

    // Initialize Browser Layer (Layer 0) — Playwright for browser tasks
    const pipelineConfig = loadPipelineConfig();
    const textModel = this.config.ai.model || pipelineConfig?.layer2?.model || 'unavailable';
    const visionModel = this.config.ai.visionModel || pipelineConfig?.layer3?.model || 'unavailable';

    const textProvider = this.inferProviderLabel(
      this.config.ai.textApiKey || this.config.ai.apiKey,
      this.config.ai.textBaseUrl || this.config.ai.baseUrl || pipelineConfig?.layer2?.baseUrl,
      this.config.ai.provider,
    );
    const visionProvider = this.inferProviderLabel(
      this.config.ai.visionApiKey || this.config.ai.apiKey,
      this.config.ai.visionBaseUrl || this.config.ai.baseUrl || pipelineConfig?.layer3?.baseUrl,
      this.config.ai.provider,
    );

    console.log(`🤖 Active models: text=${textModel} (${textProvider}) | vision=${visionModel} (${visionProvider})`);

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
      // Open app/browser if LLM identified one
      if (preprocessed.app) {
        console.log(`\n🔀 Pre-processing: opening "${preprocessed.app}" first`);
        try {
          const openResult = await this.router.route(`open ${preprocessed.app}`);
          if (openResult.handled) {
            console.log(`   ✅ "${preprocessed.app}" opened via Action Router`);
            priorContext.push(`Opened "${preprocessed.app}" — it is now the active, focused window`);
            await new Promise(r => setTimeout(r, 2000));

            // Maximize the window
            try {
              await this.router.route('maximize window');
              await new Promise(r => setTimeout(r, 500));
              try {
                await execFileAsync('powershell.exe', ['-Command',
                  'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ESC}")'
                ]);
              } catch { /* non-critical */ }
              await new Promise(r => setTimeout(r, 300));
              priorContext.push('Window maximized to full screen');
            } catch { /* not critical */ }
          }
        } catch (err) {
          console.log(`   ⚠️ Pre-open failed: ${err} — proceeding with full task`);
        }
      }

      // Navigate to URL if identified — do it now via keyboard shortcut
      if (preprocessed.navigate) {
        // If no app specified but navigation requested, open default browser first
        if (!preprocessed.app) {
          const defaultBrowser = await this.getDefaultBrowser();
          console.log(`   🌐 Opening default browser (${defaultBrowser}) for navigation...`);
          try {
            const openResult = await this.router.route(`open ${defaultBrowser}`);
            if (openResult.handled) {
              console.log(`   ✅ "${defaultBrowser}" opened via Action Router`);
              priorContext.push(`Opened "${defaultBrowser}" — it is now the active, focused window`);
              await new Promise(r => setTimeout(r, 2000));

              // Maximize the window
              try {
                await this.router.route('maximize window');
                await new Promise(r => setTimeout(r, 500));
                try {
                  await execFileAsync('powershell.exe', ['-Command',
                    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ESC}")'
                  ]);
                } catch { /* non-critical */ }
                await new Promise(r => setTimeout(r, 300));
                priorContext.push('Window maximized to full screen');
              } catch { /* not critical */ }
            }
          } catch (err) {
            console.log(`   ⚠️ Default browser open failed: ${err} — proceeding with navigation attempt`);
          }
        }

        console.log(`   🌐 Navigating to ${preprocessed.navigate}...`);
        try {
          await this.desktop.keyPress('Control+l');
          await new Promise(r => setTimeout(r, 300));
          await this.desktop.typeText(preprocessed.navigate);
          await new Promise(r => setTimeout(r, 200));
          await this.desktop.keyPress('Return');
          await new Promise(r => setTimeout(r, 2000)); // wait for page load
          priorContext.push(`Navigated to ${preprocessed.navigate} — page is loading`);
          console.log(`   ✅ Navigated to ${preprocessed.navigate}`);
        } catch (err) {
          console.log(`   ⚠️ Navigation failed: ${err} — Computer Use will handle it`);
          priorContext.push(`Navigate to: ${preprocessed.navigate} (attempted but may need retry)`);
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
        return result;
      }
      // Browser layer couldn't handle it — fall through
      if (browserResult.handled === false) {
        console.log(`   🌐 Browser Layer: not handled — falling through to Action Router`);
      }
    }

    // ── Layer 1: Action Router + Shortcuts (regex + a11y, zero LLM calls) ──
    // ALWAYS runs — no isBrowserTask gate. Catches shortcuts even for browser-context tasks.
    // Pattern-matched tasks: refresh, go back, zoom, find, open app, shortcuts, etc.
    // Instant execution — no screenshots, no API calls.
    {
      this.state.status = 'acting';
      console.log(`\n⚡ Action Router: attempting "${task}"`);
      const routeResult = await this.router.route(task);
      const telemetry = this.router.getTelemetry();
      console.log(`   📊 Telemetry: ${JSON.stringify(telemetry)}`);
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
      return this.executeWithComputerUse(task, debugDir, startTime, priorContext);
    } else {
      return this.executeWithDecomposeAndRoute(task, debugDir, startTime);
    }
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

    // Skip pre-processing for very simple tasks (single action)
    const simplePatterns = /^(scroll|click|type|press|copy|paste|undo|redo|save|close|minimize|maximize)\b/i;
    if (simplePatterns.test(task)) return null;

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
- "search for cats on google, copy the first result link, then open email and paste it" → {"app": null, "navigate": "google.com", "task": "search for cats, copy the first result link, then open email application and paste the link", "contextHints": ["google", "email"]}
- "open amazon and find a book, then save the title to a text file" → {"app": null, "navigate": "amazon.com", "task": "find a book, copy or note the title, then open text editor and save the title to a file", "contextHints": ["amazon", "text file"]}
- "compare prices between amazon and ebay for laptops" → {"app": null, "navigate": "amazon.com", "task": "search for laptops and note prices, then open ebay in new tab and compare laptop prices", "contextHints": ["amazon", "ebay"]}
- "drag an image from browser to desktop" → {"app": null, "navigate": null, "task": "drag an image from browser window to desktop", "contextHints": ["browser", "desktop"]}`;

    try {
      console.log(`\n🧠 Pre-processing task with LLM...`);
      const startTime = Date.now();

      let response: string;

      if (this.smartInteraction?.isAvailable()) {
        // Use SmartInteraction's callTextModel (it handles all providers)
        response = await (this.smartInteraction as any).callTextModel(
          `Parse this command: "${task}"`,
          systemPrompt,
        );
      } else if (this.reasoner) {
        // Use reasoner's provider config via fetch
        const pipelineConfig = loadPipelineConfig();
        if (!pipelineConfig) return null;
        const { model, baseUrl } = pipelineConfig.layer2;
        const apiKey = pipelineConfig.apiKey || '';

        const fetchResponse = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Parse this command: "${task}"` },
            ],
            temperature: 0,
          }),
        });

        const data: any = await fetchResponse.json();
        response = data.choices?.[0]?.message?.content || '';
      } else {
        return null;
      }

      const elapsed = Date.now() - startTime;
      console.log(`   ⚡ Pre-processed in ${elapsed}ms`);

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
      console.log(`   ⚠️ Pre-processor failed: ${err} — proceeding with raw task`);
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
      const cuResult = await this.computerUse!.executeSubtask(task, debugDir, 0, priorContext);

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
          steps: [{ action: 'error', description: 'Task too complex for offline mode. Configure OpenClaw agent provider (or set AI_API_KEY in standalone mode) to unlock AI fallback.', success: false, timestamp: Date.now() }],
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
              // Layer 2 failed — hand remaining subtasks (including this one) to Computer Use
              if (this.computerUse) {
                const remainingTask = subtasks.slice(i).join(', then ');
                console.log(`   🖥️  Handing off to Computer Use: "${remainingTask}"`);
                const fallbackResult = await this.executeLLMFallback(remainingTask, steps, debugDir, i);
                llmCallCount += fallbackResult.llmCalls;
                i = subtasks.length; // skip remaining — Computer Use handled them
                break;
              }
            }
          } else {
            // Task done per reasoner
            steps.push({ action: 'done', description: reasonResult.description, success: true, timestamp: Date.now() });
            continue;
          }
        }
        // If unsure or failed, fall through to Layer 3
      }

      // Layer 3: LLM vision fallback — hand off ALL remaining subtasks, not just current one
      if (this.hasApiKey) {
        await this.delay(150);
        const remainingTask = subtasks.slice(i).join(', then ');
        console.log(`   🧠 LLM vision fallback for remaining: "${remainingTask}"`);
        const fallbackResult = await this.executeLLMFallback(remainingTask, steps, debugDir, i);
        llmCallCount += fallbackResult.llmCalls;
        if (!fallbackResult.success) {
          console.log(`   ❌ LLM fallback failed for: "${subtask}"`);
        }
        break; // Computer Use handled the rest
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

