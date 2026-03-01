/**
 * Computer Use API Adapter
 *
 * Uses Anthropic's native computer_20250124 tool spec instead of
 * custom prompt engineering. Claude natively understands how to
 * control a desktop — no JSON schema in prompts, no parse errors.
 *
 * The adapter handles:
 *  - Tool declaration with screen dimensions
 *  - Screenshot capture and submission as tool_results
 *  - Action execution via NativeDesktop
 *  - Coordinate scaling (LLM space ↔ real screen)
 *  - The full agent loop (screenshot → action → screenshot → ...)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';
import { SafetyLayer } from './safety';
import { normalizeKeyCombo } from './keys';
import type { ClawdConfig, StepResult } from './types';

const BETA_HEADER = 'computer-use-2025-01-24';
const MAX_ITERATIONS = 30;
const IS_MAC = os.platform() === 'darwin';

const SYSTEM_PROMPT_MAC = `You are Clawd Cursor, an AI desktop agent on macOS. Complete tasks fast and reliably.

macOS: menu bar TOP, Dock at bottom (or side), Spotlight with Cmd+Space, high-DPI Retina display.

ACCESSIBILITY: Each tool_result may include a WINDOWS list and focused window UI tree with element positions.
Use accessibility data to find exact element positions and verify state.

CRITICAL — BEFORE EVERY TASK:
- NEVER press any key to "show the desktop" or "minimize windows". That hides what you need.
- FIRST STEP: Take a screenshot to see what's currently on screen.
- The target app has already been moved to the PRIMARY screen (top-left area, ~120,80 position) and focused before this task started. It should be visible immediately in the screenshot.
- This is a MULTI-MONITOR setup. The screenshot only shows the PRIMARY screen. The target app has been moved there for you.
- If the app is not visible in the screenshot (unlikely), click its Dock icon to bring it to the primary screen.
- Only AFTER the right window is visible should you begin interacting with it.

CRITICAL — SPEED RULES:
1. BATCH ACTIONS. Return multiple computer tool calls in ONE response whenever possible.
2. CHECKPOINT STRATEGY: Take a screenshot after critical state changes. Then batch predictable actions.
3. MANDATORY screenshots: (a) at task start to orient yourself, (b) after opening any app/dialog, (c) before repetitive actions, (d) to verify final results.
4. NEVER batch a selection click with actions that depend on it — verify first.
5. WINDOW MANAGEMENT: Bring app to front by clicking it or its Dock icon. Use Cmd+grave to cycle windows of same app.
6. Prefer keyboard shortcuts: Cmd+C copy, Cmd+V paste, Cmd+W close, Cmd+Tab switch apps, Cmd+Space Spotlight.
7. For file dialogs: use absolute paths (/Users/...) never ~ or $HOME.
8. FOCUS HINTS: When you receive a "FOCUS:" hint, only analyze that area. Don't describe the whole screen.

PATTERNS:
- Open app: key "super+space" (Spotlight) + type app name + key "Return" — all in one response.
- Bring app forward: click on its visible window, OR click its Dock icon.
- Navigate URL in browser: key "super+l" + type URL + key "Return"
- Fill forms: tab between fields, type values — batch the whole form in one response.
- Submit/send in text input: ALWAYS follow type() with key("Return") in the SAME response. Never type without submitting.
- Codex / AI chat apps: click the input box → type your message → key "Return" to send. All three in one batched response.
- Switch apps: key "super+tab" to cycle, or click the Dock icon.
- Recovery: dialog → key "Escape", wrong window → click correct window, app frozen → key "super+q" + reopen.

SCROLLING: NEVER use mouse scroll with small amounts. For scrolling web pages use keyboard: PageDown (or fn+Down on Mac keyboards) for full page, Space for half page, or arrow keys. Mouse scroll is unreliable on modern infinite-scroll sites.
SITE SHORTCUTS: On Reddit use j/k to move between posts, a to upvote, z to downvote, c to open comments. On Twitter/X use j/k for posts, l to like. These are far faster than clicking.

SUBMITTING IS MANDATORY: After EVERY type() action into a chat or prompt input, you MUST immediately follow with key("Return") in the same response batch. Typing without submitting is an incomplete action. Never end a response after type() without also sending Return.

WAITING FOR AI APPS (Codex, Claude, ChatGPT, etc.):
After submitting a message to an AI chat app, the app takes time to generate a response. You MUST wait for it to finish before doing anything else. Here is the exact pattern:
1. Click input box → type message → key "Return" (all in one batch)
2. Take a screenshot to confirm submission happened
3. Wait — do NOT interact yet. Take another screenshot after 8-10 seconds.
4. Look for signs the AI is STILL generating: a stop/cancel button, a spinning indicator, the input box is disabled or shows a placeholder like "Generating...", or the response text is still growing.
5. If STILL generating: wait again (take screenshot, check again). Keep waiting.
6. Only when you see the AI has FINISHED — input box is active again, send button is available, no stop button, response text has stabilized — THEN read the response and send your next message.
7. NEVER type into the input box while the AI is still generating. This interrupts it.

Do NOT: press super+d or any "show desktop" shortcut, take screenshots after every single action, use Windows shortcuts (Win key, Alt+F4, etc), retry same failed coordinates, send a new message before the AI finishes responding.`;

const SYSTEM_PROMPT_WIN = `You are Clawd Cursor, an AI desktop agent on Windows 11. Complete tasks fast and reliably.

Win11: taskbar BOTTOM centered, system tray bottom-right, high-DPI.

ACCESSIBILITY: Each tool_result has WINDOWS list, FOCUSED WINDOW UI TREE (elements+coords), TASKBAR APPS.
Use accessibility data to find exact element positions and verify state.

CRITICAL — SPEED RULES:
1. BATCH ACTIONS. Return multiple computer tool calls in ONE response whenever possible. This is the #1 speed optimization.
2. CHECKPOINT STRATEGY: Take a screenshot after critical state changes. Then batch all predictable actions without screenshots.
3. MANDATORY screenshots: (a) after opening any app/dialog/page, (b) after selecting a tool/mode/tab in ANY app, (c) before starting repetitive actions (to confirm setup is correct), (d) to verify final results.
4. NEVER batch a tool/mode selection click together with the actions that depend on it. Always verify the tool is selected first.
5. WINDOW MANAGEMENT: For single-app tasks, maximize with "super+Up". For multi-app tasks (side by side, comparing, etc.), use "super+Left" and "super+Right" to snap windows to halves. On Windows 11, Win+Up may trigger Snap Assist layout picker. If you see a grid of window layout options, press Escape to dismiss it, then use Alt+Space followed by 'x' to maximize instead.
6. Prefer keyboard shortcuts over mouse clicks. Type instead of click when possible.
7. For save/open dialogs: use ABSOLUTE paths (C:\\Users\\...) never environment variables (%USERPROFILE%).
8. FOCUS HINTS: When you receive a "FOCUS:" hint, only analyze that area of the screenshot. Don't describe the entire screen.

PATTERNS:
- Open app: key "super" + type name + key "Return" + wait 2s — all in one response. Then maximize ("super+Up").
- Navigate URL: key "ctrl+l" + type full URL + key "Return" — all in one response
- Fill forms: tab between fields + type values — batch the entire form in one response
- Save file: key "ctrl+s", wait 1s, type absolute path, key "Return" — all in one response
- Recovery: popup → Escape, wrong page → ctrl+l + correct URL, app frozen → alt+F4 + reopen
- Draw in Paint/canvas: Select brush tool first (click it in toolbar). Use drag operations for lines. A stick figure needs: circle/square for head (~60px), vertical line for body (~150px), diagonal lines for arms and legs (~80px each). Use LARGE coordinates — small drags produce dots. Minimum drag distance: 50 pixels.

SCROLLING: NEVER use mouse scroll with small amounts. For scrolling web pages use keyboard: PageDown (full page), Space (half page), or arrow keys. Mouse scroll is unreliable on modern infinite-scroll sites.
SITE SHORTCUTS: On Reddit use j/k to move between posts, a to upvote, z to downvote, c to open comments. On Twitter/X use j/k for posts, l to like. These are far faster than clicking.

Do NOT: take screenshots after every action, go one action at a time when you can batch, use search engines for known URLs, retry same failed coords.`;

const SYSTEM_PROMPT = IS_MAC ? SYSTEM_PROMPT_MAC : SYSTEM_PROMPT_WIN;

// Checkpoint system for task completion detection
const CHECKPOINT_TEMPLATES: Record<string, string[]> = {
  email: ['compose_opened', 'recipient_filled', 'subject_filled', 'body_filled', 'send_pressed', 'compose_closed'],
  form: ['form_visible', 'fields_filled', 'submit_pressed'],
  navigate: ['url_entered', 'page_loaded'],
  draw: ['tool_selected', 'drawing_started', 'drawing_complete'],
  file_save: ['save_triggered', 'path_entered', 'save_confirmed'],
  app_interaction: ['app_focused', 'action_performed', 'result_visible'],
};

function detectTaskType(task: string): string {
  const lower = task.toLowerCase();
  if (/\b(email|compose|send.*to|mail)\b/.test(lower)) return 'email';
  if (/\b(fill|form|register|sign.?up)\b/.test(lower)) return 'form';
  if (/\b(go to|navigate|open.*url|visit)\b/.test(lower)) return 'navigate';
  if (/\b(draw|paint|sketch)\b/.test(lower)) return 'draw';
  if (/\b(save|download)\b/.test(lower)) return 'file_save';
  return 'app_interaction'; // generic fallback
}

function updateCheckpoints(tracker: CheckpointTracker, action: string, description: string, claudeText: string): void {
  const lower = (description + ' ' + claudeText).toLowerCase();
  
  for (const cp of tracker.checkpoints) {
    if (cp.detected) continue;
    
    switch (cp.name) {
      case 'compose_opened':
        if (lower.includes('compose') && (lower.includes('open') || lower.includes('new message'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'recipient_filled':
        if ((action === 'type' && lower.includes('@')) || lower.includes('recipient') || lower.includes('to field') || lower.includes('to:')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'subject_filled':
        if (lower.includes('subject')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'body_filled':
        if (lower.includes('body') || (action === 'type' && tracker.checkpoints.find(c => c.name === 'subject_filled')?.detected)) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'send_pressed':
        if (action === 'key' && (lower.includes('return') || lower.includes('enter')) && lower.includes('ctrl')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        if (action === 'left_click' && (lower.includes('send') || lower.includes('submit'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'compose_closed':
        if (lower.includes('compose') && (lower.includes('closed') || lower.includes('disappeared'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        if (lower.includes('sent successfully') || lower.includes('email.*sent') || lower.includes('message sent')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'tool_selected':
        if (action === 'left_click' && (lower.includes('brush') || lower.includes('pencil') || lower.includes('tool'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'drawing_started':
        if (action === 'left_click_drag') {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'drawing_complete':
        // Multiple drags completed and Claude says done
        if (lower.includes('stick figure') && (lower.includes('complete') || lower.includes('success') || lower.includes('done') || lower.includes('finished'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'form_visible':
        if (lower.includes('form') || lower.includes('field')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'fields_filled':
        if (action === 'type' || (lower.includes('fill') && lower.includes('complete'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'submit_pressed':
        if (lower.includes('submit') || lower.includes('send') || (action === 'key' && lower.includes('return'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'url_entered':
        if (action === 'type' && (lower.includes('http') || lower.includes('www') || lower.includes('.com'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'page_loaded':
        if (lower.includes('page loaded') || lower.includes('navigated to') || lower.includes('website') && lower.includes('visible')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'save_triggered':
        if (action === 'key' && (lower.includes('ctrl+s') || lower.includes('save'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'path_entered':
        if (action === 'type' && (lower.includes('\\') || lower.includes('/') || lower.includes('.'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'save_confirmed':
        if (action === 'key' && lower.includes('return') && tracker.checkpoints.find(c => c.name === 'path_entered')?.detected) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'app_focused':
        if (action === 'left_click' || action === 'key' && lower.includes('super')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'action_performed':
        if (action !== 'screenshot' && action !== 'wait') {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'result_visible':
        if (lower.includes('success') || lower.includes('complete') || lower.includes('done') || lower.includes('finished')) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      // Add more as needed
    }
  }
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    action: string;
    coordinate?: [number, number];
    start_coordinate?: [number, number];
    text?: string;
    duration?: number;
    scroll_direction?: 'up' | 'down' | 'left' | 'right';
    scroll_amount?: number;
    key?: string;
  };
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

interface TaskCheckpoint {
  name: string;
  detected: boolean;
  timestamp?: number;
}

interface CheckpointTracker {
  taskType: string;
  checkpoints: TaskCheckpoint[];
  isComplete(): boolean;
  update(action: string, description: string, claudeText: string): void;
}

export interface ComputerUseResult {
  success: boolean;
  steps: StepResult[];
  llmCalls: number;
}

/** How long to reuse a cached a11y context before re-fetching (ms) */
const A11Y_CACHE_TTL = 30_000;

