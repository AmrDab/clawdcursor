/**
 * OCR Reasoner — Layer 2.5.
 *
 * Primary universal read layer. Takes a screenshot, runs OS-level OCR,
 * builds a structured UI snapshot string, feeds it to a cheap text LLM,
 * and executes the returned action. Loops until done or cannot_read.
 *
 * Coordinates are in REAL screen pixels (no scaleFactor conversion needed).
 * This is simpler and more accurate than the vision LLM coordinate path.
 *
 * Falls through to vision LLM (L3) only when OCR genuinely cannot parse
 * the UI (captchas, pure image content, etc.).
 */

import { OcrEngine, type OcrResult, type OcrElement } from './ocr-engine';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge, type UIElement } from './accessibility';
import { callTextLLMDirect, LLMBillingError, LLMAuthError } from './llm-client';
import type { PipelineConfig } from './providers';
import type { StepResult } from './types';
import { getBrowserProcessRegex } from './browser-config';

const MAX_OCR_STEPS = 20;     // max actions before giving up
const MAX_OCR_TIME_MS = 55000; // 55s wall-clock — leave 5s margin within 60s task timeout
const SETTLE_MS     = 200;    // wait after action before re-OCR (reduced from 400)
const CANNOT_READ_RETRIES = 2; // retries before signaling vision fallback
const MAX_CONTEXT_TURNS = 3;  // sliding window: keep last N user/assistant turn pairs
const STAGNATION_THRESHOLD = 4; // bail after N identical OCR screens

// ─── Action types returned by the LLM ────────────────────────────────────────

export type OcrAction =
  | { action: 'click';       x: number; y: number; description: string }
  | { action: 'double_click'; x: number; y: number; description: string }
  | { action: 'drag';        startX: number; startY: number; endX: number; endY: number; description: string }
  | { action: 'type';        text: string; description: string }
  | { action: 'key';         key: string; description: string }
  | { action: 'scroll';      x: number; y: number; direction: 'up' | 'down'; amount: number }
  | { action: 'wait';        ms: number; reason: string }
  | { action: 'done';        evidence: string }
  | { action: 'cannot_read'; reason: string }
  | { action: 'a11y_click';  name: string; controlType?: string; automationId?: string; description: string }
  | { action: 'a11y_set_value'; name: string; controlType?: string; value: string; description: string };

// ─── Result from a single OcrReasoner run ────────────────────────────────────

export interface OcrReasonerResult {
  handled: boolean;
  success: boolean;
  description: string;
  steps: number;
  fallbackReason?: string;  // set when cannot_read — tells agent.ts to try vision LLM
  needsHuman?: boolean;     // set when task needs human intervention (payment, captcha, 2FA)
  actionLog: Array<{ action: string; description: string }>;
}

// ─── A11y metadata from spatial merge ────────────────────────────────────────

interface A11yMetadata {
  controlType: string;    // "Button", "Edit", etc.
  name: string;           // UIA name (e.g., "Text", "Send")
  automationId: string;   // UIA automation ID for reliable invoke
  isEnabled: boolean;
}

// ─── Parallel A11y capture result ────────────────────────────────────────────

interface A11yCaptureResult {
  win: { processName: string; title: string; processId: number; bounds: { x: number; y: number; width: number; height: number }; isMinimized?: boolean } | null;
  tree: string | null;
  elements: UIElement[];
}

// ─── System prompt for the text LLM ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are a desktop automation agent. You receive a UI snapshot with OCR text elements and their PRE-COMPUTED click coordinates. Your job is to decide the SINGLE NEXT ACTION to accomplish the user's task.

COORDINATE SYSTEM: All coordinates are in REAL SCREEN PIXELS. Click coordinates are PRE-COMPUTED centers — use them directly, no math needed.

OCR ELEMENT FORMAT: Each element shows its center click-point and text:
  [ID] @(cx,cy) "text"              — click at (cx,cy) to interact with this element
  [ID] @(cx,cy,Button) "text"       — tagged with control type (Button, Edit, CheckBox, etc.) from accessibility tree
  [ID] @(cx,cy,conf:0.85) "text"    — low OCR confidence

RESPONSE FORMAT — respond with ONLY valid JSON, no markdown:
{"action":"click","x":150,"y":300,"description":"Click the Send button"}
{"action":"double_click","x":150,"y":300,"description":"Double-click to select word"}
{"action":"drag","startX":400,"startY":200,"endX":400,"endY":350,"description":"Draw a vertical line for the body"}
{"action":"type","text":"Hello world","description":"Type greeting into the text field"}
{"action":"key","key":"ctrl+s","description":"Save the document"}
{"action":"scroll","x":640,"y":400,"direction":"down","amount":3,"description":"Scroll down to see more content"}
{"action":"wait","ms":1000,"reason":"Waiting for page to load"}
{"action":"done","evidence":"The email was sent — confirmation banner visible at top"}
{"action":"cannot_read","reason":"Screen contains a captcha image that OCR cannot parse"}
{"action":"a11y_click","name":"Text","controlType":"Button","description":"Click the Text tool in Paint toolbar"}
{"action":"a11y_set_value","name":"Subject","controlType":"Edit","value":"Hello from ClawdCursor","description":"Set the Subject field"}
{"action":"needs_human","reason":"Payment form requires credit card","description":"Human must enter payment details"}

