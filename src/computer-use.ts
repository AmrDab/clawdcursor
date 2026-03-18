/**
 * Computer Use API Adapter
 *
 * Uses Anthropic's native computer_20250124 tool spec instead of
 * custom prompt engineering. The vision LLM natively understands how to
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
const MAX_ITERATIONS = 20;
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
SITE SHORTCUTS (use these instead of clicking — much faster and more reliable):
- Reddit: j/k move between posts, a upvote, z downvote, c open comments, r reply, s save
- Twitter/X: j/k move between tweets, l like, t retweet, r reply, m DM, n new tweet
- YouTube: Space pause/play, f fullscreen, m mute, j/l skip 10s, k pause, Shift+> speed up
- Gmail: j/k move between emails, e archive, # delete, r reply, c compose, / search
- GitHub: s focus search, t file finder, l jump to line, w branch switcher
- Slack: Ctrl+k quick switcher, Alt+Up/Down move between channels
- Any site: / often focuses search, ? often shows keyboard shortcuts help

SUBMITTING IS MANDATORY: After EVERY type() action into a chat or prompt input, you MUST immediately follow with key("Return") in the same response batch. Typing without submitting is an incomplete action. Never end a response after type() without also sending Return.

MULTI-APP WORKFLOWS:
For tasks involving multiple apps (copy from X, paste in Y):
1. NEVER declare done until the FINAL paste/save action is confirmed
2. When copying text: select text (triple-click for sentence, click+drag for custom), then Cmd+C, then verify selection is highlighted before copying
3. When switching apps: use Cmd+Space (Spotlight) + type name + Return, or Cmd+Tab. After switching, ALWAYS take a screenshot to verify you're in the right app
4. When pasting: click in the target area first, THEN Cmd+V, THEN take a screenshot to verify the paste worked
5. The task is NOT done until the pasted content is VISIBLE in the target app
6. Common multi-app pattern: select text → Cmd+C → open new app (Cmd+Space + type + Return) → wait 2s → click in text area → Cmd+V → verify

WAITING FOR AI APPS (Codex, Claude, ChatGPT, etc.):
After submitting a message to an AI chat app, the app takes time to generate a response. You MUST wait for it to finish before doing anything else. Here is the exact pattern:
1. Click input box → type message → key "Return" (all in one batch)
2. Take a screenshot to confirm submission happened
3. Wait — do NOT interact yet. Take another screenshot after 8-10 seconds.
4. Look for signs the AI is STILL generating: a stop/cancel button, a spinning indicator, the input box is disabled or shows a placeholder like "Generating...", or the response text is still growing.
5. If STILL generating: wait again (take screenshot, check again). Keep waiting.
6. Only when you see the AI has FINISHED — input box is active again, send button is available, no stop button, response text has stabilized — THEN read the response and send your next message.
7. NEVER type into the input box while the AI is still generating. This interrupts it.

Do NOT: press super+d or any "show desktop" shortcut, take screenshots after every single action, use Windows shortcuts (Win key, Alt+F4, etc), retry same failed coordinates, send a new message before the AI finishes responding, declare a task complete before ALL steps are done — if the task says copy AND paste, you must do BOTH.`;

const SYSTEM_PROMPT_WIN = `You are Clawd Cursor, an AI desktop agent on Windows 11. Complete tasks fast and reliably.

Win11: taskbar BOTTOM centered, system tray bottom-right, high-DPI.

ACCESSIBILITY: Each tool_result has WINDOWS list, FOCUSED WINDOW UI TREE (elements+coords), TASKBAR APPS.
Use accessibility data to find exact element positions and verify state.

CRITICAL — CONTEXT AWARENESS:
When you receive a task with CONTEXT (prior steps listed), ALWAYS take a screenshot FIRST to assess the current state before acting. Do not assume state from the context alone — verify visually.

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
- After send/submit (Ctrl+Enter, clicking Send button): WAIT 3 seconds before taking a screenshot. The UI needs time to process. Do NOT immediately retry — wait first, then verify.
- After closing a dialog (Escape, clicking X): WAIT 1 second before the next action.
- NEVER assume an action failed just because the UI looks the same immediately after. Always wait before judging.

KEYBOARD-OVER-MOUSE (critical on high-DPI displays):
- ALWAYS prefer keyboard shortcuts over mouse clicks when both work
- Email composition: Ctrl+N → Tab → type → Tab → type → Tab → type → Ctrl+Enter
- Switching to an app: Alt+Tab (cycle) NOT clicking taskbar corners
- Closing dialogs: Escape NOT clicking X button
- Form fields: Tab to navigate, type directly — do NOT try to click field labels
- Only use mouse clicks when there is NO keyboard alternative

SCROLLING: NEVER use mouse scroll with small amounts. For scrolling web pages use keyboard: PageDown (full page), Space (half page), or arrow keys. Mouse scroll is unreliable on modern infinite-scroll sites.
SITE SHORTCUTS (use these instead of clicking — much faster and more reliable):
- Reddit: j/k move between posts, a upvote, z downvote, c open comments, r reply, s save
- Twitter/X: j/k move between tweets, l like, t retweet, r reply, m DM, n new tweet
- YouTube: Space pause/play, f fullscreen, m mute, j/l skip 10s, k pause, Shift+> speed up
- Gmail: j/k move between emails, e archive, # delete, r reply, c compose, / search
- GitHub: s focus search, t file finder, l jump to line, w branch switcher
- Slack: Ctrl+k quick switcher, Alt+Up/Down move between channels
- Any site: / often focuses search, ? often shows keyboard shortcuts help

MULTI-APP WORKFLOWS:
For tasks involving multiple apps (copy from X, paste in Y):
1. NEVER declare done until the FINAL paste/save action is confirmed
2. When copying text: select text (triple-click for sentence, click+drag for custom), then Ctrl+C, then verify selection is highlighted before copying
3. When switching apps: use Win+search (Super + type name + Return) or Alt+Tab. After switching, ALWAYS take a screenshot to verify you're in the right app
4. When pasting: click in the target area first, THEN Ctrl+V, THEN take a screenshot to verify the paste worked
5. The task is NOT done until the pasted content is VISIBLE in the target app
6. Common multi-app pattern: select text → Ctrl+C → open new app (Super + type + Return) → wait 2s → click in text area → Ctrl+V → verify

CRITICAL — NEVER CLOSE TERMINAL/POWERSHELL WINDOWS: The agent runs inside a PowerShell or terminal window. If you close it, the agent dies and the task fails permanently. NEVER click the X on any window titled "PowerShell", "Windows PowerShell", "Command Prompt", "cmd", "Terminal", "clawdcursor", or any terminal/console window. If a terminal window is in the way, click on the TARGET app in the taskbar to bring it to front — do NOT close the terminal.

Do NOT: take screenshots after every action, go one action at a time when you can batch, use search engines for known URLs, retry same failed coords, declare a task complete before ALL steps are done — if the task says copy AND paste, you must do BOTH.`;

const SYSTEM_PROMPT = IS_MAC ? SYSTEM_PROMPT_MAC : SYSTEM_PROMPT_WIN;

// Checkpoint system for task completion detection
const CHECKPOINT_TEMPLATES: Record<string, string[]> = {
  email: ['compose_opened', 'recipient_filled', 'subject_filled', 'body_filled', 'send_pressed', 'compose_closed'],
  form: ['form_visible', 'fields_filled', 'submit_pressed'],
  navigate: ['url_entered', 'page_loaded'],
  draw: ['tool_selected', 'drawing_started', 'drawing_complete'],
  file_save: ['save_triggered', 'path_entered', 'save_confirmed'],
  multi_app: ['first_app_focused', 'first_app_action_done', 'content_copied', 'second_app_opened', 'content_pasted', 'result_visible'],
  app_interaction: ['app_focused', 'action_performed', 'result_visible'],
};

function detectTaskType(task: string): string {
  const lower = task.toLowerCase();
  // Multi-app: task involves copying/moving content between apps or switching apps mid-task
  if (/\b(copy.*paste|then open|switch to|move to|from.*to|paste.*(in|into)|drag.*to)\b/.test(lower)) return 'multi_app';
  if (/\b(email|compose|send.*to|mail)\b/.test(lower)) return 'email';
  if (/\b(fill|form|register|sign.?up)\b/.test(lower)) return 'form';
  if (/\b(go to|navigate|open.*url|visit)\b/.test(lower)) return 'navigate';
  if (/\b(draw|paint|sketch)\b/.test(lower)) return 'draw';
  if (/\b(save|download)\b/.test(lower)) return 'file_save';
  return 'app_interaction'; // generic fallback
}

function updateCheckpoints(tracker: CheckpointTracker, action: string, description: string, claudeText: string): void {
  const descriptionLower = description.toLowerCase();
  const claudeLower = claudeText.toLowerCase();
  const lower = `${descriptionLower} ${claudeLower}`;
  
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
        // Multiple drags completed and vision LLM says done
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
        if (
          (claudeLower.includes('pasted') || claudeLower.includes('paste')) &&
          (claudeLower.includes('success') || claudeLower.includes('visible') || claudeLower.includes('complete') || claudeLower.includes('done'))
        ) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      // Multi-app checkpoints
      case 'first_app_focused':
        if (action === 'screenshot') {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'first_app_action_done':
        if (action === 'key' && (lower.includes('page_down') || lower.includes('pagedown') || lower.includes('space'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        if (action === 'scroll') {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'content_copied':
        if (action === 'key' && (descriptionLower.includes('ctrl+c') || descriptionLower.includes('cmd+c'))) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'second_app_opened':
        // Universal: any window switch action (Alt+Tab, Super/Win key, Cmd+Tab, Cmd+Space, taskbar click)
        if (
          (action === 'key' && (descriptionLower.includes('alt+tab') || descriptionLower.includes('super') || descriptionLower.includes('cmd+tab') || descriptionLower.includes('cmd+space'))) ||
          (action === 'left_click' && claudeLower.match(/\b(opened?|switch|launch|start|taskbar)\b/))
        ) {
          cp.detected = true;
          cp.timestamp = Date.now();
        }
        break;
      case 'content_pasted':
        if (action === 'key' && (descriptionLower.includes('ctrl+v') || descriptionLower.includes('cmd+v'))) {
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

export interface ComputerUseOverrides {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  enabled?: boolean;
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
  private computerUseOverrides?: ComputerUseOverrides;
  private targetProcessName: string | null = null;
  private verifier: import('./verifiers').TaskVerifier | null = null;

  // A11y context cache — avoids hammering JXA after every single action
  private a11yCache: { context: string; ts: number; pid?: number } | null = null;

  constructor(
    config: ClawdConfig,
    desktop: NativeDesktop,
    a11y: AccessibilityBridge,
    safety: SafetyLayer,
    pipelineOverrides?: ComputerUseOverrides,
  ) {
    this.config = config;
    this.desktop = desktop;
    this.a11y = a11y;
    this.safety = safety;
    this.computerUseOverrides = pipelineOverrides;

    const screen = desktop.getScreenSize();
    this.screenWidth = screen.width;
    this.screenHeight = screen.height;

    // Scale factor MUST match NativeDesktop.captureForLLM() — use floating point, not ceil
    const LLM_WIDTH = 1280; // Must match native-desktop.ts LLM_TARGET_WIDTH
    this.scaleFactor = screen.width > LLM_WIDTH ? screen.width / LLM_WIDTH : 1;
    this.llmWidth = Math.min(screen.width, LLM_WIDTH);
    this.llmHeight = Math.round(screen.height / this.scaleFactor);

    // Display config logged at debug level only
  }

  setVerifier(v: import('./verifiers').TaskVerifier): void {
    this.verifier = v;
  }

  /**
   * Check if the current provider supports native Computer Use.
   */
  static isSupported(config: ClawdConfig, pipelineOverrides?: ComputerUseOverrides): boolean {
    const hasPipelineCu = !!pipelineOverrides?.enabled && !!pipelineOverrides?.apiKey;
    const hasDirectAnthropic = config.ai.provider === 'anthropic' && !!config.ai.apiKey;
    return hasPipelineCu || hasDirectAnthropic;
  }

  /**
   * Execute a subtask using the Computer Use tool loop.
   * The vision LLM autonomously takes screenshots, decides actions, and executes them.
   */
  async executeSubtask(
    subtask: string,
    debugDir: string | null,
    subtaskIndex: number,
    priorSteps?: string[],
    logger?: import('./task-logger').TaskLogger,
  ): Promise<ComputerUseResult> {
    const steps: StepResult[] = [];
    let llmCalls = 0;
    const messages: any[] = [];

    // Visual loop tasks (screenshot→act→repeat) don't benefit from a11y UI tree —
    // they're purely vision-driven. Skip all a11y fetches to cut 3-10s per iteration.
    const skipA11yCompletely = this.isVisualLoopSubtask(subtask);

    console.log(`   🖥️  Layer 3: "${subtask.substring(0, 80)}${subtask.length > 80 ? '...' : ''}"`);

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
    // checkpoint tracking is internal

    // Build context from prior completed steps so the vision LLM doesn't redo work
    let taskMessage = subtask;
    if (priorSteps && priorSteps.length > 0) {
      taskMessage = `CONTEXT — These steps were already completed for you:\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nThe app is ALREADY OPEN and FOCUSED. Do NOT reopen it. Do NOT maximize it. Start working immediately.\n\nYOUR TASK: ${subtask}`;
    }

    // Initial user message with the subtask
    messages.push({
      role: 'user',
      content: taskMessage,
    });

    // Fix 3: Window focus helper — verify target app is focused before starting
    try {
      const activeWindow = await this.a11y.getActiveWindow();
      if (activeWindow) {
        const activeProc = activeWindow.processName.toLowerCase();
        const taskLower = subtask.toLowerCase();
        // Detect expected target app from task text
        const appHints: Record<string, string[]> = {
          chrome: ['chrome', 'browser', 'web', 'google', 'gmail', 'youtube'],
          msedge: ['edge', 'browser', 'web', 'bing'],
          firefox: ['firefox', 'browser', 'web'],
          outlook: ['outlook', 'email', 'mail'],
          thunderbird: ['thunderbird', 'email', 'mail'],
          notepad: ['notepad', 'text editor', 'note'],
          code: ['vscode', 'vs code', 'visual studio code', 'code editor'],
          excel: ['excel', 'spreadsheet'],
          word: ['word', 'document', 'doc'],
          explorer: ['file explorer', 'files', 'folder'],
          slack: ['slack'],
          teams: ['teams'],
          discord: ['discord'],
          paint: ['paint', 'draw', 'sketch'],
        };
        let expectedApp: string | null = null;
        for (const [proc, keywords] of Object.entries(appHints)) {
          if (keywords.some(kw => taskLower.includes(kw))) {
            expectedApp = proc;
            break;
          }
        }
        // Store for continuous focus verification during the action loop
        this.targetProcessName = expectedApp;
        this.targetProcessId = null; // will be detected on first focus check
        // Handle known process name aliases (e.g., new Outlook = "olk", not "outlook")
        const procAliases: Record<string, string[]> = {
          outlook: ['outlook', 'olk'],
          chrome: ['chrome'],
          firefox: ['firefox'],
          notepad: ['notepad'],
          word: ['word', 'winword'],
          excel: ['excel'],
        };
        const matchesExpected = procAliases[expectedApp ?? '']
          ? procAliases[expectedApp!].some(alias => activeProc.includes(alias))
          : activeProc.includes(expectedApp ?? '');
        if (expectedApp && !matchesExpected) {
          // refocusing to expected app
          // Try to find and focus the target window directly
          const targetWin = await this.a11y.findWindow(expectedApp);
          if (targetWin) {
            this.targetProcessId = targetWin.processId;
            await this.a11y.focusWindow(undefined, targetWin.processId);
            await this.delay(500);
          } else {
            for (let attempt = 0; attempt < 3; attempt++) {
              await this.desktop.keyPress('alt+tab');
              await this.delay(500);
              const newWindow = await this.a11y.getActiveWindow();
              const newProc = (newWindow?.processName || '').toLowerCase();
              const foundTarget = procAliases[expectedApp]
                ? procAliases[expectedApp].some(alias => newProc.includes(alias))
                : newProc.includes(expectedApp);
              if (newWindow && foundTarget) {
                this.targetProcessId = newWindow.processId;
                break;
              }
            }
          }
        } else {
          this.targetProcessId = activeWindow.processId;
        }
      }
    } catch {
      // focus check non-fatal
    }

    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;
    let lastActionSignature = '';
    let repeatedActionStreak = 0;
    const recentScreenshotHashes: number[] = [];

    let verificationFailures = 0;
    const MAX_VERIFICATION_RETRIES = 3;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      llmCalls++;
      logger?.recordLlmCall();
      const cuCallStart = performance.now();
      const response = await this.callAPI(messages);
      const cuCallMs = Math.round(performance.now() - cuCallStart);

      if (response.error) {
        console.log(`   ❌ Layer 3 API error: ${response.error}`);
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

      // text blocks logged at debug level only

      // If end_turn → vision LLM thinks it's done. Verify with checkpoints.
      if (response.stop_reason === 'end_turn') {
        // Skip verification for visual/loop tasks — trust the vision LLM's judgment,
        // avoid the extra screenshot + API call overhead
        const skipVerify = skipA11yCompletely || /\b(draw|paint|sketch|doodle|color|design)\b/i.test(subtask);

        if (skipVerify) {
          console.log(`   ⚠️ Computer Use: LLM declared done (verification SKIPPED — visual/draw task)`);
          logger?.logStep({ layer: 3, actionType: 'done', result: 'success', verification: { method: 'none', verified: false, detail: 'visual/draw task — verification skipped' } });
          steps.push({
            action: 'done',
            description: `Computer Use completed (unverified): "${subtask}"`,
            success: true,
            timestamp: Date.now(),
          });
          return { success: true, steps, llmCalls };
        }

        // Email-specific shortcut: if task was email-related and compose window closed, trust it
        const isEmailTask = /\b(email|mail|send|compose|outlook|gmail)\b/i.test(subtask);
        if (isEmailTask) {
          const activeWin = await this.a11y.getActiveWindow().catch(() => null);
          const winTitle = (activeWin?.title || '').toLowerCase();
          const isCompose = winTitle.includes('new message') ||
                            winTitle.includes('untitled') ||
                            winTitle.includes('compose');
          const isInbox = winTitle.includes('inbox') || winTitle.includes('mail') || winTitle.includes('outlook');
          if (!isCompose && isInbox) {
            steps.push({ action: 'done', description: `Task complete — compose window closed, now at inbox (${activeWin?.title})`, success: true, timestamp: Date.now() });
            return { success: true, steps, llmCalls };
          }
        }

        // ALWAYS verify with vision when LLM declares done — take a screenshot and confirm
        {
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
          // Verification call failed — report as unverified failure
          console.log(`   ⚠️ Layer 3 verification API call failed — marking unverified`);
          logger?.logStep({ layer: 3, actionType: 'done', result: 'fail', verification: { method: 'vision', verified: false, detail: 'verification API call failed' } });
          steps.push({
            action: 'done',
            description: `Computer Use completed (UNVERIFIED — verify call failed): "${subtask}"`,
            success: false,
            timestamp: Date.now(),
          });
          return { success: false, steps, llmCalls };
        }

        // Parse verification response
        const verifyText = verifyResponse.content
          .filter((b: ContentBlock) => (b as TextBlock).type === 'text')
          .map((b: ContentBlock) => (b as TextBlock).text)
          .join('');
        
        const verifiedMatch = verifyText.match(/"verified"\s*:\s*(true|false)/);
        const isVerified = verifiedMatch ? verifiedMatch[1] === 'true' : !verifyText.toLowerCase().includes('"verified": false');

        if (isVerified) {
          // Ground truth post-verification — don't trust vision alone
          const groundTruth = await this.groundTruthCheck(subtask, logger);
          if (groundTruth.pass) {
            console.log(`   ✅ Layer 3 verified (ground truth: ${groundTruth.detail})`);
            logger?.logStep({
              layer: 3,
              actionType: 'done',
              result: 'success',
              verification: { method: 'vision', verified: true, detail: `vision: ${verifyText.substring(0, 100)} | ground_truth: ${groundTruth.detail}` },
            });
            steps.push({
              action: 'done',
              description: `Computer Use completed (verified): "${subtask}"`,
              success: true,
              timestamp: Date.now(),
            });
            return { success: true, steps, llmCalls };
          } else {
            // Vision said verified but ground truth disagrees
            console.log(`   ⚠️ Layer 3 vision said verified but ground truth FAILED: ${groundTruth.detail}`);
            logger?.logStep({
              layer: 3,
              actionType: 'done_rejected',
              result: 'fail',
              verification: { method: 'a11y_readback', verified: false, detail: `vision_lied: ${groundTruth.detail}` },
            });
            // Push back — don't accept, let the loop continue
            verificationFailures++;
            if (verificationFailures >= MAX_VERIFICATION_RETRIES) {
              steps.push({
                action: 'done',
                description: `Computer Use completed (UNVERIFIED — ground truth failed): "${subtask}"`,
                success: false,
                timestamp: Date.now(),
              });
              return { success: false, steps, llmCalls };
            }
            messages.push({
              role: 'assistant',
              content: verifyResponse.content,
            });
            messages.push({
              role: 'user',
              content: `GROUND TRUTH CHECK FAILED: ${groundTruth.detail}. The task is NOT actually done. Take a screenshot and fix the issue.`,
            });
            continue;
          }
        }

        // Not verified — vision LLM should continue with recovery
        verificationFailures++;
        if (verificationFailures >= MAX_VERIFICATION_RETRIES) {
          // max verification retries reached
          steps.push({
            action: 'done',
            description: `Computer Use completed (unverified after ${verificationFailures} retries): "${subtask}"`,
            success: false,
            timestamp: Date.now(),
          });
          return { success: false, steps, llmCalls };
        }

        // verification failed — retrying
        messages.push({
          role: 'assistant',
          content: verifyResponse.content,
        });
        
        // Build step log summary so the vision LLM understands what happened
        const recentSteps = steps.slice(-10).map((s, idx) => `${idx + 1}. [${s.action}] ${s.description} (${s.success ? 'ok' : 'failed'})`).join('\n');
        const checkpointStatus = tracker.checkpoints.map(c => `${c.detected ? '✅' : '❌'} ${c.name}`).join(', ');
        
        // Push vision LLM to take corrective action with full context
        messages.push({
          role: 'user',
          content: `The task is NOT complete. This is retry ${verificationFailures}/${MAX_VERIFICATION_RETRIES} — if you fail again, the task will be marked incomplete.

STEP LOG (last ${Math.min(steps.length, 10)} actions):
${recentSteps}

CHECKPOINT STATUS: ${checkpointStatus}

ANALYSIS: Look at the step log and checkpoints above. Identify what was MISSED or FAILED. The most common issues are:
- Forgot to paste (Ctrl+V/Cmd+V) after copying
- Didn't switch to the target app (Alt+Tab/Cmd+Tab)
- Clicked wrong area before pasting
- Didn't wait long enough for app to open

Fix the specific missed step. Do NOT repeat steps that already succeeded.`,
        });
        
        // Continue the loop — vision LLM will take corrective action
        continue;
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
          // screenshot requested
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
          if (result.error) console.log(`   ❌ ${result.description}`);

          steps.push({
            action: action,
            description: result.description,
            success: !result.error,
            error: result.error,
            timestamp: Date.now(),
          });

          logger?.logStep({
            layer: 3,
            actionType: action,
            result: result.error ? 'fail' : 'success',
            actionParams: { coordinate: toolUse.input.coordinate, text: toolUse.input.text?.substring(0, 80) },
            error: result.error,
          });

          // Track consecutive errors for bail-out
          if (result.error) {
            consecutiveErrors++;
            lastActionSignature = '';
            repeatedActionStreak = 0;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log(`   ❌ Layer 3: too many errors — aborting`);
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
            // Always send full context on error or loop detection so the vision LLM can recover
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
              // loop guard triggered
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

            // Fix 1: Wait for UI to settle after critical key actions before screenshot
            await this.waitForUISettle(action, toolUse.input.text || '');

            // Fix 2: Skip expensive screenshot for type/key actions — use a11y verification instead
            const skipScreenshot = action === 'type' || (action === 'key' && !isNavigation && !isAppLaunch);
            if (skipScreenshot) {
              const a11yContext = await this.getA11yContext(false, false);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: [{ type: 'text', text: `Action executed. Current accessibility state:\n${a11yContext}` }],
              });
            } else {
              // Skip a11y after simple clicks/types, and always when in visual-loop mode.
              // Run screenshot + a11y in parallel when a11y is needed.
              const skipA11y = skipA11yCompletely || (action === 'left_click' && !isNavigation);
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
            }
          } else {
            // Not last in batch: skip screenshot but include focused element info
            // so the LLM knows if the click/type landed correctly
            const isAppLaunch = action === 'key' && toolUse.input.text?.toLowerCase().includes('super');
            const isDrag = action === 'drag';
            const isClick = action.includes('click');
            const delayMs = isAppLaunch ? 600 : isDrag ? 20 : isClick ? 100 : 80;
            await this.delay(delayMs);

            // Lightweight verification: read focused element for click/type actions
            let focusInfo = '';
            if (isClick || action === 'type') {
              try {
                const focused = await this.a11y.getFocusedElement();
                if (focused) {
                  focusInfo = ` Focus is now on: [${focused.controlType}] "${focused.name}" at (${focused.bounds.x},${focused.bounds.y})`;
                  if (focused.value) focusInfo += ` value="${focused.value.substring(0, 60)}"`;
                }
              } catch { /* non-fatal */ }
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [{ type: 'text', text: `OK — action executed.${focusInfo}` }],
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
        const stepDesc = steps[steps.length - toolUseBlocks.length + ti]?.description || '';
        tracker.update(action, stepDesc, claudeText);
      }

      // Stagnation detection: track action signatures and abort if stuck
      for (const toolUse of toolUseBlocks) {
        const sig = this.actionSignature(toolUse);
        if (sig) recentScreenshotHashes.push(sig.length);  // lightweight hash proxy
      }
      if (recentScreenshotHashes.length >= 8) {
        const last8 = recentScreenshotHashes.slice(-8);
        const unique = new Set(last8).size;
        if (unique <= 2) {
          console.warn(`   [CU] ⚠️ Stagnation detected: ${last8.length} iterations with only ${unique} distinct action patterns. Aborting.`);
          logger?.logStep({ layer: 3, actionType: 'stagnation_abort', result: 'fail', error: 'Stagnation detected — stuck in loop' });
          return { success: false, steps, llmCalls };
        }
      }

      // Send tool results back
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    console.log(`   ⚠️ Layer 3: max iterations reached`);
    return { success: false, steps, llmCalls };
  }

  // ─── API Call ───────────────────────────────────────────────────

  private async callAPI(messages: any[]): Promise<any> {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

      try {
        const baseUrl = (this.computerUseOverrides?.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
        const endpoint = `${baseUrl}/messages`;
        const apiKey = this.computerUseOverrides?.apiKey || this.config.ai.apiKey;
        const model = this.computerUseOverrides?.model || this.config.ai.visionModel;

        if (!apiKey) {
          return { content: [], stop_reason: 'end_turn', error: 'Missing API key for Computer Use provider' };
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA_HEADER,
          },
          body: JSON.stringify({
            model,
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

  // ─── Ground Truth Post-Verification ──────────────────────────

  /**
   * Programmatic verification after vision model claims done.
   * Uses UIA/clipboard/window state — NOT another LLM call.
   * Returns { pass: true/false, detail: string }
   */
  private async groundTruthCheck(
    subtask: string,
    _logger?: import('./task-logger').TaskLogger,
  ): Promise<{ pass: boolean; detail: string }> {
    try {
      if (this.verifier) {
        const readClip = () => this.a11y.readClipboard();
        const result = await this.verifier.verify(subtask, readClip);
        return { pass: result.pass, detail: `[${result.method}] ${result.detail}` };
      }

      // Minimal inline fallback when no verifier is set
      const activeWin = await this.a11y.getActiveWindow().catch(() => null);
      const processName = (activeWin?.processName || '').toLowerCase();

      if (/notepad/i.test(subtask) || processName === 'notepad') {
        const focused = await this.a11y.getFocusedElement().catch(() => null);
        if (focused?.value && focused.value.trim().length > 10) {
          return { pass: true, detail: `notepad has ${focused.value.length} chars` };
        }
        return { pass: false, detail: `notepad appears empty` };
      }

      return { pass: true, detail: `no verifier available — trusting vision` };
    } catch (err) {
      return { pass: true, detail: `ground truth error: ${String(err).substring(0, 80)}` };
    }
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
      // Verify target app is still focused before executing (prevents typing in wrong window)
      if (action !== 'screenshot') {
        await this.verifyAndRefocus();
      }

      switch (action) {
        case 'left_click': {
          const [x, y] = this.scale(coordinate!);
          // Block clicks in the taskbar zone (bottom 60px)
          const screenSize = this.desktop.getScreenSize();
          if (y > screenSize.height - 60) {
            console.warn(`   [CU] ⚠️ BLOCKED: click at y=${y} is in taskbar zone`);
            return { description: `BLOCKED: click in taskbar zone at (${x},${y}). Use keyboard shortcuts to switch apps.` };
          }
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
          const keyNorm = text.toLowerCase().replace(/\s/g, '');
          // Block Alt+Tab — breaks window focus, agent loses context
          if (keyNorm.includes('alt+tab') || keyNorm.includes('alt+shift+tab')) {
            console.warn(`   [CU] BLOCKED key: ${text} (Alt+Tab escapes target app)`);
            return { description: `BLOCKED: ${text} — Alt+Tab disabled. Stay in the current app.`, error: 'alt+tab blocked' };
          }
          // Block ALL Win/Super combos EXCEPT super+up (maximize) — prevents Start menu, Run dialog, etc.
          if (keyNorm.includes('super') || keyNorm.includes('win') || keyNorm.includes('meta')) {
            if (keyNorm === 'super+up') {
              // Allow super+up for window maximize
            } else {
              console.warn(`   [CU] BLOCKED key: ${text} (Super/Win key escapes target app)`);
              return { description: `BLOCKED: ${text} — Win/Super key disabled. Use app controls instead.`, error: 'super key blocked' };
            }
          }
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


  /**
   * Verify the target app is still focused. If not, refocus it.
   * Prevents actions landing in the wrong window (e.g., typing in Edge URL bar).
   */
  private targetProcessId: number | null = null;

  private async verifyAndRefocus(): Promise<void> {
    if (!this.targetProcessName) return;
    try {
      const activeWin = await this.a11y.getActiveWindow();
      if (!activeWin) return;
      const activeProc = activeWin.processName.toLowerCase();
      const targetProc = this.targetProcessName.toLowerCase();

      // Handle aliases (e.g., new Outlook = "olk")
      const procAliases: Record<string, string[]> = {
        outlook: ['outlook', 'olk'],
        chrome: ['chrome'],
        msedge: ['msedge', 'edge'],
        firefox: ['firefox'],
        notepad: ['notepad'],
        word: ['word', 'winword'],
        excel: ['excel'],
      };

      const aliases = procAliases[targetProc] || [targetProc];
      const isFocused = aliases.some(alias => activeProc.includes(alias));

      if (!isFocused) {
        // refocusing — focus lost
        // First try by stored processId (fastest, most reliable)
        if (this.targetProcessId) {
          await this.a11y.focusWindow(undefined, this.targetProcessId);
          await this.delay(400);
          return;
        }
        // Try by process name through window search
        const targetWin = await this.a11y.findWindow(this.targetProcessName);
        if (targetWin) {
          this.targetProcessId = targetWin.processId;
          await this.a11y.focusWindow(undefined, targetWin.processId);
          await this.delay(400);
        } else {
          // Fallback: Alt+Tab to cycle
          await this.desktop.keyPress('alt+tab');
          await this.delay(500);
        }
      } else {
        // Store the processId for faster refocus next time
        if (!this.targetProcessId) {
          this.targetProcessId = activeWin.processId;
        }
      }
    } catch {
      // Non-fatal — best effort
    }
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
   * Generate a FOCUS hint telling the vision LLM where to look in the screenshot.
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

  /**
   * For critical actions (send/submit/confirm/close), wait up to maxMs for
   * the a11y tree to reflect the expected change, polling every 400ms.
   * Returns true if a change was detected, false if timed out.
   */
  private async waitForUISettle(action: string, keyText: string, maxMs = 4000): Promise<boolean> {
    const criticalKeys = ['ctrl+return', 'ctrl+enter', 'return', 'enter', 'escape', 'ctrl+s', 'ctrl+w', 'alt+f4'];
    const keyLower = (keyText || '').toLowerCase().replace(/\s/g, '');
    if (action !== 'key' || !criticalKeys.some(k => keyLower.includes(k))) return false;

    // settling after key press
    const before = await this.a11y.getActiveWindow().catch(() => null);
    const beforeTitle = before?.title || '';

    const interval = 400;
    const attempts = Math.ceil(maxMs / interval);
    for (let i = 0; i < attempts; i++) {
      await this.delay(interval);
      const after = await this.a11y.getActiveWindow().catch(() => null);
      const afterTitle = after?.title || '';
      if (afterTitle !== beforeTitle) {
        // UI settled
        return true; // window changed — action took effect
      }
    }
    // settle timeout
    return false;
  }
}