export class ComputerUseBrain {
  private config: ClawdConfig;
  private desktop: NativeDesktop;
  private a11y: AccessibilityBridge;
  private safety: SafetyLayer;
  private screenWidth: number;
  private screenHeight: number;
  private llmWidth: number;
  private llmHeight: number;
  private scaleFactor: number;
  private heldKeys: string[] = [];
  private lastMouseX = 0;
  private lastMouseY = 0;

  // A11y context cache — avoids hammering JXA after every single action
  private a11yCache: { context: string; ts: number; pid?: number } | null = null;

  constructor(config: ClawdConfig, desktop: NativeDesktop, a11y: AccessibilityBridge, safety: SafetyLayer) {
    this.config = config;
    this.desktop = desktop;
    this.a11y = a11y;
    this.safety = safety;

    const screen = desktop.getScreenSize();
    this.screenWidth = screen.width;
    this.screenHeight = screen.height;

    // Scale factor MUST match NativeDesktop.captureForLLM() — use floating point, not ceil
    const LLM_WIDTH = 1280; // Must match native-desktop.ts LLM_TARGET_WIDTH
    this.scaleFactor = screen.width > LLM_WIDTH ? screen.width / LLM_WIDTH : 1;
    this.llmWidth = Math.min(screen.width, LLM_WIDTH);
    this.llmHeight = Math.round(screen.height / this.scaleFactor);

    console.log(`   🖥️  Computer Use: declaring ${this.llmWidth}x${this.llmHeight} display (scale ${this.scaleFactor}x from ${this.screenWidth}x${this.screenHeight})`);
  }