RULES:
1. Return exactly ONE action per response — JSON only, no explanation
2. Use the @(cx,cy) coordinates DIRECTLY for clicks — they are already the element centers
3. Prefer keyboard shortcuts over mouse clicks when available (ctrl+s to save, ctrl+a to select all, etc.)
4. Say "done" ONLY when you see VISIBLE PROOF on screen that the task is complete
5. Say "cannot_read" ONLY when OCR returned garbled/empty text (captchas, blank screens). NEVER use cannot_read because you think an app doesn't support something — instead, explore the toolbar and try (e.g., Paint has a Text tool "A", image editors have text layers, etc.)
6. NEVER repeat a failed action — if clicking didn't work, try a different element or keyboard shortcut
7. Elements tagged with control types (Button, Edit, etc.) are interactive — prefer these for clicks
8. ALWAYS click an input field BEFORE typing. Never assume focus. Use SEPARATE click and type steps.
9. After typing, CHECK the next snapshot for your text. If it's missing, you typed in the wrong field — fix it.
10. NEVER click in the bottom 60px of the screen (taskbar). Use keyboard shortcuts to switch apps.
11. Be EFFICIENT — each step costs time. Don't click things unnecessarily. Plan the shortest path to completion.
12. For CALCULATOR: ALWAYS use keyboard "key" actions, NEVER click buttons. Type digits with key "2", "5", "6". For operators use key "+", key "-", key "*", key "/". Press key "=" or key "Return" to compute. Press key "Escape" to clear. NEVER click any on-screen button — scientific mode has confusing buttons like x^y, x², √x that look similar to +, -, × but do completely different operations.
13. For TEXT INPUT: When a field already has focus, prefer "key" action to type individual characters over "type" action for short inputs. Use "type" for longer text.
14. When OCR shows similar-looking elements (e.g., "x" for multiply vs "x" in "x²"), DO NOT click them. Use keyboard shortcuts instead to avoid misidentification.
15. When the task says to type SPECIFIC TEXT, use the EXACT FULL text from the task. NEVER abbreviate, shorten, or paraphrase. Copy it verbatim character-for-character into the "text" field of your type action.
16. For compound tasks (multiple steps like "select all, delete, then type X"), execute each sub-step in order. Do NOT skip sub-steps or declare "done" until ALL sub-steps are complete.
17. DIGIT ACCURACY IS CRITICAL. When typing numbers, type EVERY single digit. For "100" you must press key "1", key "0", key "0" — all three digits. For "200" you must press key "2", key "0", key "0". NEVER skip zeros. Count your digits against the original number.
18. After pressing "=" or "Return" in Calculator, the result should appear on screen. Say "done" with the result as evidence.
19. For EMAIL apps (Outlook, Mail): Follow this EXACT sequence: (a) Click "New mail" button to open compose. (b) The To field is AUTOMATICALLY FOCUSED after compose opens — DO NOT click the To field. Just immediately type the email address. Then press key "Tab" to confirm the address and move to Subject. Do NOT press Return/Enter in the To field. (c) Type the subject, then press key "Tab" to move to Body. (d) Type the FULL email body. (e) CLICK the Send button (blue button at top-left of compose). NEVER use Return/Enter to send — it does NOT send emails, only adds a newline. You MUST click the Send button.
20. When "introducing yourself", you ARE ClawdCursor — an AI desktop automation agent. Write as yourself. NEVER use placeholder text like "[Your Name]" or "[description]". Write a real introduction about what you can do.
21. For DIALOGS and POPUPS: If an unexpected dialog appears, assess whether to interact with it or dismiss it with Escape. Do not keep clicking the same button that caused the dialog.
22. DONE VERIFICATION: Only say "done" when the task is ACTUALLY complete. For emails: the compose window must be CLOSED (email sent). "Draft saved" means NOT sent. For typing: the text must be VISIBLE on screen.
23. For DRAWING apps (Paint, canvas): Use "drag" actions to draw lines. First select the pencil/brush tool, then drag on the canvas. For a STICKMAN: draw a circle for the head (or use the circle shape tool), a vertical line for body, two angled lines for arms, two angled lines for legs. Use the shapes toolbar for circles/ovals. All coordinates are in screen pixels.
24. Use "double_click" when you need to select text, open files, or activate items that require double-clicking.
25. For SEARCH tasks: After typing a search query, you MUST press key "Return" or click the search button to EXECUTE the search. Seeing the query text in the search box does NOT mean the search is done — you need to see SEARCH RESULTS on screen. Only say "done" after results appear.
26. NEVER say "done" right after a "type" action. ALWAYS take at least one more step after typing (press Enter, click a button, verify the result appeared) before declaring done.
27. For FIND & REPLACE dialogs (Ctrl+H): The search/find field is auto-focused. Type the search term FIRST. Then you MUST CLICK the replace/replacement field (the SECOND text input, below the search field) before typing the replacement text. Then click "Replace All" or "Replace all" button. Do NOT type both terms without clicking between them — they will both go into the same field.
28. For MULTI-FIELD FORMS: Each text field requires a separate CLICK before typing. Never assume Tab or Enter moved focus to the next field — ALWAYS click the target field explicitly, THEN type in the next step.
29. When elements show [name:"X", id:Y] metadata from the accessibility tree, prefer a11y_click for MORE RELIABLE clicking: {"action":"a11y_click","name":"X","description":"..."}. The system invokes the element directly via UI Automation — no mouse coordinates needed. This is more reliable than coordinate-based clicks.
30. For input fields with accessibility metadata, use a11y_set_value to type directly: {"action":"a11y_set_value","name":"Field Name","controlType":"Edit","value":"text to enter","description":"..."}. This bypasses clipboard and focus issues.
31. ACTION PREFERENCE ORDER: a11y_click (if element has name/id metadata) > click by coordinates > keyboard shortcut. a11y_click uses the OS accessibility API and is the most reliable method for interacting with named UI elements.
32. If a task requires human intervention (payment, captcha, 2FA, password entry), return: {"action":"needs_human","reason":"why","description":"what the human must do"}`;

// ─── OcrReasoner class ──────────────────────────────────────────────────────

export class OcrReasoner {
  private lastClickCoords: { x: number; y: number } | null = null;
  private currentAppProcess: string = ''; // track active app for app-specific behavior
  private targetProcessId: number = 0; // active window process ID for accessibility lookups

  constructor(
    private ocr: OcrEngine,
    private desktop: NativeDesktop,
    private a11y: AccessibilityBridge,
    private pipelineConfig: PipelineConfig,
  ) {}

  /**
   * Run the OCR reasoning loop for a single task.
   * Returns when done, failed, or signals cannot_read for vision fallback.
   */
  async run(task: string, priorContext?: string[], isAborted?: () => boolean): Promise<OcrReasonerResult> {
    const actionLog: Array<{ action: string; description: string }> = [];
    let cannotReadCount = 0;
    let stepCount = 0;
    this.lastClickCoords = null;
    this.currentAppProcess = '';
    const ocrFingerprints: string[] = []; // for stagnation detection
    const startTime = Date.now();

    // Track the initial target window so we can re-focus if clicks steal focus
    let targetWindow: { processName: string; title: string; processId: number } | null = null;

    // Pre-focus: if priorContext says a browser/app was opened, find and focus it BEFORE
    // we start the OCR loop. Set targetWindow directly to avoid getActiveWindow() latching
    // onto whatever random window has focus (File Explorer, Settings, etc.).
    const browserRe = getBrowserProcessRegex();
    if (priorContext?.some(c => /navigated to|opened.*(?:edge|chrome|browser)|browser.*focused/i.test(c))) {
      try {
        const wins = await this.a11y.getWindows().catch(() => []);
        const browserWin = wins.find(w => browserRe.test(w.processName) && !w.isMinimized);
        if (browserWin) {
          // Try focus multiple times — Windows focus-stealing prevention can block single attempts
          for (let attempt = 0; attempt < 3; attempt++) {
            await this.a11y.focusWindow(undefined, browserWin.processId).catch(() => {});
            await new Promise(r => setTimeout(r, 300 + attempt * 200));
            const check = await this.a11y.getActiveWindow().catch(() => null);
            if (check && browserRe.test(check.processName)) break;
          }
          // Set target window directly — don't rely on getActiveWindow() in step 0
          targetWindow = {
            processName: browserWin.processName,
            title: browserWin.title || '',
            processId: browserWin.processId,
          };
          this.targetProcessId = browserWin.processId;
          this.currentAppProcess = (browserWin.title || browserWin.processName).toLowerCase();
          console.log(`   [OCR] Pre-focused browser: ${browserWin.processName} (pid ${browserWin.processId}) — set as target`);
        }
      } catch { /* non-fatal */ }
    }

    // Build conversation history for context (sliding window applied before each LLM call)
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    for (let step = 0; step < MAX_OCR_STEPS; step++) {
      stepCount = step + 1;

      // Abort check — task timeout may have fired while we were in an LLM call
      if (isAborted?.()) {
        console.warn(`   [OCR] ⚠️ Task aborted — stopping OCR loop.`);
        return { handled: false, success: false, description: 'Task aborted', steps: stepCount, actionLog };
      }

      // Time-based bailout — no task should take >55s in OCR Reasoner
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_OCR_TIME_MS) {
        console.warn(`   [OCR] ⚠️ Wall-clock timeout: ${(elapsed / 1000).toFixed(1)}s > ${MAX_OCR_TIME_MS / 1000}s limit. Bailing.`);
        return {
          handled: false,
          success: false,
          description: `OCR Reasoner timed out after ${(elapsed / 1000).toFixed(1)}s`,
          steps: stepCount,
          actionLog,
        };
      }

      // 0. Track focus shifts — update target when LLM actions open child windows
      // (e.g., Outlook compose opens in a different process than inbox)
      if (targetWindow && step > 0) {
        try {
          const currentWin = await this.a11y.getActiveWindow().catch(() => null);
          if (currentWin && currentWin.processId !== targetWindow.processId) {
            // If the last action was a click or key (intentional interaction), adopt the new window
            const lastAction = actionLog.length > 0 ? actionLog[actionLog.length - 1] : null;
            const wasIntentional = lastAction && ['click', 'key', 'type'].includes(lastAction.action);
            if (wasIntentional) {
              console.log(`   [OCR] Focus shifted from "${targetWindow.processName}" (pid ${targetWindow.processId}) to "${currentWin.processName}" (pid ${currentWin.processId}) — adopting new target`);
              targetWindow = { processName: currentWin.processName, title: currentWin.title, processId: currentWin.processId };
              this.targetProcessId = currentWin.processId;
            } else {
              console.log(`   [OCR] ⚠️ Unexpected focus shift to "${currentWin.processName}" — re-focusing target`);
              await this.a11y.focusWindow(undefined, targetWindow.processId).catch(() => {});
              await new Promise(r => setTimeout(r, 300));
            }
          }
        } catch { /* non-fatal */ }
      }

      // 1. PARALLEL CAPTURE — OCR screenshot + A11y tree simultaneously
      //    Each source has its own timeout to prevent hangs from eating the task budget:
      //    - OCR: 8s (OS-level OCR has its own 15s timeout, but we cap tighter here)
      //    - A11y: 5s (PSBridge can hang on complex UI trees)
      this.ocr.invalidateCache();
      this.a11y.invalidateCache();
      const captureTargetPid = targetWindow?.processId ?? 0;
      const CAPTURE_OCR_TIMEOUT = 8000;
      const CAPTURE_A11Y_TIMEOUT = 5000;
      const [ocrSettled, a11ySettled] = await Promise.allSettled([
        Promise.race([
          this.ocr.recognizeScreen(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('OCR capture timeout')), CAPTURE_OCR_TIMEOUT)),
        ]),
        Promise.race([
          this.captureA11y(captureTargetPid),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('A11y capture timeout')), CAPTURE_A11Y_TIMEOUT)),
        ]),
      ]);

      const ocrResult = ocrSettled.status === 'fulfilled'
        ? ocrSettled.value
        : { elements: [], fullText: '', durationMs: 0 };
      const a11yData: A11yCaptureResult = a11ySettled.status === 'fulfilled'
        ? a11ySettled.value
        : { win: null, tree: null, elements: [] };

      if (ocrSettled.status === 'rejected') console.warn(`   [OCR] ⚠️ OCR capture failed: ${ocrSettled.reason?.message ?? 'unknown'}`);
      if (a11ySettled.status === 'rejected') console.warn(`   [OCR] ⚠️ A11y capture failed: ${a11ySettled.reason?.message ?? 'unknown'}`);

      console.log(`   [OCR] Scan: ${ocrResult.elements.length} elements in ${ocrResult.durationMs}ms, top: "${ocrResult.elements[0]?.text || 'none'}" | A11y: ${a11yData.elements.length} elements`);

      // Stagnation detection: fingerprint moved AFTER window filtering (see below)

      // 2. Process A11y capture result — set target window, bounds, snippet
      let a11ySnippet = '';
      let a11yElements: UIElement[] = a11yData.elements;
      let windowBounds: { x: number; y: number; width: number; height: number } | null = null;
      let windowTitle = '';
      try {
        const activeWin = a11yData.win;
        if (activeWin) {
          // Record the target window on first step (skip if pre-focus already set it)
          if (step === 0 && !targetWindow) {
            targetWindow = { processName: activeWin.processName, title: activeWin.title, processId: activeWin.processId };
            this.targetProcessId = activeWin.processId;
            this.currentAppProcess = (activeWin.title || activeWin.processName).toLowerCase();
            console.log(`   [OCR] Target window: ${activeWin.processName} "${activeWin.title}" (pid ${activeWin.processId})`);
            // Click center of target window to guarantee keyboard focus (UWP apps like Calculator need this)
            if (activeWin.bounds && activeWin.bounds.width > 0) {
              const cx = activeWin.bounds.x + Math.round(activeWin.bounds.width / 2);
              const cy = activeWin.bounds.y + Math.round(activeWin.bounds.height / 2);
              const mc = this.desktop.physicalToMouse(cx, cy);
              console.log(`   [OCR] Focus click: center of window at (${mc.x},${mc.y})`);
              await this.desktop.mouseClick(mc.x, mc.y);
              await new Promise(r => setTimeout(r, 200));
            }
          }
          const contextName = targetWindow ? `${targetWindow.processName}: ${targetWindow.title}` : `${activeWin.processName}: ${activeWin.title}`;
          // For window bounds: prefer the target window if active window doesn't match
          if (targetWindow && activeWin.processId !== targetWindow.processId) {
            const wins = await this.a11y.getWindows().catch(() => []);
            const targetWinInfo = wins.find(w => w.processId === targetWindow!.processId);
            windowBounds = targetWinInfo?.bounds ?? activeWin.bounds;
          } else {
            windowBounds = activeWin.bounds;
          }
          windowTitle = contextName;
          // Use pre-captured tree from parallel a11y fetch
          if (a11yData.tree) {
            a11ySnippet = `\n=== A11Y TREE (${contextName}) ===\n${a11yData.tree.substring(0, 1000)}`;
          }
        }
      } catch { /* non-fatal — OCR is the primary source */ }

      // 2b. Filter OCR elements to ACTIVE WINDOW bounds only.
      // This prevents the LLM from clicking elements in background windows,
      // which causes focus loss and cascade failures.
      let filteredOcr = ocrResult;
      if (windowBounds && windowBounds.width > 0) {
        const wb = windowBounds;
        const pad = 20; // small padding for border elements
        const filtered = ocrResult.elements.filter(el => {
          const cx = el.x + el.width / 2;
          const cy = el.y + el.height / 2;
          return cx >= (wb.x - pad) && cx <= (wb.x + wb.width + pad)
              && cy >= (wb.y - pad) && cy <= (wb.y + wb.height + pad);
        });
        console.log(`   [OCR] Window filter: ${ocrResult.elements.length} → ${filtered.length} elements (${windowTitle}, bounds: ${wb.x},${wb.y} ${wb.width}x${wb.height})`);
        if (filtered.length > 0) {
          filteredOcr = { ...ocrResult, elements: filtered };
        } else {
          // All elements filtered out — likely a loading screen with no OCR text
          // in the target window, or a coordinate-space mismatch. Fall back to
          // the full unfiltered set so the LLM can still see the screen context.
          console.log(`   [OCR] Window filter returned 0 — using unfiltered elements as fallback`);
        }
      }

      // 2c. Stagnation detection: use FILTERED OCR (window-only) so the fingerprint
      // tracks actual changes in the target app, not desktop/taskbar noise.
      const fingerprint = filteredOcr.elements.map(el => el.text).join('|').substring(0, 800);
      ocrFingerprints.push(fingerprint);
      if (ocrFingerprints.length >= STAGNATION_THRESHOLD) {
        const recent = ocrFingerprints.slice(-STAGNATION_THRESHOLD);
        const lastAction = actionLog.length > 0 ? actionLog[actionLog.length - 1] : null;
        const wasDoneReject = lastAction?.action === 'done_rejected';
        if (recent.every(f => f === recent[0]) && !wasDoneReject) {
          console.warn(`   [OCR] ⚠️ Stagnation: ${STAGNATION_THRESHOLD} identical screens (window-filtered). Bailing.`);
          return {
            handled: false,
            success: false,
            description: `OCR stagnation: ${STAGNATION_THRESHOLD} identical screens — actions had no visible effect`,
            steps: stepCount,
            actionLog,
          };
        }
      }

      // 3. Build the UI snapshot string
      const snapshot = this.buildSnapshot(filteredOcr, a11ySnippet, a11yElements, actionLog, task, priorContext);

      // 4. Ask the text LLM for the next action (with sliding window)
      messages.push({ role: 'user', content: snapshot });

      // Apply sliding window: keep system prompt + last N turn pairs
      const contextMessages = this.applyWindow(messages);

      let llmResponse: string;
      try {
        llmResponse = await this.callOcrLLM(contextMessages);
      } catch (err: any) {
        if (err instanceof LLMBillingError) {
          console.error(`   [OCR Reasoner] Credits exhausted — OCR Reasoner aborting`);
          return { handled: false, success: false, description: 'Credits exhausted — OCR Reasoner aborting', steps: stepCount, actionLog };
        }
        if (err instanceof LLMAuthError) {
          console.error(`   [OCR Reasoner] Auth failed — check API key`);
          return { handled: false, success: false, description: 'Auth failed — check API key', steps: stepCount, actionLog };
        }
        console.error(`   [OCR Reasoner] LLM call failed: ${err.message}`);
        return {
          handled: false,
          success: false,
          description: `LLM call failed: ${err.message}`,
          steps: stepCount,
          actionLog,
        };
      }

      // Re-check abort after LLM call (could have taken 10-20s with retries)
      if (isAborted?.()) {
        console.warn(`   [OCR] ⚠️ Task aborted after LLM call — stopping.`);
        return { handled: false, success: false, description: 'Task aborted', steps: stepCount, actionLog };
      }

      console.log(`   [OCR] LLM response: ${llmResponse.substring(0, 200)}`);
      messages.push({ role: 'assistant', content: llmResponse });

      // 5. Parse the action
      const action = this.parseAction(llmResponse);
      if (!action) {
        console.log(`   [OCR] Step ${stepCount}: Failed to parse LLM response`);
        actionLog.push({ action: 'parse_error', description: 'Could not parse LLM response' });
        continue;
      }

      // 5b. Validate click coordinates are within active window bounds
      if (action.action === 'click' && windowBounds && windowBounds.width > 0) {
        const wb = windowBounds;
        const margin = 50;
        if (action.x < wb.x - margin || action.x > wb.x + wb.width + margin ||
            action.y < wb.y - margin || action.y > wb.y + wb.height + margin) {
          console.warn(`   [OCR] ⚠️ Click (${action.x},${action.y}) is OUTSIDE active window bounds (${wb.x},${wb.y} ${wb.width}x${wb.height}) — skipping to avoid focus loss`);
          actionLog.push({ action: 'blocked', description: `Click (${action.x},${action.y}) outside window bounds — blocked` });
          messages.push({ role: 'user', content: `Your click at (${action.x},${action.y}) is OUTSIDE the active window. Only click elements shown in the snapshot. Try a different element.` });
          continue;
        }
      }

      // 6. Execute the action
      console.log(`   [OCR] Step ${stepCount}: ${action.action} — ${this.describeAction(action)}`);
      actionLog.push({ action: action.action, description: this.describeAction(action) });

      if (action.action === 'done') {
        // Light verification: re-scan and sanity check.
        // Keep it fast — only reject if we're very confident the task isn't done.
        // Max 1 rejection to avoid infinite loops wasting steps.
        this.ocr.invalidateCache();
        const verifyOcr = await this.ocr.recognizeScreen();
        // Normalize screen text: strip commas from numbers, lowercase
        const screenText = verifyOcr.elements.map(el => el.text).join(' ').toLowerCase().replace(/,/g, '');

        // Calculator: skip keyword verification — results only show final answer, not operands
        const isCalcTask = this.currentAppProcess.includes('calc') || /calculator|compute|calculate/i.test(task);
        if (isCalcTask) {
          console.log(`   [OCR] ✅ Done — Calculator task, skipping keyword verification (step ${stepCount})`);
          return {
            handled: true,
            success: true,
            description: `OCR Reasoner completed: ${action.evidence}`,
            steps: stepCount,
            actionLog,
          };
        }

        // Check task keywords (skip noise)
        const NOISE = new Set(['open', 'click', 'type', 'then', 'with', 'select', 'delete', 'press',
          'into', 'from', 'that', 'this', 'should', 'make', 'please', 'text', 'field', 'enter',
          'write', 'compute', 'calculate', 'result', 'keyboard', 'escape', 'clear', 'navigate',
          'plus', 'minus', 'times', 'divided', 'answer', 'number']);
        const taskWords = task.toLowerCase().replace(/,/g, '').split(/\s+/)
          .filter(w => w.length > 3 && !NOISE.has(w) && !/^\d+$/.test(w)); // also skip pure numbers
        const taskMatch = taskWords.length > 0
          ? taskWords.filter(w => screenText.includes(w)).length / taskWords.length
          : 1;

        // Email-specific: reject if compose is still visible
        // Compose indicators: "Send" button + ("Cc"/"Bcc" labels OR "Draft saved" OR "Add a subject")
        const isEmailTask = /send.*email|email.*to|mail.*to/i.test(task);
        const composeStillOpen = isEmailTask && screenText.includes('send') && (
          screenText.includes('cc') && screenText.includes('bcc') ||
          screenText.includes('draft saved') ||
          screenText.includes('add a subject')
        );
        if (composeStillOpen && actionLog.filter(a => a.action === 'done_rejected').length < 2) {
          console.warn(`   [OCR] ⚠️ Email not sent — compose window still open. Rejecting done.`);
          actionLog.push({ action: 'done_rejected', description: 'Email compose still open' });
          messages.push({ role: 'user', content: 'The email has NOT been sent yet — the compose window is still open. You must click the "Send" button (blue button at top-left of compose area) to actually send the email. Do NOT press Return/Enter — that does not send emails. Click the Send button.' });
          continue;
        }

        // Reject if task keywords aren't visible on screen.
        // Allow up to 2 rejections to give the LLM a chance to fix, then accept anyway.
        const doneRejects = actionLog.filter(a => a.action === 'done_rejected').length;
        if (taskMatch < 0.3 && taskWords.length >= 1 && doneRejects < 2) {
          const missing = taskWords.filter(w => !screenText.includes(w)).slice(0, 3);
          console.warn(`   [OCR] ⚠️ Done rejected (${(taskMatch * 100).toFixed(0)}% task match). Missing: ${missing.join(', ')}`);
          actionLog.push({ action: 'done_rejected', description: `${(taskMatch * 100).toFixed(0)}% match — missing: ${missing.join(', ')}` });
          messages.push({ role: 'user', content: `NOT DONE. The text "${missing.join('", "')}" is NOT visible on screen. You must actually complete the task — don't just say done. For Paint: after selecting the Text tool, you must CLICK ON THE WHITE CANVAS AREA (the large blank area in the center of the window) to create a text box, then type the text.` });
          continue;
        }

        console.log(`   [OCR] ✅ Done (task match: ${(taskMatch * 100).toFixed(0)}%, step ${stepCount})`);
        return {
          handled: true,
          success: true,
          description: `OCR Reasoner completed: ${action.evidence}`,
          steps: stepCount,
          actionLog,
        };
      }

      if (action.action === 'cannot_read') {
        cannotReadCount++;
        if (cannotReadCount >= CANNOT_READ_RETRIES) {
          return {
            handled: false,
            success: false,
            description: `OCR cannot read UI: ${action.reason}`,
            steps: stepCount,
            fallbackReason: 'cannot_read',
            actionLog,
          };
        }
        // Retry — maybe the screen changed
        await new Promise(r => setTimeout(r, SETTLE_MS));
        continue;
      }

      // Handle needs_human — task requires human intervention (payment, captcha, 2FA)
      if ((action as any).action === 'needs_human') {
        const reason = (action as any).reason || 'unknown';
        const desc = (action as any).description || reason;
        console.log(`   [OCR] 🙋 NEEDS HUMAN: ${desc}`);
        return {
          handled: false,
          success: false,
          description: desc,
          steps: stepCount,
          needsHuman: true,
          actionLog,
        };
      }

      // Ensure target window has keyboard focus before executing any action
      // (OCR scan + LLM call takes 6-10s, during which other windows can steal focus)
      if (targetWindow) {
        try {
          await this.a11y.focusWindow(undefined, targetWindow.processId).catch(() => {});
          await new Promise(r => setTimeout(r, 100));
        } catch { /* non-fatal */ }
      }

      try {
        const blocked = await this.executeAction(action);
        if (blocked) {
          // Tell the LLM why its action was blocked so it can adjust
          messages.push({ role: 'user', content: blocked });
          actionLog.push({ action: 'blocked', description: blocked });
          continue; // skip settle time, re-enter loop immediately
        }
      } catch (err: any) {
        console.error(`   [OCR] Action failed: ${err.message}`);
        actionLog.push({ action: 'error', description: `Action failed: ${err.message}` });
      }

      // Wait for UI to settle
      await new Promise(r => setTimeout(r, SETTLE_MS));
    }

    // Exceeded max steps
    return {
      handled: false,
      success: false,
      description: `OCR Reasoner exhausted ${MAX_OCR_STEPS} steps without completing`,
      steps: stepCount,
      actionLog,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Build the UI snapshot string from OCR results + a11y tree.
   */
  private buildSnapshot(
    ocrResult: OcrResult,
    a11ySnippet: string,
    a11yElements: UIElement[],
    actionLog: Array<{ action: string; description: string }>,
    task: string,
    priorContext?: string[],
  ): string {
    // Group OCR elements by line for readability, assign sequential element IDs
    let elementId = 0;
    const lines = new Map<number, OcrElement[]>();
    for (const el of ocrResult.elements) {
      const lineEls = lines.get(el.line) ?? [];
      lineEls.push(el);
      lines.set(el.line, lineEls);
    }

    const ocrLines: string[] = [];
    for (const [_lineIdx, lineEls] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
      const parts = lineEls
        .sort((a, b) => a.x - b.x)
        .map(el => {
          const id = elementId++;
          // Pre-compute center coordinates — LLM clicks these directly, no math needed
          const cx = Math.round(el.x + el.width / 2);
          const cy = Math.round(el.y + el.height / 2);
          const conf = el.confidence < 1.0 ? `,conf:${el.confidence.toFixed(2)}` : '';
          // Find matching a11y element — now returns full metadata for unified perception
          const a11yMeta = this.mergeA11yMetadata(el, a11yElements);
          const typeTag = a11yMeta ? `,${a11yMeta.controlType}` : '';
          // Build rich a11y annotation: [name:"Send", id:send-btn]
          let a11yAnnotation = '';
          if (a11yMeta) {
            const parts: string[] = [];
            if (a11yMeta.name) parts.push(`name:"${a11yMeta.name}"`);
            if (a11yMeta.automationId) parts.push(`id:${a11yMeta.automationId}`);
            if (a11yMeta.isEnabled === false) parts.push('DISABLED');
            if (parts.length > 0) a11yAnnotation = ` [${parts.join(', ')}]`;
          }
          return `[${id}] @(${cx},${cy}${conf}${typeTag}) "${el.text}"${a11yAnnotation}`;
        });
      ocrLines.push(parts.join(' | '));
    }

    // Add clickable coordinates for empty interactive elements (Edit, ComboBox, etc.)
    // OCR only finds text — empty input fields have no text → no coordinates.
    // The accessibility tree knows about them, so we fill the gap here.
    const interactiveTypes = new Set(['Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'Button']);
    for (const a11y of a11yElements) {
      const shortType = a11y.controlType.replace('ControlType.', '');
      if (!interactiveTypes.has(shortType)) continue;
      if (a11y.bounds.width <= 0 || a11y.bounds.height <= 0) continue;
      // Skip if an OCR element already covers this area
      const b = a11y.bounds;
      const hasOcrOverlap = ocrResult.elements.some(el => {
        const elCx = el.x + el.width / 2;
        const elCy = el.y + el.height / 2;
        return elCx >= b.x && elCx <= b.x + b.width
            && elCy >= b.y && elCy <= b.y + b.height;
      });
      if (!hasOcrOverlap && a11y.name) {
        const cx = b.x + Math.round(b.width / 2);
        const cy = b.y + Math.round(b.height / 2);
        const idTag = a11y.automationId ? `, id:${a11y.automationId}` : '';
        const enabledTag = a11y.isEnabled === false ? ', DISABLED' : '';
        ocrLines.push(`[${elementId++}] @(${cx},${cy},${shortType}) "${a11y.name}" [name:"${a11y.name}"${idTag}${enabledTag}, empty field]`);
      }
    }

    // Cap snapshot size to fit within LLM context window.
    // Reserve ~3K tokens for system prompt + history + response.
    // Estimate: each OCR line ≈ 50 tokens (text + coordinates + a11y metadata).
    const modelName = (this.pipelineConfig.layer3?.enabled ? this.pipelineConfig.layer3.model : this.pipelineConfig.layer2.model) || '';
    const contextWindow =
      /128k/i.test(modelName) ? 128000 :
      /32k/i.test(modelName)  ? 32000 :
      /16k/i.test(modelName)  ? 16000 :
      /8k/i.test(modelName)   ? 8000 :
      /gpt-4o|claude|gemini|k2/i.test(modelName) ? 128000 :
      32000; // default assumption
    const reservedTokens = 3500; // system prompt + task + history + response
    const maxTokensForElements = contextWindow - reservedTokens;
    const tokensPerLine = 100; // web pages average ~95 tokens/line with rich metadata
    const MAX_SNAPSHOT_LINES = Math.max(20, Math.min(200, Math.floor(maxTokensForElements / tokensPerLine)));
    if (ocrLines.length > MAX_SNAPSHOT_LINES) {
      // Prioritize interactive elements (buttons, inputs, links) over static text.
      // Buttons and form fields are usually what the LLM needs to click.
      const interactive: string[] = [];
      const other: string[] = [];
      for (const line of ocrLines) {
        if (/,Button\)|,Edit\)|,ComboBox\)|,CheckBox\)|,RadioButton\)|,Link\)|empty field\]/.test(line)) {
          interactive.push(line);
        } else {
          other.push(line);
        }
      }
      const remaining = MAX_SNAPSHOT_LINES - interactive.length;
      const kept = [...interactive, ...other.slice(0, Math.max(0, remaining))];
      console.log(`   [OCR] Truncating snapshot: ${ocrLines.length} → ${kept.length} (${interactive.length} interactive + ${kept.length - interactive.length} text)`);
      ocrLines.length = 0;
      ocrLines.push(...kept);
      ocrLines.push(`... (${ocrResult.elements.length - kept.length} more elements — scroll if needed)`);
    }

    const ocrText = ocrLines.length > 0
      ? ocrLines.join('\n')
      : '(no text detected — screen may be blank or contain only images)';

    // Build action history string
    const historyStr = actionLog.length > 0
      ? `\n=== ACTIONS TAKEN SO FAR ===\n${actionLog.map((a, i) => `${i + 1}. ${a.action}: ${a.description}`).join('\n')}`
      : '';

    // Prior context from earlier pipeline stages
    const contextStr = priorContext?.length
      ? `\n=== PRIOR CONTEXT ===\n${priorContext.join('\n')}`
      : '';

    // Calculator expression helper: extract exact digits for the LLM
    let calcHelper = '';
    if (this.currentAppProcess.includes('calc')) {
      const match = task.match(/(\d[\d\s]*[+\-*/×÷]\s*\d[\d\s+\-*/×÷]*)/);
      if (match) {
        const expr = match[1].replace(/\s/g, '').replace(/×/g, '*').replace(/÷/g, '/');
        const keys = expr.split('').map(ch => `key "${ch}"`).join(', ');
        calcHelper = `\n=== CALCULATOR KEYS ===\nExpression: ${expr}\nPress these keys IN ORDER: ${keys}, then key "=" or key "Return"\nDo NOT skip any digit. Each "0" must be its own key press.`;
      }
    }

    return `=== TASK ===
${task}
${contextStr}${calcHelper}
=== SCREEN SNAPSHOT (OCR — coordinates in real screen pixels) ===
${ocrText}
${a11ySnippet}
${historyStr}

What is the SINGLE NEXT ACTION to accomplish this task? Respond with JSON only.`;
  }

  // findA11yMatch has been replaced by mergeA11yMetadata() above — returns full metadata

  /**
   * Parallel A11y capture — bundles getActiveWindow + getScreenContext + findElement.
   * Returns graceful empty on failure (Linux, a11y unavailable, etc.).
   */
  private async captureA11y(targetPid: number): Promise<A11yCaptureResult> {
    try {
      const win = await this.a11y.getActiveWindow().catch(() => null);
      if (!win) return { win: null, tree: null, elements: [] };

      const pid = targetPid || win.processId;
      // Run tree and element fetch in parallel within the a11y capture
      const [tree, rawElements] = await Promise.all([
        this.a11y.getScreenContext(pid).catch(() => null),
        this.a11y.findElement({ processId: pid }).catch(() => []),
      ]);

      const elements: UIElement[] = (Array.isArray(rawElements) ? rawElements : []).map(el => ({
        name: el.name || '',
        automationId: el.automationId || '',
        controlType: el.controlType || '',
        className: el.className || '',
        isEnabled: el.isEnabled,
        bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
      }));

      return { win, tree, elements };
    } catch {
      return { win: null, tree: null, elements: [] };
    }
  }

  /**
   * Enhanced A11y match — returns full metadata instead of just controlType string.
   * Uses bounding-box overlap: A11y element bounds contain the OCR element center.
   */
  private mergeA11yMetadata(el: OcrElement, a11yElements: UIElement[]): A11yMetadata | null {
    const elCx = el.x + el.width / 2;
    const elCy = el.y + el.height / 2;

    for (const a11y of a11yElements) {
      const b = a11y.bounds;
      if (elCx >= b.x && elCx <= b.x + b.width && elCy >= b.y && elCy <= b.y + b.height) {
        const shortType = a11y.controlType.replace('ControlType.', '');
        // Skip generic types that don't add useful info
        if (shortType === 'Text' || shortType === 'Pane' || shortType === 'Custom') continue;
        return {
          controlType: shortType,
          name: a11y.name,
          automationId: a11y.automationId,
          isEnabled: a11y.isEnabled !== false,
        };
      }
    }
    return null;
  }

  /**
   * Call the text LLM for OCR reasoning.
   * Uses layer3 model (Sonnet) for stronger spatial reasoning.
   * Falls back to layer2 model if layer3 is unavailable.
   */
  private async callOcrLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
    const layer3 = this.pipelineConfig.layer3;
    const layer2 = this.pipelineConfig.layer2;
    // Prefer layer3 model (Sonnet) — much better at spatial reasoning from text coordinates
    const model = layer3.enabled ? layer3.model : layer2.model;
    const baseUrl = layer3.enabled ? layer3.baseUrl : layer2.baseUrl;
    const apiKey = this.pipelineConfig.apiKey || '';
    const isAnthropic = !this.pipelineConfig.provider.openaiCompat
      && !baseUrl.includes('localhost')
      && !baseUrl.includes('11434');

    return callTextLLMDirect({
      baseUrl,
      model,
      apiKey,
      isAnthropic,
      messages,
      timeoutMs: 15000, // Keep calls fast — bail on slow responses
      maxTokens: 300,   // OCR actions are short JSON — no need for 500 tokens
      retries: 2,       // Retry on transient errors (rate limits, overloaded)
    });
  }

  /**
   * Apply sliding window to messages: keep system prompt + last N user/assistant pairs.
   * Prevents token budget degradation on long reasoning chains.
   */
  private applyWindow(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
    if (messages.length <= 1 + MAX_CONTEXT_TURNS * 2) return messages;
    // System prompt is always first
    const system = messages[0];
    // Keep last N turn pairs (each pair = user + assistant)
    const recentMessages = messages.slice(-(MAX_CONTEXT_TURNS * 2));
    return [system, ...recentMessages];
  }

  /**
   * Parse an OcrAction from the LLM response string.
   */
  private parseAction(response: string): OcrAction | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.action) return null;

      return parsed as OcrAction;
    } catch {
      return null;
    }
  }

  /**
   * Execute a single OcrAction via NativeDesktop.
   * OCR coordinates are in PHYSICAL screen pixels (from screen.grab()).
   * Mouse API uses LOGICAL pixels on Windows with DPI scaling.
   * physicalToMouse() bridges the gap.
   */
  private async executeAction(action: OcrAction): Promise<string | null> {
    // Taskbar guard: block clicks in the bottom 180 physical pixels (≈60 logical @ 3x DPI)
    if ('x' in action && 'y' in action && (action.action === 'click' || action.action === 'double_click')) {
      const screenH = this.desktop.getScreenSize().height;
      if (screenH > 0 && action.y > screenH - 180) {
        console.warn(`   [OCR] ⚠️ BLOCKED: ${action.action} at y=${action.y} is in taskbar zone (>${screenH - 180})`);
        return `BLOCKED: Your ${action.action} at y=${action.y} is in the taskbar zone (bottom of screen). The taskbar is off-limits. Use keyboard shortcuts instead — for example, press the Windows key to open Start, or use Alt+Tab to switch apps. NEVER click the bottom edge of the screen.`;
      }
    }

    switch (action.action) {
      case 'click': {
        const mc = this.desktop.physicalToMouse(action.x, action.y);
        if (mc.x !== action.x || mc.y !== action.y) {
          console.log(`   [OCR] DPI scale: (${action.x},${action.y}) → mouse (${mc.x},${mc.y})`);
        }
        await this.desktop.mouseClick(mc.x, mc.y);
        this.lastClickCoords = mc; // store in mouse coords for re-click
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;
      }

      case 'double_click': {
        const dc = this.desktop.physicalToMouse(action.x, action.y);
        await this.desktop.mouseDoubleClick(dc.x, dc.y);
        this.lastClickCoords = dc;
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;
      }

      case 'drag': {
        // Taskbar guard for drag actions
        const screenSize = this.desktop.getScreenSize();
        if (screenSize.height > 0 && (action.startY > screenSize.height - 180 || action.endY > screenSize.height - 180)) {
          console.warn(`   [OCR] ⚠️ BLOCKED: drag touches taskbar zone`);
          return 'BLOCKED: Your drag touches the taskbar zone (bottom of screen). Keep all actions within the app window.';
        }
        const ds = this.desktop.physicalToMouse(action.startX, action.startY);
        const de = this.desktop.physicalToMouse(action.endX, action.endY);
        console.log(`   [OCR] Drag: (${action.startX},${action.startY}) → (${action.endX},${action.endY}) [mouse: (${ds.x},${ds.y}) → (${de.x},${de.y})]`);
        await this.desktop.mouseDrag(ds.x, ds.y, de.x, de.y);
        this.ocr.invalidateCache();
        break;
      }

      case 'type': {
        // Calculator: clipboard paste strips operators (+,-,*,/). Send individual keystrokes instead.
        const isCalc = this.currentAppProcess.includes('calc');
        if (isCalc) {
          console.log(`   [OCR] Calculator detected — typing "${action.text}" as individual key presses`);
          for (const char of action.text) {
            if (char === ' ') continue; // skip spaces
            await this.desktop.keyPress(char);
            await new Promise(r => setTimeout(r, 60));
          }
        } else {
          // Clipboard paste for reliability
          await this.a11y.writeClipboard(action.text);
          await new Promise(r => setTimeout(r, 50));
          await this.desktop.keyPress('ctrl+v');
          await new Promise(r => setTimeout(r, 300)); // 300ms to allow autocomplete resolution in email fields
          // Post-type verification: check focused element contains typed text (best-effort)
          try {
            const focused = await this.a11y.getFocusedElement?.();
            if (focused?.value && !focused.value.includes(action.text.substring(0, 10))) {
              console.warn(`   [OCR] ⚠️ Type verification: focused element doesn't contain typed text (has "${focused.value.substring(0, 30)}")`);
            }
          } catch { /* non-fatal */ }
        }
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;
      }

      case 'key': {
        // Defensive: if LLM sends multi-char key like "144", split into individual presses
        const keyStr = action.key;
        if (/^\d{2,}$/.test(keyStr)) {
          console.log(`   [OCR] Multi-digit key "${keyStr}" — splitting into individual presses`);
          for (const digit of keyStr) {
            await this.desktop.keyPress(digit);
            await new Promise(r => setTimeout(r, 60));
          }
        } else {
          await this.desktop.keyPress(keyStr);
        }
        // Clear lastClickCoords after keyboard navigation (Tab, Enter, etc.)
        // so the next type action won't re-click a stale target (e.g., "New Mail" button)
        this.lastClickCoords = null;
        this.a11y.invalidateCache();
        this.ocr.invalidateCache();
        break;
      }

      case 'scroll': {
        const delta = action.direction === 'down' ? action.amount : -action.amount;
        const sc = this.desktop.physicalToMouse(action.x, action.y);
        await this.desktop.mouseScroll(sc.x, sc.y, delta);
        this.ocr.invalidateCache();
        break;
      }

      case 'wait':
        await new Promise(r => setTimeout(r, action.ms));
        this.ocr.invalidateCache();
        break;

      case 'a11y_click': {
        // UIA InvokePattern — most reliable, no mouse coordinates needed
        // 5s timeout to prevent PSBridge hangs from eating the entire task budget
        const A11Y_TIMEOUT_MS = 5000;
        try {
          const invokePromise = this.a11y.invokeElement({
            name: action.name,
            automationId: action.automationId,
            // Don't prefix — PSBridge handles the ControlType enum mapping.
            // LLM sends "Button", "Edit", etc. — pass as-is.
            controlType: action.controlType || undefined,
            action: 'click',
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('a11y_click timeout')), A11Y_TIMEOUT_MS)
          );
          const invokeResult = await Promise.race([invokePromise, timeoutPromise]);
          if (invokeResult.success) {
            console.log(`   [A11Y] ✅ a11y_click "${action.name}" succeeded via UIA`);
            this.a11y.invalidateCache();
            this.ocr.invalidateCache();
            break;
          }
          // Fallback: mouse click at element bounds center
          if (invokeResult.clickPoint) {
            const mc = this.desktop.physicalToMouse(invokeResult.clickPoint.x, invokeResult.clickPoint.y);
            console.log(`   [A11Y] UIA invoke failed, falling back to mouse click at (${mc.x},${mc.y})`);
            await this.desktop.mouseClick(mc.x, mc.y);
            this.a11y.invalidateCache();
            this.ocr.invalidateCache();
            break;
          }
          return `a11y_click failed for "${action.name}" — try clicking by coordinates instead`;
        } catch (e: any) {
          console.warn(`   [A11Y] ⚠️ a11y_click "${action.name}" timed out (${A11Y_TIMEOUT_MS}ms) — try coordinates instead`);
          return `a11y_click timed out for "${action.name}" after ${A11Y_TIMEOUT_MS}ms — use click with coordinates instead`;
        }
      }

      case 'a11y_set_value': {
        const A11Y_SV_TIMEOUT_MS = 5000;
        try {
          const svPromise = this.a11y.invokeElement({
            name: action.name,
            controlType: action.controlType || undefined,
            action: 'set-value',
            value: action.value,
          });
          const svTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('a11y_set_value timeout')), A11Y_SV_TIMEOUT_MS)
          );
          const setResult = await Promise.race([svPromise, svTimeout]);
          if (setResult.success) {
            console.log(`   [A11Y] ✅ a11y_set_value "${action.name}" = "${(action.value ?? '').substring(0, 30)}" succeeded`);
            this.a11y.invalidateCache();
            this.ocr.invalidateCache();
            break;
          }
          return `a11y_set_value failed for "${action.name}" — try clicking the field and using type action instead`;
        } catch (e: any) {
          console.warn(`   [A11Y] ⚠️ a11y_set_value "${action.name}" timed out — try click + type instead`);
          return `a11y_set_value timed out for "${action.name}" — click the field and use type action instead`;
        }
      }

      case 'done':
      case 'cannot_read':
        // No execution needed — handled by caller
        break;

      default: {
        // Handle needs_human and any unknown actions
        const anyAction = action as any;
        if (anyAction.action === 'needs_human') break; // handled by caller
        console.warn(`   [OCR] Unknown action: ${anyAction.action}`);
        break;
      }
    }
    return null;
  }

  /**
   * Human-readable description of an action.
   */
  private describeAction(action: OcrAction): string {
    switch (action.action) {
      case 'click': return `${action.description} at (${action.x},${action.y})`;
      case 'double_click': return `${action.description} at (${action.x},${action.y})`;
      case 'drag': return `${action.description} (${action.startX},${action.startY}) → (${action.endX},${action.endY})`;
      case 'type': return `${action.description}: "${action.text.substring(0, 50)}"`;
      case 'key': return `${action.description}: ${action.key}`;
      case 'scroll': return `Scroll ${action.direction} ${action.amount} at (${action.x},${action.y})`;
      case 'wait': return `Wait ${action.ms}ms: ${action.reason}`;
      case 'done': return `Done: ${action.evidence}`;
      case 'cannot_read': return `Cannot read: ${action.reason}`;
      case 'a11y_click': return `a11y_click "${action.name}" (${action.controlType ?? 'unknown'}): ${action.description}`;
      case 'a11y_set_value': return `a11y_set_value "${action.name}" = "${(action.value ?? '').substring(0, 30)}": ${action.description}`;
      default: return `${(action as any).action}: ${(action as any).description ?? 'unknown'}`;
    }
  }
}