  /**
   * Check if the current provider supports native Computer Use.
   */
  static isSupported(config: ClawdConfig): boolean {
    return config.ai.provider === 'anthropic' && !!config.ai.apiKey;
  }

  /**
   * Execute a subtask using the Computer Use tool loop.
   * Claude autonomously takes screenshots, decides actions, and executes them.
   */
  async executeSubtask(
    subtask: string,
    debugDir: string | null,
    subtaskIndex: number,
    priorSteps?: string[],
  ): Promise<ComputerUseResult> {
    const steps: StepResult[] = [];
    let llmCalls = 0;
    const messages: any[] = [];

    // Visual loop tasks (screenshot→act→repeat) don't benefit from a11y UI tree —
    // they're purely vision-driven. Skip all a11y fetches to cut 3-10s per iteration.
    const skipA11yCompletely = this.isVisualLoopSubtask(subtask);

    console.log(`   🖥️  Computer Use: "${subtask}"`);

    // Initialize checkpoint tracker
    const taskType = detectTaskType(subtask);
    const checkpointNames = CHECKPOINT_TEMPLATES[taskType] || CHECKPOINT_TEMPLATES['app_interaction'];
    const tracker: CheckpointTracker = {
      taskType,
      checkpoints: checkpointNames.map(name => ({ name, detected: false })),
      isComplete() {
        return this.checkpoints.every(cp => cp.detected);
      },
      update(action: string, description: string, claudeText: string) {
        updateCheckpoints(this, action, description, claudeText);
      },
    };
    console.log(`   📋 Task type: ${taskType} — tracking ${checkpointNames.length} checkpoints`);

    // Build context from prior completed steps so Claude doesn't redo work
    let taskMessage = subtask;
    if (priorSteps && priorSteps.length > 0) {
      taskMessage = `CONTEXT — These steps were already completed for you:\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nThe app is ALREADY OPEN and FOCUSED. Do NOT reopen it. Do NOT maximize it. Start working immediately.\n\nYOUR TASK: ${subtask}`;
    }

    // Initial user message with the subtask
    messages.push({
      role: 'user',
      content: taskMessage,
    });

    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;
    let lastActionSignature = '';
    let repeatedActionStreak = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      llmCalls++;
      console.log(`   📡 Computer Use call ${i + 1}...`);

      const response = await this.callAPI(messages);

      if (response.error) {
        console.log(`   ❌ API error: ${response.error}`);
        steps.push({
          action: 'error',
          description: `Computer Use API error: ${response.error}`,
          success: false,
          timestamp: Date.now(),
        });
        return { success: false, steps, llmCalls };
      }

      // Add assistant response to conversation
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Log any text blocks
      for (const block of response.content) {
        if ((block as TextBlock).type === 'text') {
          const text = (block as TextBlock).text;
          if (text.trim()) {
            console.log(`   💬 Claude: ${text.substring(0, 120)}${text.length > 120 ? '...' : ''}`);
          }
        }
      }

      // If end_turn → Claude thinks it's done. Check checkpoints first.
      if (response.stop_reason === 'end_turn') {
        const completedCount = tracker.checkpoints.filter(c => c.detected).length;
        const totalCount = tracker.checkpoints.length;
        const completionRatio = completedCount / totalCount;
        
        // If Claude says done + ≥90% checkpoints met, trust it and stop
        if (completionRatio >= 0.90) {
          console.log(`   ✅ Claude says done + ${Math.round(completionRatio * 100)}% checkpoints met — accepting completion`);
          steps.push({
            action: 'done',
            description: `Computer Use completed: "${subtask}" (${completedCount}/${totalCount} checkpoints)`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }
        
        // Skip verification for visual/loop tasks — trust Claude's judgment,
        // avoid the extra screenshot + API call overhead
        const skipVerify = skipA11yCompletely || /\b(draw|paint|sketch|doodle|color|design)\b/i.test(subtask);

        if (skipVerify) {
          console.log(`   ✅ Computer Use: subtask complete (skipping verification)`);
          steps.push({
            action: 'done',
            description: `Computer Use completed: "${subtask}"`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }

        // Only verify when completion is uncertain
        const completedRatio = tracker.checkpoints.filter(c => c.detected).length / tracker.checkpoints.length;
        if (completedRatio < 0.80) {
          // For non-visual tasks: take a verification screenshot and ask Claude to confirm
          console.log(`   🔍 Verifying outcome...`);
          llmCalls++;

        const [verifyScreenshot, a11yContext] = await Promise.all([
          this.desktop.captureForLLM(),
          this.getA11yContext(true, false),
        ]);
        if (debugDir) this.saveDebugScreenshot(verifyScreenshot.buffer, debugDir, subtaskIndex, i, 'verify');

        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `VERIFICATION CHECK: You said the task "${subtask}" is done. Look at this screenshot and the accessibility tree carefully. Is the task ACTUALLY completed? Check for:\n- File actually saved/created (title bar changed? dialog closed?)\n- Correct content visible on screen\n- No error dialogs or unexpected state\n\nRespond with ONLY one of:\n{"verified": true, "evidence": "what you see that confirms success"}\n{"verified": false, "evidence": "what's wrong", "recovery": "what to do next"}` },
            { type: 'image', source: { type: 'base64', media_type: verifyScreenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: verifyScreenshot.buffer.toString('base64') } },
            ...(a11yContext ? [{ type: 'text', text: a11yContext }] : []),
          ],
        });

        const verifyResponse = await this.callAPI(messages);
        
        if (verifyResponse.error) {
          // If verification call fails, trust the original result
          console.log(`   ⚠️ Verification call failed, trusting original result`);
          steps.push({
            action: 'done',
            description: `Computer Use completed: "${subtask}" (unverified)`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }

        // Parse verification response
        const verifyText = verifyResponse.content
          .filter((b: ContentBlock) => (b as TextBlock).type === 'text')
          .map((b: ContentBlock) => (b as TextBlock).text)
          .join('');
        
        console.log(`   🔍 Verification: ${verifyText.substring(0, 120)}${verifyText.length > 120 ? '...' : ''}`);

        // Check if verified
        const verifiedMatch = verifyText.match(/"verified"\s*:\s*(true|false)/);
        const isVerified = verifiedMatch ? verifiedMatch[1] === 'true' : !verifyText.toLowerCase().includes('"verified": false');

        if (isVerified) {
          console.log(`   ✅ Computer Use: subtask VERIFIED complete`);
          steps.push({
            action: 'done',
            description: `Computer Use completed (verified): "${subtask}"`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }

        // Not verified — Claude should continue with recovery
        console.log(`   ❌ Verification FAILED — continuing with recovery`);
        messages.push({
          role: 'assistant',
          content: verifyResponse.content,
        });
        
        // Push Claude to take corrective action
        messages.push({
          role: 'user',
          content: 'The task is NOT complete. Use the recovery steps you identified to fix it. Continue working.',
        });
        
        // Continue the loop — Claude will take corrective action
        continue;
        } else {
          console.log(`   ✅ Skipping verification — ${Math.round(completedRatio * 100)}% checkpoints already confirmed`);
          steps.push({
            action: 'done',
            description: `Computer Use completed (checkpoints): "${subtask}"`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }
      }

      // If max_tokens → ran out of space
      if (response.stop_reason === 'max_tokens') {
        console.log(`   ⚠️ Max tokens reached`);
        steps.push({
          action: 'error',
          description: 'Max tokens reached during Computer Use',
          success: false,
          timestamp: Date.now(),
        });
        return { success: false, steps, llmCalls };
      }

      // Process tool_use blocks
      // OPTIMIZATION: When multiple tool_use blocks arrive in one response,
      // only send full screenshot+a11y for the LAST one. Earlier actions get
      // a lightweight "ok" result to save ~7s per skipped screenshot.
      const toolResults: any[] = [];
      const toolUseBlocks = response.content.filter((b: ContentBlock) => (b as ToolUseBlock).type === 'tool_use') as ToolUseBlock[];

      for (let ti = 0; ti < toolUseBlocks.length; ti++) {
        const toolUse = toolUseBlocks[ti];
        const { action } = toolUse.input;
        const isLastInBatch = ti === toolUseBlocks.length - 1;

        if (action === 'screenshot') {
          // Always provide screenshot for explicit screenshot requests
          console.log(`   📸 Screenshot requested`);
          // Run screenshot + a11y in parallel when a11y is needed
          const [screenshot, a11yContext] = await Promise.all([
            this.desktop.captureForLLM(),
            this.getA11yContext(false, skipA11yCompletely),
          ]);
          if (debugDir) this.saveDebugScreenshot(screenshot.buffer, debugDir, subtaskIndex, i, 'screenshot');

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: [
              this.screenshotToContent(screenshot),
              { type: 'text', text: a11yContext },
            ],
          });

          steps.push({
            action: 'screenshot',
            description: 'Captured screenshot + accessibility context',
            success: true,
            timestamp: Date.now(),
          });
        } else {
          // Execute the action
          const result = await this.executeAction(toolUse);
          // Release any held modifier keys after non-hold actions
          if (toolUse.input.action !== 'hold_key' && this.heldKeys.length > 0) {
            for (const hk of this.heldKeys) {
              await this.desktop.keyUp(hk);
            }
            this.heldKeys = [];
          }
          console.log(`   ${result.error ? '❌' : '✅'} ${result.description}`);

          steps.push({
            action: action,
            description: result.description,
            success: !result.error,
            error: result.error,
            timestamp: Date.now(),
          });

          // Track consecutive errors for bail-out
          if (result.error) {
            consecutiveErrors++;
            lastActionSignature = '';
            repeatedActionStreak = 0;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log(`   ❌ ${MAX_CONSECUTIVE_ERRORS} consecutive errors — aborting task`);
              return { success: false, steps, llmCalls };
            }
          } else {
            consecutiveErrors = 0;
            const signature = this.actionSignature(toolUse);
            if (signature && signature === lastActionSignature) {
              repeatedActionStreak++;
            } else {
              lastActionSignature = signature;
              repeatedActionStreak = signature ? 1 : 0;
            }
          }

          const loopDetected = !result.error && repeatedActionStreak >= 4;

          if (result.error || loopDetected) {
            // Always send full context on error or loop detection so Claude can recover
            const [screenshot, a11yContext] = await Promise.all([
              this.desktop.captureForLLM(),
              this.getA11yContext(true, skipA11yCompletely),
            ]);
            if (debugDir) this.saveDebugScreenshot(screenshot.buffer, debugDir, subtaskIndex, i, action);
            const loopHint = loopDetected
              ? `Loop guard: repeated the same action ${repeatedActionStreak} times (${lastActionSignature}). STOP repeating. Use a different strategy (refocus target app/tab, navigate back/home, or choose a different element).`
              : '';
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [
                { type: 'text', text: result.error ? `Error: ${result.error}` : loopHint },
                this.screenshotToContent(screenshot),
                { type: 'text', text: a11yContext },
              ],
            });
            if (loopDetected) {
              console.log(`   ♻️  Loop guard: repeated action detected — forcing recovery context`);
              repeatedActionStreak = 0;
              lastActionSignature = '';
            }
          } else if (isLastInBatch) {
            // Last action in batch: full screenshot + optional a11y
            const isNavigation = action === 'key' && toolUse.input.text?.toLowerCase().includes('return');
            const isAppLaunch = action === 'key' && toolUse.input.text?.toLowerCase().includes('super');
            const isTyping = action === 'type';
            const isDrag = action === 'drag' || action === 'left_click_drag';
            const delayMs = isAppLaunch ? 600 : isNavigation ? 300 : isTyping ? 30 : isDrag ? 30 : 80;
            await this.delay(delayMs);

            // Skip a11y after simple clicks/types, and always when in visual-loop mode.
            // Run screenshot + a11y in parallel when a11y is needed.
            const skipA11y = skipA11yCompletely || isTyping || (action === 'left_click' && !isNavigation);
            const [screenshot, a11yContext] = await Promise.all([
              this.desktop.captureForLLM(),
              this.getA11yContext(isAppLaunch, skipA11y),
            ]);
            if (debugDir) this.saveDebugScreenshot(screenshot.buffer, debugDir, subtaskIndex, i, action);
            const verifyHint = this.getVerificationHint(action, toolUse.input);
            const focusHint = this.getFocusHint(action, toolUse.input);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [
                this.screenshotToContent(screenshot),
                { type: 'text', text: `${focusHint}${verifyHint}${a11yContext}` },
              ],
            });
          } else {
            // Not last in batch: lightweight response, skip screenshot
            const isAppLaunch = action === 'key' && toolUse.input.text?.toLowerCase().includes('super');
            const isDrag = action === 'drag';
            const isClick = action.includes('click');
            // Minimal delays for batched actions — UI is predictable
            const delayMs = isAppLaunch ? 600 : isDrag ? 20 : isClick ? 30 : 80;
            await this.delay(delayMs);

            console.log(`   ⏭️  Skipping screenshot (batch ${ti+1}/${toolUseBlocks.length})`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [{ type: 'text', text: `OK — action executed successfully.` }],
            });
          }
        }
      }

      // Update checkpoints with actions from this iteration
      const claudeText = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ');

      // Update checkpoints for each action executed in this iteration
      for (let ti = 0; ti < toolUseBlocks.length; ti++) {
        const toolUse = toolUseBlocks[ti];
        const { action } = toolUse.input;
        if (action !== 'screenshot') {
          const stepDesc = steps[steps.length - toolUseBlocks.length + ti]?.description || '';
          tracker.update(action, stepDesc, claudeText);
        }
      }

      // Check for checkpoint-based completion
      if (tracker.isComplete()) {
        console.log(`   ✅ All checkpoints met — task complete`);
        console.log(`   📋 Checkpoints: ${tracker.checkpoints.map(c => `${c.detected ? '✅' : '❌'} ${c.name}`).join(', ')}`);
        steps.push({
          action: 'done',
          description: `All checkpoints complete for ${taskType} task: "${subtask}"`,
          success: true,
          timestamp: Date.now(),
        });
        return { success: true, steps, llmCalls };
      }

      // Send tool results back
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    console.log(`   ⚠️ Max iterations (${MAX_ITERATIONS}) reached`);
    return { success: false, steps, llmCalls };
  }

  // ─── API Call ───────────────────────────────────────────────────

  private async callAPI(messages: any[]): Promise<any> {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.ai.apiKey!,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA_HEADER,
          },
          body: JSON.stringify({
            model: this.config.ai.visionModel,
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            tools: [{
              type: 'computer_20250124',
              name: 'computer',
              display_width_px: this.llmWidth,
              display_height_px: this.llmHeight,
              display_number: 1,
            }],
            messages,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const data = await response.json() as any;

        if (data.error) {
          const msg = data.error.message || JSON.stringify(data.error);
          console.warn(`   ⚠️ API error (attempt ${attempt + 1}): ${msg}`);
          if (attempt < MAX_RETRIES && response.status >= 500) {
            await this.delay(1000 * (attempt + 1));
            continue;
          }
          return { content: [], stop_reason: 'end_turn', error: msg };
        }

        return data;
      } catch (err) {
        clearTimeout(timeout);
        console.warn(`   ⚠️ API call failed (attempt ${attempt + 1}): ${err}`);
        if (attempt < MAX_RETRIES) {
          await this.delay(1000 * (attempt + 1));
          continue;
        }
        return { content: [], stop_reason: 'end_turn', error: String(err) };
      }
    }

    return { content: [], stop_reason: 'end_turn', error: 'Max retries exceeded' };
  }

  // ─── Action Execution ──────────────────────────────────────────

  private async executeAction(toolUse: ToolUseBlock): Promise<{ description: string; error?: string }> {
    const { action, coordinate, start_coordinate, text, key } = toolUse.input;

    // Safety check — block actions matching blockedPatterns
    const actionDesc = text || key || action;
    if (this.safety.isBlocked(actionDesc)) {
      return { description: `BLOCKED: ${actionDesc}`, error: `Action blocked by safety layer: ${actionDesc}` };
    }

    // Null guard for actions that require coordinates
    const needsCoords = ['left_click', 'right_click', 'double_click', 'triple_click',
      'middle_click', 'mouse_move', 'left_mouse_down', 'left_mouse_up'];
    if (needsCoords.includes(action) && !coordinate) {
      return { description: `${action}: missing coordinate`, error: 'coordinate is required for this action' };
    }

    try {
      switch (action) {
        case 'left_click': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseClick(x, y);
          this.lastMouseX = x; this.lastMouseY = y;
          return { description: `Click at (${x}, ${y})` };
        }

        case 'right_click': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseRightClick(x, y);
          return { description: `Right click at (${x}, ${y})` };
        }

        case 'double_click': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseDoubleClick(x, y);
          return { description: `Double click at (${x}, ${y})` };
        }

        case 'triple_click': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseClick(x, y);
          await this.delay(50);
          await this.desktop.mouseClick(x, y);
          await this.delay(50);
          await this.desktop.mouseClick(x, y);
          return { description: `Triple click at (${x}, ${y})` };
        }

        case 'middle_click': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseDown(x, y, 2); // button 2 = middle
          await this.delay(50);
          await this.desktop.mouseUp(x, y, 2);
          return { description: `Middle click at (${x}, ${y})` };
        }

        case 'mouse_move': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseMove(x, y);
          return { description: `Mouse move to (${x}, ${y})` };
        }

        case 'left_click_drag': {
          if (!start_coordinate || !coordinate) {
            return { description: 'Drag: missing coordinates', error: 'start_coordinate and coordinate are both required for drag' };
          }
          const [sx, sy] = this.scale(start_coordinate);
          const [ex, ey] = this.scale(coordinate);
          await this.desktop.mouseDrag(sx, sy, ex, ey);
          return { description: `Drag (${sx},${sy}) → (${ex},${ey})` };
        }

        case 'left_mouse_down': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseDown(x, y);
          return { description: `Mouse down at (${x}, ${y})` };
        }

        case 'left_mouse_up': {
          const [x, y] = this.scale(coordinate!);
          await this.desktop.mouseUp(x, y);
          return { description: `Mouse up at (${x}, ${y})` };
        }

        case 'type': {
          if (!text) return { description: 'Type: empty text', error: 'No text provided' };
          await this.desktop.typeText(text);
          return { description: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
        }

        case 'key': {
          if (!text) return { description: 'Key press: empty', error: 'No key provided' };
          // Map Anthropic key names to nut-js key names
          const mappedKey = this.mapKeyName(text);
          await this.desktop.keyPress(mappedKey);
          return { description: `Key press: ${text}` };
        }

        case 'hold_key': {
          // Hold a modifier key down — released after next non-hold action
          const holdKey = key || text || '';
          const mappedKey = this.mapKeyName(holdKey);
          await this.desktop.keyDown(mappedKey);
          this.heldKeys.push(mappedKey);
          return { description: `Holding key: ${holdKey}` };
        }

        case 'cursor_position': {
          return { description: `Cursor at (${this.lastMouseX}, ${this.lastMouseY})` };
        }

        case 'scroll': {
          const [x, y] = coordinate
            ? this.scale(coordinate)
            : [Math.round(this.screenWidth / 2), Math.round(this.screenHeight / 2)];
          const dir = toolUse.input.scroll_direction || 'down';
          const amount = toolUse.input.scroll_amount || 15;
          const delta = (dir === 'up' || dir === 'left') ? -amount : amount;
          await this.desktop.mouseScroll(x, y, delta);
          return { description: `Scroll ${dir} by ${amount} at (${x}, ${y})` };
        }

        case 'wait': {
          const duration = toolUse.input.duration || 2;
          console.log(`   ⏳ Waiting ${duration}s...`);
          await this.delay(duration * 1000);
          return { description: `Waited ${duration}s` };
        }

        default:
          return { description: `Unknown action: ${action}`, error: `Unsupported action: ${action}` };
      }
    } catch (err) {
      return { description: `${action} failed: ${err}`, error: String(err) };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /** Get accessibility context — windows, elements, focused app */
  /**
   * Detect tasks that are purely visual (screenshot→act loops).
   * For these, the full a11y UI tree adds no value and only slows things down.
   */
  private isVisualLoopSubtask(task: string): boolean {
    const t = task.toLowerCase();
    const hasLoop = /\b(loop|repeat|keep|every time|until (done|complete|nothing left|finished))\b/.test(t);
    const hasScreenshot = /\b(screenshot|take a screenshot)\b/.test(t);
    const hasWaitRespond = /\b(wait for.*(respond|response)|monitor progress)\b/.test(t);
    return (hasLoop && hasScreenshot) || (hasLoop && hasWaitRespond);
  }


  /** Build a compact signature used to detect repeated no-progress action loops. */
  private actionSignature(toolUse: ToolUseBlock): string {
    const { action, coordinate, text, key, scroll_direction, scroll_amount } = toolUse.input;

    // Focus on actions that commonly loop when the model gets stuck.
    const loopProne = new Set(['left_click', 'right_click', 'double_click', 'scroll', 'key', 'mouse_move']);
    if (!loopProne.has(action)) return '';

    const coordPart = coordinate ? `${coordinate[0]},${coordinate[1]}` : '';
    const textPart = (text || key || '').toLowerCase().trim().slice(0, 40);
    const scrollPart = action === 'scroll' ? `${scroll_direction || 'down'}:${scroll_amount || 3}` : '';
    return `${action}|${coordPart}|${textPart}|${scrollPart}`;
  }

  /**
   * Fetch accessibility context, with caching.
   *
   * @param force  Skip cache and always re-fetch (e.g. after app switch).
   * @param skip   Return empty string immediately — used for high-frequency
   *               action results where a11y overhead isn't worth it.
   */
  private async getA11yContext(force = false, skip = false): Promise<string> {
    if (skip) return '';

    try {
      // Fast path: return cached context if it's still fresh and same process
      const activeWindow = await this.a11y.getActiveWindow();
      const pid = activeWindow?.processId;

      if (
        !force &&
        this.a11yCache &&
        Date.now() - this.a11yCache.ts < A11Y_CACHE_TTL &&
        this.a11yCache.pid === pid
      ) {
        return this.a11yCache.context;
      }

      const context = await this.a11y.getScreenContext(pid);

      let header = '';
      if (activeWindow) {
        header = `FOCUSED: [${activeWindow.processName}] "${activeWindow.title}" (pid:${activeWindow.processId})\n`;
        const browserProcesses = ['chrome', 'msedge', 'firefox', 'brave', 'opera'];
        if (browserProcesses.some(b => activeWindow.processName.toLowerCase().includes(b))) {
          header += `BROWSER DETECTED — use ctrl+l to navigate, ctrl+t for new tab\n`;
        }
      }

      const result = `\nACCESSIBILITY:\n${header}${context}`;
      this.a11yCache = { context: result, ts: Date.now(), pid };
      return result;
    } catch {
      return '\nACCESSIBILITY: (unavailable)';
    }
  }

  /** Generate a verification hint based on what action was just performed */
  private getVerificationHint(action: string, input: ToolUseBlock['input']): string {
    if (action === 'key' && input.text) {
      const key = input.text.toLowerCase();
      if (key === 'return' || key === 'enter') {
        return 'VERIFY: Did the expected action happen? Check if a page loaded, app opened, or form submitted.\n';
      }
      if (key.includes('super')) {
        return 'VERIFY: Did the Start menu or search open? Look for the search box in the accessibility tree.\n';
      }
      if (key === 'ctrl+l') {
        return 'VERIFY: Is the browser address bar now focused? You should see a text field selected.\n';
      }
      if (key === 'escape') {
        return 'VERIFY: Did the popup/dialog close? Check if it\'s still in the accessibility tree.\n';
      }
    }
    if (action === 'left_click') {
      return 'VERIFY: Did the click hit the intended target? Check the focused element in accessibility.\n';
    }
    if (action === 'type') {
      return 'VERIFY: Was the text entered in the right field? Check the focused element.\n';
    }
    return '';
  }

  /**
   * Generate a FOCUS hint telling Claude where to look in the screenshot.
   * Reduces output tokens by directing attention to the relevant area.
   */
  private getFocusHint(action: string, input: ToolUseBlock['input']): string {
    if (action.includes('click') && input.coordinate) {
      const [x, y] = input.coordinate; // LLM coordinates
      // Describe region in human terms based on position
      const xZone = x < this.llmWidth * 0.33 ? 'left' : x > this.llmWidth * 0.66 ? 'right' : 'center';
      const yZone = y < this.llmHeight * 0.25 ? 'top' : y > this.llmHeight * 0.75 ? 'bottom' : 'middle';
      return `FOCUS: Look at the ${yZone}-${xZone} area around (${x},${y}) to verify your click landed correctly. Don't analyze the entire screenshot — just check the target area.\n`;
    }
    if (action === 'left_click_drag' && input.coordinate && input.start_coordinate) {
      return `FOCUS: Look at the canvas/drawing area to verify the drag drew correctly. Don't re-analyze toolbars unless something went wrong.\n`;
    }
    if (action === 'type') {
      return `FOCUS: Look at the text input field to verify your text was entered correctly. Don't analyze unrelated areas.\n`;
    }
    if (action === 'key') {
      const key = input.text?.toLowerCase() || '';
      if (key.includes('super')) return `FOCUS: Look for the Start menu or search box that should have appeared.\n`;
      if (key.includes('tab')) return `FOCUS: Check the window title bar to see which window is now focused.\n`;
      if (key === 'return' || key === 'enter') return `FOCUS: Check if the expected result happened (app opened, dialog closed, form submitted).\n`;
      if (key.includes('ctrl+s')) return `FOCUS: Look for a Save dialog that should have appeared.\n`;
    }
    return '';
  }

  /** Scale LLM coordinates to real screen coordinates */
  private scale(coords: [number, number]): [number, number] {
    return [
      Math.min(Math.round(Math.min(Math.max(coords[0], 0), this.llmWidth - 1) * this.scaleFactor), this.screenWidth - 1),
      Math.min(Math.round(Math.min(Math.max(coords[1], 0), this.llmHeight - 1) * this.scaleFactor), this.screenHeight - 1),
    ];
  }

  /** Map Anthropic key names to nut-js key names */
  private mapKeyName(key: string): string {
    return normalizeKeyCombo(key);
  }

  /** Convert a screenshot to Anthropic image content block */
  private screenshotToContent(screenshot: { buffer: Buffer; format: string }): any {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        data: screenshot.buffer.toString('base64'),
      },
    };
  }

  /** Save debug screenshot to disk */
  private saveDebugScreenshot(
    buffer: Buffer,
    debugDir: string,
    subtaskIndex: number,
    stepIndex: number,
    action: string,
  ): void {
    try {
      const filename = `cu-${subtaskIndex}-${stepIndex}-${action}.png`;
      fs.writeFileSync(path.join(debugDir, filename), buffer);
    } catch {
      // non-fatal
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
