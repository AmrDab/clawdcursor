/**
 * Accessibility Reasoner — Layer 2.
 *
 * "Blind man" navigation: reads the a11y tree, decides an action, executes it,
 * re-reads the tree, verifies progress, repeats — until done or unsure.
 *
 * Key changes vs v0.6.3:
 *  - Real verify loop (read → act → read again → confirm) instead of one-shot
 *  - Cache is invalidated before every read so the LLM never sees stale state
 *  - "done" response requires explicit evidence from the UI tree
 *  - NativeDesktop injected so the reasoner can execute actions itself
 *  - Falls through to vision only when genuinely stuck
 */

import * as fs from 'fs';
import * as path from 'path';
import { AccessibilityBridge } from './accessibility';
import { A11yClickResolver } from './a11y-click-resolver';
import { NativeDesktop } from './native-desktop';
import type { PipelineConfig } from './providers';
import type { InputAction, A11yAction } from './types';
import { CDPDriver } from './cdp-driver';

const MAX_LOOP_STEPS = 50;  // text LLM stays in control — vision is its coordinate tool
const SETTLE_MS      = 300; // wait after action before re-reading tree
const BROWSER_PROCESS_RE = /msedge|chrome|chromium/i; // shared regex — avoids duplicating in 4+ places
const MAX_ACTION_HISTORY = 40; // cap action history to prevent unbounded growth

const SYSTEM_PROMPT = `You control a Windows desktop via the accessibility tree and keyboard. You are an AUTONOMOUS REASONING AGENT. At EVERY step you must:
1. READ the current UI state carefully
2. THINK about what you see vs what the task requires
3. DECIDE what action brings you closer to completion
4. ACT — then loop back to step 1

You are NOT a command executor. You REASON about the task and COMPOSE original content when needed.

══════════════════════════════════════════
DECISION TREE — follow in strict order
══════════════════════════════════════════

① WRONG APP? (check first, every step)
   If the process is completely wrong (e.g. you're in Notepad but need Edge):
   → {"action":"needs_human","reason":"wrong_window","description":"Focused is [wrong process], need [target]"}
   If you're in the RIGHT app but on the WRONG page/tab/document:
   → FIX IT YOURSELF. Navigate, click, use File > New, etc.
   → NEVER return needs_human when you can navigate or interact to get to the right place.
   → You are a capable agent — solve navigation problems, don't ask for help.

② TASK COMPLETE?
   Does UI state NOW confirm the task is FULLY done? ALL parts of the task must be verified.
   → {"action":"done","evidence":"specific text or element that proves completion"}
   Evidence must be CONCRETE PROOF visible on screen. Examples:
   - "write a sentence on dogs" → evidence must quote THE ACTUAL SENTENCE you typed, visible in the document
   - "search for flights" → evidence: flight results are displayed on the page
   - "send email" → evidence: sent confirmation or compose window closed
   CRITICAL RULES for done:
   - NEVER declare done just because you navigated somewhere. The task actions must be COMPLETED.
   - NEVER declare done if you haven't performed the core action (writing, clicking, typing, etc.)
   - If the task says "write" — you must have COMPOSED and TYPED actual text. Just opening a doc is NOT done.
   - If the task says "in a new document" — you must have CREATED a new document first.

② B. CONTENT GENERATION
   When a task asks you to "write", "compose", "draft", or "create" text content:
   → You must INVENT and TYPE original content yourself. You are a language model — generate the text!
   → Use {"action":"type","text":"Your composed sentence or paragraph here","description":"typing composed content"}
   → Example: task "write a sentence on dogs" → {"action":"type","text":"Dogs are loyal companions that have been by humanity's side for thousands of years.","description":"composing and typing a sentence about dogs"}
   → Do NOT type the task instruction literally (e.g. do NOT type "a sentence on dogs")
   → Do NOT declare done without having typed the content

③ MISSING INFO?
   Missing a password / 2FA / payment card → {"action":"needs_human","reason":"...","description":"..."}
   Missing a travel parameter or destination → use the app's discovery feature (e.g. Explore), do NOT ask human.

④ SELECT ACTION APPROACH (first match wins):
   CDP PAGE CONTEXT shown (browser) → MANDATORY: use cdp_click / cdp_type ONLY.
     NEVER use a11y_click/a11y_set_value/a11y_focus on browser pages — they CRASH.
     NEVER spam key_press (F5/Escape/Tab/Return) — use cdp_click on visible elements.
     Click buttons/links by their text with cdp_click by_text.
     Type in fields with cdp_type by_label or selector.
     Need to READ page text (info retrieval) → cdp_read_text selector="body" (or a specific selector).
     If a search is already in the URL params, the results are ALREADY SHOWING → declare done.
   WebView2/Electron (empty Panes, ControlType.Pane only) → keyboard shortcuts ONLY, no a11y_click
   Native app with element in UI TREE → a11y_click / a11y_set_value / a11y_focus
   Element not in tree → Tab/Shift+Tab/Enter/Arrow or need_visual for coordinates
   Nothing works after 3 different approaches → need_visual once, then continue

══════════════════════════════════════════
ACTIONS — return exactly ONE as JSON
══════════════════════════════════════════
{"action":"a11y_click","name":"Button Name","controlType":"Button","description":"why"}
{"action":"a11y_set_value","name":"Field Name","controlType":"Edit","value":"text","description":"why"}
{"action":"a11y_focus","name":"Element","controlType":"Edit","description":"why"}
{"action":"key_press","key":"Tab|Return|Escape|ctrl+s|ctrl+n|ctrl+Return|alt|F10|...","description":"why"}
{"action":"type","text":"text including \\n for newlines","description":"why"}
{"action":"need_visual","target":"exact element name","description":"why keyboard cannot reach it"}
{"action":"cdp_click","selector":"[aria-label='X']","description":"why"}
{"action":"cdp_click","by_text":"Button Label","description":"why"}
{"action":"cdp_type","by_label":"Field Label","text":"value","description":"why"}
{"action":"cdp_type","selector":"[aria-label='X']","text":"value","description":"why"}
{"action":"cdp_read_text","selector":"body","description":"read visible text from page or element (for info retrieval)"}
{"action":"cdp_scroll","direction":"down","amount":600,"description":"scroll page down 600px — use to reveal more content or posts"}
{"action":"cdp_scroll","direction":"up","amount":400,"selector":"#feed","description":"scroll a specific element"}
{"action":"checkpoint","description":"verify current page state"}
{"action":"switch_app","app":"notepad|excel|edge|outlook|...","description":"why you need to switch"}
{"action":"done","evidence":"concrete proof task is complete"}
{"action":"needs_human","reason":"payment|captcha|password|2FA|wrong_window","description":"exactly what human must do"}

══════════════════════════════════════════
HARD CONSTRAINTS
══════════════════════════════════════════
• Never repeat a failed action — different approach every time
• Never click taskbar buttons, window title bars, or unnamed Panes (throws RPC errors)
• Never press Alt+Tab or Win key — use {"action":"switch_app","app":"notepad"} to switch apps deterministically
• After action history shows SUCCEEDED / ALREADY DONE → move to next step, do NOT repeat
• checkpoint: use only once to orient after a page load. If CDP is unavailable, do NOT call checkpoint again.
• need_visual is a coordinate lookup, NOT page exploration. UI STATE already describes the page.
• Return ONLY valid JSON — no markdown, no text outside the JSON object
• If APP KNOWLEDGE BASE is present for this app, follow its patterns exactly`;



interface ActionRecord {
  action: string;
  description: string;
}

interface ReasonerResult {
  handled: boolean;
  description: string;
  unsure?: boolean;
  needsHuman?: boolean; // task requires human intervention (payment, captcha, 2FA)
  steps?: number; // how many a11y steps were taken
  actionHistory?: ActionRecord[]; // actions attempted, for Layer 3 context
}

export class A11yReasoner {
  private a11y: AccessibilityBridge;
  private clickResolver: A11yClickResolver;
  private desktop: NativeDesktop;
  private pipelineConfig: PipelineConfig;
  private failuresByApp: Map<string, number> = new Map();
  private readonly MAX_FAILURES = 5;
  private disabledApps: Set<string> = new Set();
  private visionOnlySubtaskCount = 0;
  private readonly VISION_RECOVERY_THRESHOLD = 3;
  private appKnowledge: string = '';
  private cdpDriver: CDPDriver | null = null;
  private cdpAvailable: boolean | null = null; // null=unknown, false=unavailable, true=connected
  private uiaDisabled = false; // set true after RPC_E_SERVERFAULT — skip all UIA reads

  constructor(a11y: AccessibilityBridge, desktop: NativeDesktop, pipelineConfig: PipelineConfig) {
    this.a11y = a11y;
    this.clickResolver = new A11yClickResolver(a11y);
    this.desktop = desktop;
    this.pipelineConfig = pipelineConfig;
    this.loadAppKnowledge();
  }

  private loadAppKnowledge(): void {
    try {
      const kbPath = path.join(__dirname, '..', 'docs', 'app-knowledge.md');
      this.appKnowledge = fs.readFileSync(kbPath, 'utf-8');
    } catch (err) {
      console.debug(`[A11yReasoner] App knowledge not loaded: ${err}`);
      this.appKnowledge = '';
    }
  }

  /** Extract relevant sections from the knowledge base for the active app/task */
  private getRelevantKnowledge(processName?: string, task?: string, currentUrl?: string): string {
    if (!this.appKnowledge) return '';

    const sections: string[] = [];
    const lines = this.appKnowledge.split('\n');

    // Always include General Rules
    let inSection = false;
    let currentSection = '';
    let includeSection = false;

    for (const line of lines) {
      const h2Match = line.match(/^## (.+)/);
      if (h2Match) {
        // Save previous section if included
        if (includeSection && currentSection.trim()) {
          sections.push(currentSection.trim());
        }
        currentSection = line + '\n';
        const title = h2Match[1].toLowerCase();

        // Always include General Rules and Troubleshooting
        includeSection = title.includes('general rules') || title.includes('troubleshooting');

        // Include app-specific sections
        if (processName) {
          const pn = processName.toLowerCase();
          if (pn === 'olk' && title.includes('outlook')) includeSection = true;
          if (pn === 'msedge' && (title.includes('edge') || title.includes('outlook'))) includeSection = true;
          if (pn === 'notepad' && title.includes('notepad')) includeSection = true;
          if (pn === 'mspaint' && title.includes('paint')) includeSection = true;
        }

        // Include based on task keywords
        if (task) {
          const tl = task.toLowerCase();
          if (/email|mail|outlook/i.test(tl) && title.includes('outlook')) includeSection = true;
          if (/browser|edge|chrome|web/i.test(tl) && title.includes('edge')) includeSection = true;
          if (/notepad|text.*file/i.test(tl) && title.includes('notepad')) includeSection = true;
          if (/paint|draw/i.test(tl) && title.includes('paint')) includeSection = true;
          if (/flight|flights|fly|airline|google flights/i.test(tl) && title.includes('google flights')) includeSection = true;
          if (/tripadvisor/i.test(tl) && (title.includes('tripadvisor') || title.includes('google flights'))) includeSection = true;
          if (/google docs|docs\.google|document|write.*sentence|compose/i.test(tl) && title.includes('google docs')) includeSection = true;
        }

        // URL-based section selection — most accurate for browser tabs
        if (currentUrl) {
          const url = currentUrl.toLowerCase();
          if (url.includes('google.com/travel/flights') || url.includes('flights.google.com')) {
            if (title.includes('google flights')) includeSection = true;
          }
          if (url.includes('tripadvisor.com')) {
            if (title.includes('tripadvisor') || title.includes('google flights')) includeSection = true;
          }
          if (url.includes('docs.google.com')) {
            if (title.includes('google docs')) includeSection = true;
          }
        } else if (processName === 'msedge') {
          // Fallback when URL unknown: include both for msedge
          if (title.includes('google flights')) includeSection = true;
        }

        inSection = true;
        continue;
      }

      if (inSection) {
        currentSection += line + '\n';
      }
    }
    // Don't forget the last section
    if (includeSection && currentSection.trim()) {
      sections.push(currentSection.trim());
    }

    return sections.length > 0 ? '\n\nAPP KNOWLEDGE BASE:\n' + sections.join('\n\n') : '';
  }

  isAvailable(processName?: string): boolean {
    if (!this.pipelineConfig.layer2.enabled) return false;
    if (processName && this.disabledApps.has(processName.toLowerCase())) return false;
    return true;
  }

  reset(processName?: string): void {
    if (processName) {
      const key = processName.toLowerCase();
      this.disabledApps.delete(key);
      this.failuresByApp.delete(key);
    } else {
      this.disabledApps.clear();
      this.failuresByApp.clear();
    }
    this.visionOnlySubtaskCount = 0;
    // Reset CDP connection state between tasks
    this.cdpDriver = null;
    this.cdpAvailable = null;
    this.uiaDisabled = false;
  }

  /** Call after a subtask is handled by vision — tracks for auto-recovery */
  recordVisionFallback(): void {
    this.visionOnlySubtaskCount++;
    if (this.visionOnlySubtaskCount >= this.VISION_RECOVERY_THRESHOLD) {
      console.log(`   🔄 Layer 2 auto-recovery: re-enabling after ${this.visionOnlySubtaskCount} vision-only subtasks`);
      this.disabledApps.clear();
      this.failuresByApp.clear();
      this.visionOnlySubtaskCount = 0;
    }
  }

  /**
   * Try to complete a subtask using only the accessibility tree.
   * Loops: read → act → verify → repeat.
   * Returns { handled: false } when it cannot proceed → caller uses vision.
   */
  async reason(subtask: string, processName?: string, priorContext?: string[], logger?: import('./task-logger').TaskLogger, verifier?: import('./verifiers').TaskVerifier): Promise<ReasonerResult> {
    if (!this.isAvailable(processName)) {
      return { handled: false, description: 'Layer 2 disabled' };
    }

    const actionHistory: ActionRecord[] = [];
    // Seed action history with prior context so the LLM sees it
    if (priorContext && priorContext.length > 0) {
      for (const ctx of priorContext) {
        actionHistory.push({ action: 'context', description: ctx });
      }
    }
    let stepsTotal = 0;

    let isLikelyBrowser = BROWSER_PROCESS_RE.test(processName || '');

    for (let step = 0; step < MAX_LOOP_STEPS; step++) {
      try {
        // Always read fresh — cache is invalidated by caller after each action
        // and here before each read to guarantee freshness
        this.a11y.invalidateCache();
        let context: string | null = null;

        // Wrong-window detection: if terminal/explorer has focus but we need a browser, auto-focus the target
        if (step === 0 && processName && actionHistory.filter(a => a.action !== 'context').length === 0) {
          try {
            const focusedEl = await this.a11y.getFocusedElement().catch(() => null);
            if (focusedEl && focusedEl.processId) {
              const windows = await this.a11y.getWindows().catch(() => []);
              const focusedWin = windows.find(w => w.processId === focusedEl.processId);
              const focusedProc = (focusedWin?.processName || '').toLowerCase();
              const targetProc = processName.toLowerCase();
              const NON_TARGET_PROCS = ['windowsterminal', 'cmd', 'powershell'];
              const isWrongWindow = focusedProc.length > 0 &&
                                    NON_TARGET_PROCS.some(p => focusedProc.includes(p)) &&
                                    !focusedProc.includes(targetProc);
              if (isWrongWindow) {
                // Auto-fix: find and focus the target window instead of returning needs_human
                const targetWin = windows.find(w => w.processName.toLowerCase().includes(targetProc) && !w.isMinimized);
                if (targetWin) {
                  console.log(`   🔄 Wrong window: focused=${focusedProc}, auto-focusing ${targetProc} (pid ${targetWin.processId})`);
                  await this.a11y.focusWindow(undefined, targetWin.processId).catch(() => null);
                  await this.delay(800); // let focus settle
                  actionHistory.push({ action: 'context', description: `Auto-focused ${targetProc} window. It is now the active window.` });
                } else {
                  console.log(`   ⚠️ Wrong window: focused=${focusedProc}, target=${targetProc} not found — returning needs_human`);
                  return {
                    handled: false,
                    description: `Wrong window: focused on ${focusedProc} but target ${targetProc} not found in window list.`,
                    needsHuman: true,
                    steps: 0,
                    actionHistory,
                  };
                }
              }
            }
          } catch { /* non-critical — continue */ }
        }

        // Pre-flight: On step 0, connect CDP and find the right tab
        if (step === 0 && processName && BROWSER_PROCESS_RE.test(processName)) {
          try {
            const cdp = this.cdpDriver ?? new CDPDriver(9222);
            if (!this.cdpDriver) this.cdpDriver = cdp;
            const connected = await cdp.isConnected().catch(() => false) || await cdp.connect().catch(() => false);
            if (connected) {
              this.cdpAvailable = true;

              // Check if we're on the right tab — priorContext may say "Navigated to X"
              const navigatedUrl = actionHistory
                .filter(a => a.action === 'context')
                .map(a => a.description.match(/[Nn]avigated to (\S+)/)?.[1])
                .find(u => u);
              if (navigatedUrl) {
                const currentUrl = await cdp.getUrl().catch(() => '') || '';
                // Use full path for matching (not just domain) to avoid google.com/mail matching google.com/travel
                const navPath = navigatedUrl.replace(/^https?:\/\//, '');
                // Also try a shorter domain+path match to handle URL redirects
                // e.g., en.wikipedia.org/wiki/Mars_(planet) → en.wikipedia.org/wiki/Mars
                const navDomain = navPath.split('/')[0]; // e.g., "en.wikipedia.org"
                const urlMatchesExact = currentUrl.includes(navPath);
                const urlMatchesDomain = currentUrl.includes(navDomain) && !currentUrl.includes('google.com/search');
                if (!urlMatchesExact && !urlMatchesDomain) {
                  // CDP is on wrong tab — try to find the exact URL tab first
                  const switched = await cdp.switchToTabByUrl(navPath);
                  if (switched) {
                    // Found and switched — wait for page to be fully loaded
                    try {
                      const pg = cdp.getPage();
                      if (pg) await pg.waitForLoadState('domcontentloaded', { timeout: 5000 });
                    } catch { /* non-critical */ }
                  } else {
                    // Tab not found — try disconnecting and reconnecting CDP to pick up new tabs
                    console.log(`   🔄 CDP on wrong tab (${currentUrl.substring(0, 50)}), reconnecting CDP to find new tabs...`);
                    try {
                      await cdp.disconnect();
                      const reconnected = await cdp.connect();
                      if (reconnected) {
                        // Check again after reconnect — the new tab might now be the active page
                        const newUrl = await cdp.getUrl().catch(() => '') || '';
                        if (!newUrl.includes(navPath)) {
                          // Still wrong — try switchToTabByUrl again with fresh connection
                          const switched2 = await cdp.switchToTabByUrl(navPath);
                          if (!switched2) {
                            // Last resort: open a fresh tab and navigate there
                            // Don't navigate the current page — it may be a system widget with JS disabled
                            console.log(`   🔄 Still wrong tab after reconnect, opening new tab to https://${navPath}`);
                            try {
                              const pg = cdp.getPage();
                              if (pg) {
                                const ctx = pg.context();
                                const newTab = await ctx.newPage();
                                await newTab.goto(`https://${navPath}`, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
                                await newTab.bringToFront().catch(() => {});
                                cdp.attachToPage(newTab);
                              }
                            } catch { /* non-critical */ }
                          }
                        }
                      }
                    } catch { /* non-critical */ }
                    await this.delay(1000); // extra settle
                  }
                } else {
                  // URL matches — ensure page is fully loaded before reading
                  try {
                    const pg = cdp.getPage();
                    if (pg) await pg.waitForLoadState('domcontentloaded', { timeout: 5000 });
                  } catch { /* non-critical */ }
                }
              }

              const [startUrl, startTitle] = await Promise.all([
                cdp.getUrl().catch(() => ''),
                cdp.getTitle().catch(() => ''),
              ]);
              if (startUrl) {
                actionHistory.push({ action: 'context', description: `STARTING STATE: URL="${startUrl}" Title="${startTitle}". Do NOT call checkpoint — URL already known.` });
              }
            }
          } catch { /* non-critical */ }
        }

        // For browser windows, UIA calls can HANG indefinitely on React SPAs.
        // Try CDP first — if it works, skip UIA entirely to avoid deadlock.
        if (isLikelyBrowser && this.cdpAvailable !== false) {
          const cdpCtx = await this.getCdpContext();
          if (cdpCtx) {
            // CDP has the page — no need to touch the hanging UIA tree
            context = `[Browser window — using CDP DOM context instead of UIA tree]${cdpCtx}`;
          }
        }

        if (!context) {
          // Only hard-skip UIA if explicitly disabled (confirmed RPC crash on browser)
          if (this.uiaDisabled) {
            context = null;
          } else {
          // Non-browser OR CDP unknown — read UIA tree with timeout to avoid hang
          try {
            const uiaPromise = (async () => {
              const activeWindow = await this.a11y.getActiveWindow();
              return this.a11y.getScreenContext(activeWindow?.processId);
            })();
            let timeoutHandle: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<null>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error('UIA read timeout')), isLikelyBrowser ? 8000 : 30000);
            });
            try {
              context = await Promise.race([uiaPromise, timeoutPromise]) as string | null;
            } finally {
              clearTimeout(timeoutHandle!);
            }
          } catch (uiaErr) {
            // Window may have closed (e.g. compose window after Send) — check if we already completed the task
            const sentEmail = actionHistory.some(a =>
              (a.action === 'need_visual' && /send/i.test(a.description) && a.description.includes('SUCCEEDED')) ||
              (a.action === 'key_press' && /ctrl\+Return|ctrl\+Enter/i.test(a.description) && a.description.includes('SUCCEEDED')));
            if (sentEmail) {
              console.log(`   ✅ Layer 2 done (${stepsTotal} steps): window closed after Send`);
              if (processName) this.failuresByApp.delete(processName.toLowerCase());
              this.visionOnlySubtaskCount = 0;
              return { handled: true, description: `Done (a11y ${stepsTotal} steps): Send clicked, compose window closed`, steps: stepsTotal };
            }
            if (String(uiaErr).includes('timeout')) {
              console.log(`   ⚠️ UIA read timed out — browser window likely React SPA`);
            }
            context = null;
          }
          } // end else (UIA attempt)
        }

        if (!context || context.includes('unavailable')) {
          // If we have significant action history, provide it as context instead of giving up
          if (actionHistory.length >= 3) {
            context = `[A11y tree unavailable — window may have changed. Action history: ${actionHistory.map(a => a.description).join('; ')}]`;
          } else {
            return { handled: false, description: 'Accessibility tree unavailable' };
          }
        }

        // Separate context entries from real action history
        const contextEntries = actionHistory.filter(a => a.action === 'context');
        const realHistory = actionHistory.filter(a => a.action !== 'context');

        const historyNote = realHistory.length > 0
          ? `\nACTIONS TAKEN SO FAR:\n${realHistory.map((a, i) => `${i + 1}. ${a.description}`).join('\n')}\n`
          : '';

        // Put context at the END of the message (after UI state) for maximum LLM attention
        const contextNote = contextEntries.length > 0
          ? `\n\nIMPORTANT CONTEXT (follow these instructions):\n${contextEntries.map(c => `- ${c.description}`).join('\n')}`
          : '';

        // Get the active process name and current URL for knowledge lookup
        const activeWin = await this.a11y.getActiveWindow().catch(() => null);
        const activeProc = activeWin?.processName || processName;
        const currentUrl = (this.cdpDriver && this.cdpAvailable === true)
          ? await this.cdpDriver.getUrl().catch(() => undefined)
          : undefined;
        const knowledge = this.getRelevantKnowledge(activeProc, subtask, currentUrl ?? undefined);

        const userMessage = `TASK: ${subtask}${historyNote}\n\nCURRENT UI STATE:\n${context}${knowledge}${contextNote}`;

        // Log context source on step 0 for diagnostics
        if (step === 0) {
          const ctxType = context?.includes('CDP PAGE CONTEXT') ? 'CDP' : context?.includes('ControlType') ? 'UIA' : 'OTHER';
          console.log(`   📋 Context: ${ctxType} (${(context || '').length} chars)`);
        }

        const response = await this.callTextModel(userMessage);

        const parsed = this.parseResponse(response, step + 1);
        logger?.logStep({
          layer: 2,
          actionType: parsed.action,
          result: 'success',
          actionParams: { name: parsed.name, key: parsed.key, text: parsed.text?.substring(0, 80), selector: parsed.selector, by_text: parsed.by_text },
          llmReasoning: parsed.description || parsed.evidence,
        });
        logger?.recordLlmCall();

        // ── No-progress loop detector ──
        // Build a semantic signature for this action (action + target)
        const loopSig = `${parsed.action}|${parsed.app || parsed.name || parsed.by_text || parsed.selector || parsed.key || ''}`.toLowerCase();
        const recentActions = actionHistory.slice(-8);

        // Special handling for switch_app: count by action type alone (LLM uses varying app names)
        let sameActionCount: number;
        if (parsed.action === 'switch_app') {
          sameActionCount = recentActions.filter(a => a.action === 'switch_app').length;
        } else {
          const recentSigs = recentActions.map(a => {
            const parts = a.description.match(/^(\S+)\s+"([^"]*)"/);
            return parts ? `${parts[1]}|${parts[2]}`.toLowerCase() : a.description.substring(0, 40).toLowerCase();
          });
          sameActionCount = recentSigs.filter(s => s === loopSig).length;
        }
        if (sameActionCount >= 3 && parsed.action !== 'done' && parsed.action !== 'needs_human' && parsed.action !== 'checkpoint') {
          const msg = parsed.action === 'switch_app'
            ? `LOOP DETECTED — you called switch_app ${sameActionCount + 1} times in the last 8 actions. The window IS focused but the UI tree shows another app because of how Windows renders focus. STOP calling switch_app. Instead, use cdp_read_text to read the browser page (CDP is connected), or use cdp_click/cdp_type to interact with it. If you already have the information you need from a previous cdp_read_text, switch to Notepad and type the answer.`
            : `LOOP DETECTED — you repeated "${loopSig}" ${sameActionCount + 1} times in the last 8 actions with NO progress. Try a COMPLETELY DIFFERENT approach. If clicking a link doesn't work, try navigating via address bar. If a button doesn't respond, try a keyboard shortcut. Think step by step about what is actually wrong.`;
          actionHistory.push({ action: 'blocked', description: msg });
          console.log(`   🔄 Loop detected: "${parsed.action}" repeated ${sameActionCount + 1}x — forcing different approach`);
          continue;
        }

        if (parsed.action === 'needs_human') {
          const reason = parsed.reason || parsed.description || 'Human intervention required';

          // If LLM says "wrong_window" but we're on the correct browser process,
          // it's actually a wrong-page/wrong-tab issue — push back and let it navigate
          if (/wrong_window/i.test(reason) && isLikelyBrowser && this.cdpAvailable === true) {
            const wrongWindowRetries = actionHistory.filter(a => a.action === 'blocked' && a.description.includes('NOT wrong_window')).length;
            if (wrongWindowRetries < 3) {
              actionHistory.push({ action: 'blocked', description: `NOT wrong_window — you ARE in the browser. Navigate to the correct page yourself. Use key_press ctrl+l to open address bar, type the URL, press Return. Or use File > New to create a new document. DO NOT return needs_human again.` });
              console.log(`   🚫 Blocked needs_human (wrong_window on correct browser) — pushing back to LLM`);
              continue;
            }
          }

          console.log(`   🙋 Needs human: ${reason}`);
          return {
            handled: false,
            description: `Needs human: ${reason}\n${parsed.description || ''}`.trim(),
            needsHuman: true,
            steps: stepsTotal,
            actionHistory,
          };
        }

        if (parsed.action === 'need_visual') {
          const visualHintsUsed = actionHistory.filter(a => a.action === 'need_visual').length;
          if (visualHintsUsed >= 15) {
            console.log(`   🛑 Layer 2: max visual hints (15) — stopping`);
            return { handled: false, description: `Max visual hints used: ${parsed.description}`, unsure: true, steps: stepsTotal, actionHistory };
          }

          const targetKey = (parsed.target || '').toLowerCase().trim();

          // Loop detection: same target already clicked successfully
          const alreadyClicked = actionHistory.some(
            a => a.action === 'need_visual' && a.description.includes('SUCCEEDED') &&
                 a.description.toLowerCase().includes(targetKey.substring(0, 12))
          );
          if (alreadyClicked) {
            actionHistory.push({ action: 'need_visual', description: `ALREADY CLICKED "${parsed.target}" — proceed to NEXT step.` });
            continue;
          }

          // Failure loop: same target failed 2+ times
          const failCount = actionHistory.filter(
            a => a.action === 'need_visual' && a.description.includes('not found') &&
                 a.description.toLowerCase().includes(targetKey.substring(0, 10))
          ).length;
          if (failCount >= 2) {
            actionHistory.push({ action: 'need_visual', description: `"${parsed.target}" NOT FOUND after ${failCount} tries. Use key_press or type instead.` });
            continue;
          }

          // Try a11y bounds first (0ms, 0 LLM cost)
          const boundsCoord = await this.clickResolver.resolve(parsed.target);
          if (boundsCoord) {
            console.log(`   📐 Bounds click: "${parsed.target}" at (${boundsCoord.x}, ${boundsCoord.y})`);
            await this.desktop.mouseClick(boundsCoord.x, boundsCoord.y);
            stepsTotal++;
            actionHistory.push({ action: 'need_visual', description: `Clicked "${parsed.target}" at (${boundsCoord.x}, ${boundsCoord.y}) via bounds — SUCCEEDED. Move to next step.` });
            this.a11y.invalidateCache();
            const opensUI = /new mail|compose|reply|forward|new message/i.test(parsed.target);
            await this.delay(opensUI ? 1500 : 500);
            continue;
          }

          // Fall back to vision model
          console.log(`   👁️ Visual hint: "${parsed.target}"`);
          const hint = await this.getCoordinateHint(parsed.target);
          if (hint) {
            console.log(`   👁️ Clicked "${parsed.target}" at (${hint.x}, ${hint.y})`);
            await this.desktop.mouseClick(hint.x, hint.y);
            stepsTotal++;
            actionHistory.push({ action: 'need_visual', description: `Clicked "${parsed.target}" at (${hint.x}, ${hint.y}) — SUCCEEDED. Move to next step.` });
            this.a11y.invalidateCache();
            const opensUI = /new mail|compose|reply|forward|new message/i.test(parsed.target);
            await this.delay(opensUI ? 1500 : 500);
            continue;
          } else {
            actionHistory.push({ action: 'need_visual', description: `"${parsed.target}" not found in screenshot` });
            continue;
          }
        }

        if (parsed.action === 'unsure') {
          // Allow up to 3 unsure responses before giving up — push a hint and continue
          const unsureCount = actionHistory.filter(a => a.action === 'unsure').length;
          if (unsureCount < 3) {
            console.log(`   🤷 Layer 2 unsure (${unsureCount + 1}/3): ${parsed.description.substring(0, 80)} — pushing hint and continuing`);
            actionHistory.push({
              action: 'unsure',
              description: `Unsure: ${parsed.description} → Try need_visual to see what's on screen, or use Tab to explore, or try a different keyboard approach.`,
            });
            continue;
          }
          console.log(`   🤷 Layer 2 unsure (3/3): ${parsed.description.substring(0, 80)} → falling through`);
          return { handled: false, description: parsed.description, unsure: true, steps: stepsTotal, actionHistory };
        }

        if (parsed.action === 'done') {
          const evidence = parsed.evidence || parsed.description || '(no evidence given)';

          // Block premature done — evidence contradicts completion
          const isContradiction = /however|but I need|let me|I should|still need|not yet|I will|next I|I haven't|need to/i.test(evidence);
          if (isContradiction && step < MAX_LOOP_STEPS - 2) {
            actionHistory.push({ action: 'blocked', description: `BLOCKED premature done — your evidence says "${evidence.substring(0, 100)}" which indicates the task is NOT complete. You said you still need to do something. DO IT, then declare done with proof.` });
            console.log(`   🚫 Blocked premature done — evidence contradicts completion: ${evidence.substring(0, 80)}`);
            continue;
          }

          // Block done if task requires writing/composing but no type action was performed
          const taskLower = (subtask || '').toLowerCase();
          const requiresWriting = /\b(write|compose|draft|create.*text|type.*sentence|type.*paragraph)\b/i.test(taskLower);
          const hasTypedContent = actionHistory.some(a => a.action === 'type' && a.description && !a.description.includes('FAILED'));
          if (requiresWriting && !hasTypedContent && step < MAX_LOOP_STEPS - 2) {
            actionHistory.push({ action: 'blocked', description: `BLOCKED done — task requires writing/composing text but you never typed any content. Use {"action":"type","text":"your composed content here"} to type original text, THEN declare done.` });
            console.log(`   🚫 Blocked done — writing task but no type action performed`);
            continue;
          }

          // Ground truth check — LLM-backed semantic verification
          let groundTruthPass = true;
          let groundTruthDetail = 'no specific check';
          let groundTruthMethod = 'none';
          let attemptLog: import('./verifiers').VerifyAttempt[] = [];
          try {
            if (verifier) {
              const readClip = () => this.a11y.readClipboard();
              const vResult = await verifier.verify(subtask, readClip);
              groundTruthPass = vResult.pass;
              groundTruthDetail = vResult.detail;
              groundTruthMethod = vResult.method;
              attemptLog = vResult.attemptLog ?? [];

              // Log every individual check attempt for full traceability
              if (attemptLog.length > 0) {
                const attemptSummary = attemptLog
                  .map(a => `[${a.checkName}] ${a.pass ? 'PASS' : 'FAIL'} conf=${a.confidence.toFixed(2)} (${a.durationMs}ms): ${a.detail.substring(0, 120)}`)
                  .join('\n     ');
                console.log(`   🔍 Verifier attempts:\n     ${attemptSummary}`);
              }

              if (vResult.evidence) {
                console.log(`   🔍 Verifier evidence: "${vResult.evidence.substring(0, 120)}"`);
              }
            } else {
              // Minimal inline fallback when no verifier injected
              const activeWin = await this.a11y.getActiveWindow().catch(() => null);
              const pn = (activeWin?.processName || '').toLowerCase();
              if (/paste.*notepad|notepad.*paste|copy.*notepad/i.test(subtask) || pn === 'notepad') {
                const focused = await this.a11y.getFocusedElement().catch(() => null);
                if (!focused?.value || focused.value.trim().length < 10) {
                  groundTruthPass = false;
                  groundTruthDetail = `notepad empty — value: "${focused?.value?.substring(0, 50) || '(none)'}"`;
                } else {
                  groundTruthDetail = `notepad has ${focused.value.length} chars`;
                }
              }
            }
          } catch (verifyErr) {
            // Verification errors are NOT silent passes — they block completion
            groundTruthPass = false;
            groundTruthDetail = `Verifier threw unexpected error: ${String(verifyErr).substring(0, 150)}`;
            groundTruthMethod = 'error';
            console.warn(`   ⚠️  Verifier error (blocking as fail): ${groundTruthDetail}`);
          }

          if (!groundTruthPass && step < MAX_LOOP_STEPS - 2) {
            actionHistory.push({ action: 'blocked', description: `BLOCKED done — ground truth check FAILED: ${groundTruthDetail}. The task is NOT complete. Fix it.` });
            console.log(`   🚫 Blocked done — ground truth failed [${groundTruthMethod}]: ${groundTruthDetail}`);
            continue;
          }

          console.log(`   ✅ Layer 2 done (${stepsTotal} steps): ${evidence.substring(0, 80)}`);
          logger?.logStep({
            layer: 2,
            actionType: 'done',
            result: 'success',
            llmReasoning: evidence.substring(0, 300),
            uiStateSummary: attemptLog.length > 0
              ? attemptLog.map(a => `${a.checkName}:${a.pass ? 'pass' : 'fail'}(${a.confidence.toFixed(2)})`).join(' | ')
              : undefined,
            verification: {
              method: groundTruthPass ? (groundTruthMethod as any) || 'a11y_readback' : 'none',
              verified: groundTruthPass,
              detail: [
                `ground_truth: ${groundTruthDetail}`,
                `contradiction=${isContradiction}`,
                `requiresWriting=${requiresWriting}`,
                `hasTypedContent=${hasTypedContent}`,
                attemptLog.length > 0 ? `checks_run=${attemptLog.map(a => a.checkName).join(',')}` : '',
              ].filter(Boolean).join(' | '),
            },
          });
          if (processName) this.failuresByApp.delete(processName.toLowerCase());
          this.visionOnlySubtaskCount = 0;
          return {
            handled: true,
            description: `Done (a11y ${stepsTotal} steps): ${evidence}`,
            steps: stepsTotal,
          };
        }

        // CDP direct DOM actions (Edge/Chrome only)
        if (parsed.action === 'cdp_click' || parsed.action === 'cdp_type') {
          try {
            if (parsed.action === 'cdp_click') {
              await this.executeCdpClick(parsed);
              stepsTotal++;
              const target = parsed.by_text || parsed.selector || parsed.target || '?';
              console.log(`   ✅ CDP click "${target}" succeeded`);
              actionHistory.push({ action: 'cdp_click', description: `CDP click "${target}" — SUCCEEDED` });
            } else {
              await this.executeCdpType(parsed);
              stepsTotal++;
              const field = parsed.by_label || parsed.selector || '?';
              const typedText = (parsed.text || '').substring(0, 40);
              // Text-verify: read back the input value to confirm typing landed
              let verifyNote = '';
              try {
                if (this.cdpDriver) {
                  const selector = parsed.selector || (parsed.by_label ? `[aria-label="${parsed.by_label}"]` : null);
                  if (selector) {
                    // Use parameterized readFieldValue() — avoids CSS selector injection
                    const fieldValue = await this.cdpDriver.readFieldValue(selector).catch(() => '');
                    if (fieldValue && fieldValue.length > 0) {
                      verifyNote = ` (field now shows: "${fieldValue}")`;
                    }
                  }
                }
              } catch { /* non-critical */ }
              console.log(`   ✅ CDP type "${typedText}" into "${field}" succeeded${verifyNote}`);
              actionHistory.push({ action: 'cdp_type', description: `CDP type "${typedText}" into "${field}" — SUCCEEDED${verifyNote}` });
            }
            this.a11y.invalidateCache();
            await this.delay(SETTLE_MS);
            continue;
          } catch (cdpErr) {
            console.log(`   ❌ CDP ${parsed.action} failed: ${String(cdpErr).substring(0, 150)}`);
            actionHistory.push({ action: 'error', description: `CDP action failed: ${cdpErr} — try keyboard instead` });
            await this.delay(SETTLE_MS);
            continue;
          }
        }

        // CDP scroll — scroll the page or a specific element
        if (parsed.action === 'cdp_scroll') {
          try {
            await this.ensureCdp();
            const pg = this.cdpDriver!.getPage();
            if (pg) {
              const direction = (parsed.direction || 'down').toLowerCase();
              const amount = Math.min(Math.max(parsed.amount ?? 400, 50), 2000);
              const deltaY = (direction === 'up') ? -amount : (direction === 'down') ? amount : 0;
              const deltaX = (direction === 'left') ? -amount : (direction === 'right') ? amount : 0;
              const selector = parsed.selector || null;
              if (selector) {
                await pg.evaluate(
                  ({ sel, dy, dx }: { sel: string; dy: number; dx: number }) => {
                    const el = document.querySelector(sel);
                    if (el) { el.scrollBy(dx, dy); }
                  },
                  { sel: selector, dy: deltaY, dx: deltaX },
                );
              } else {
                await pg.evaluate(
                  ({ dy, dx }: { dy: number; dx: number }) => window.scrollBy(dx, dy),
                  { dy: deltaY, dx: deltaX },
                );
              }
              stepsTotal++;
              const desc = `Scrolled ${direction} ${amount}px${selector ? ` on "${selector}"` : ''}`;
              console.log(`   ✅ CDP scroll: ${desc}`);
              actionHistory.push({ action: 'cdp_scroll', description: desc });
              await this.delay(SETTLE_MS);
            }
            continue;
          } catch (scrollErr) {
            actionHistory.push({ action: 'error', description: `cdp_scroll failed: ${scrollErr} — use key_press ArrowDown or Page_Down instead` });
            continue;
          }
        }

        // CDP read text — extract visible text from page for info retrieval
        if (parsed.action === 'cdp_read_text') {
          try {
            await this.ensureCdp();
            const selector = parsed.selector || 'body';
            // Use parameterized readText() — avoids CSS selector injection
            const text = await this.cdpDriver!.readText(selector, 3000);
            // Truncate in action history to prevent unbounded growth (LLM sees full text this step only)
            const historyText = text.length > 500 ? text.substring(0, 500) + `... [${text.length} chars total]` : text;
            actionHistory.push({ action: 'cdp_read_text', description: `PAGE TEXT (${selector}):\n${historyText}` });
            console.log(`   📖 cdp_read_text "${selector}" — ${text.length} chars extracted`);
            continue;
          } catch (err) {
            actionHistory.push({ action: 'error', description: `cdp_read_text failed: ${err} — try checkpoint or keyboard instead` });
            continue;
          }
        }

        // ── Deterministic app switching ──
        if (parsed.action === 'switch_app') {
          const targetApp = (parsed.app || parsed.name || '').toLowerCase();
          if (!targetApp) {
            actionHistory.push({ action: 'blocked', description: 'switch_app requires "app" parameter — e.g. {"action":"switch_app","app":"notepad"}' });
            continue;
          }
          try {
            const windows = await this.a11y.getWindows().catch(() => []);
            const targetWin = windows.find(w =>
              !w.isMinimized && w.processName.toLowerCase().includes(targetApp)
            );
            if (targetWin) {
              // Attempt focus with retry — sometimes first attempt doesn't take
              await this.a11y.focusWindow(undefined, targetWin.processId).catch(() => null);
              await this.delay(600);
              // Verify focus actually changed by checking foreground window
              const activeWin = await this.a11y.getActiveWindow().catch(() => null);
              const focusVerified = activeWin?.processName.toLowerCase().includes(targetApp);
              if (!focusVerified) {
                // Retry once — focus didn't take
                console.log(`   🔄 switch_app retry: focus on ${activeWin?.processName || 'unknown'} not ${targetApp}, retrying...`);
                await this.a11y.focusWindow(undefined, targetWin.processId).catch(() => null);
                await this.delay(800);
              }
              actionHistory.push({ action: 'switch_app', description: `Switched to ${targetWin.processName} "${targetWin.title}" (pid ${targetWin.processId}) — SUCCEEDED` });
              console.log(`   🔀 Switched to ${targetWin.processName} (pid ${targetWin.processId})`);
              stepsTotal++;
              // Update browser detection based on the target we switched to
              isLikelyBrowser = BROWSER_PROCESS_RE.test(targetWin.processName);
              if (!isLikelyBrowser) {
                // Switching away from browser — mark CDP unavailable, re-enable UIA
                this.cdpAvailable = false;
                this.uiaDisabled = false; // UIA works fine for non-browser apps
              } else if (this.cdpAvailable === false) {
                // Switching back TO browser — allow CDP reconnection attempt
                this.cdpAvailable = null;
              }
            } else {
              // App not open — try to launch it
              actionHistory.push({ action: 'switch_app', description: `${targetApp} not found in window list. Use key_press to open it (e.g. Super key, type app name, Enter).` });
              console.log(`   ⚠️ switch_app: ${targetApp} not found — prompting LLM to open it`);
            }
          } catch (err) {
            actionHistory.push({ action: 'switch_app', description: `switch_app failed: ${String(err).substring(0, 80)}` });
          }
          continue;
        }

        if (parsed.action === 'checkpoint') {
          const priorCheckpoints = actionHistory.filter(a => a.action === 'checkpoint');

          // Loop guard: if already called checkpoint with CDP unavailable, block further calls
          const cdpUnavailableCheckpoints = priorCheckpoints.filter(a => a.description.includes('CDP not connected') || a.description.includes('CDP unavailable'));
          if (cdpUnavailableCheckpoints.length >= 1) {
            actionHistory.push({ action: 'checkpoint', description: 'CHECKPOINT BLOCKED — CDP is NOT available this session. Do NOT call checkpoint again. Use keyboard/Tab navigation to proceed with the task.' });
            console.log(`   📍 Checkpoint suppressed (CDP unavailable, loop guard)`);
            continue;
          }

          // Deduplicate: if same URL was already returned, block with "URL unchanged"
          if (priorCheckpoints.length >= 1) {
            try {
              const currentUrl = this.cdpDriver ? await this.cdpDriver.getUrl() : null;
              const lastCheckpoint = priorCheckpoints[priorCheckpoints.length - 1].description;
              if (currentUrl && lastCheckpoint.includes(currentUrl)) {
                actionHistory.push({ action: 'checkpoint', description: `CHECKPOINT BLOCKED — URL unchanged (${currentUrl}). Page already known. Proceed with task actions (cdp_click, cdp_type, key_press).` });
                console.log(`   📍 Checkpoint suppressed (same URL: ${currentUrl})`);
                continue;
              }
            } catch { /* fall through to normal checkpoint */ }
          }

          try {
            const url = this.cdpDriver ? await this.cdpDriver.getUrl() : null;
            const title = this.cdpDriver ? await this.cdpDriver.getTitle() : null;
            const info = url ? `URL: ${url} | Title: "${title}"` : 'CDP not connected this session — proceed with Tab/keyboard navigation. Do NOT call checkpoint again.';
            actionHistory.push({ action: 'checkpoint', description: `CHECKPOINT — ${info}` });
            console.log(`   📍 Checkpoint: ${info}`);
          } catch (err) {
            console.debug(`[A11yReasoner] Checkpoint CDP error: ${err}`);
            actionHistory.push({ action: 'checkpoint', description: 'CHECKPOINT — CDP unavailable this session. Proceed with Tab/keyboard navigation.' });
          }
          continue;
        }

        // BLOCK a11y actions on browser windows when CDP is connected — UIA hangs on React SPAs
        const isA11yAction = ['a11y_click', 'a11y_set_value', 'a11y_focus'].includes(parsed.action);
        if (isA11yAction && isLikelyBrowser && this.cdpAvailable === true) {
          const a11yBlockCount = actionHistory.filter(a => a.action === 'blocked' && a.description.includes('CDP is connected')).length;
          if (a11yBlockCount < 3) {
            actionHistory.push({ action: 'blocked', description: `BLOCKED ${parsed.action} "${parsed.name || ''}" — CDP is connected. Use cdp_click or cdp_type instead. UIA calls HANG on this page.` });
            console.log(`   🚫 Blocked ${parsed.action} on browser (CDP available) — redirecting to CDP`);
          }
          // After 3 blocks, stop wasting LLM calls — force done with failure
          if (a11yBlockCount >= 3) {
            return { handled: false, description: 'LLM keeps trying a11y actions on browser despite CDP being available', unsure: true, steps: stepsTotal, actionHistory };
          }
          continue;
        }

        // Skip a11y_click on taskbar items (they fail with RPC_E_SERVERFAULT)
        // Also catch descriptive window-title strings that are taskbar buttons
        const isTaskbarClick = parsed.action === 'a11y_click' && parsed.name && (
          /running window|pinned|taskbar/i.test(parsed.name) ||
          /Microsoft Edge|Google Chrome|msedge|Firefox/i.test(parsed.name) ||
          // Anything that looks like a full browser window title in the taskbar
          (parsed.controlType === 'Button' && parsed.name.length > 40)
        );
        if (isTaskbarClick) {
          const taskbarSkips = actionHistory.filter(a => a.action === 'skipped' && a.description.includes('taskbar')).length;
          if (taskbarSkips >= 2) {
            // Already skipped twice — don't waste more LLM calls, just reuse last message
            continue;
          }
          actionHistory.push({ action: 'skipped', description: `Skipped taskbar item — not clickable. Use need_visual to click UI elements instead. STOP trying a11y_click on taskbar items.` });
          continue;
        }

        // Key-press loop detection: if LLM spams key_press on browser with CDP available, force CDP usage
        if (parsed.action === 'key_press' && isLikelyBrowser && this.cdpAvailable === true) {
          const recentKeyPresses = actionHistory.slice(-8).filter(a => a.action === 'key_press').length;
          if (recentKeyPresses >= 5) {
            actionHistory.push({ action: 'blocked', description: `STOP spamming key_press — you have done ${recentKeyPresses} key presses with no progress. CDP is connected. Use cdp_click by_text="Button Label" to click elements. Use cdp_type to fill fields. If the task URL shows search params are already set, the results ARE showing — use {"action":"done","evidence":"URL contains search params, flights displayed"}.` });
            console.log(`   🚫 Blocked key_press spam (${recentKeyPresses} in last 8 actions) — forcing CDP usage`);
            continue;
          }
        }

        // Execute the action
        const inputAction = this.mapAction(parsed);
        if (!inputAction) {
          console.log(`   ⚠️ Layer 2: could not map action "${parsed.action}" → unsure`);
          return { handled: false, description: `Unmappable action: ${parsed.action}`, unsure: true, steps: stepsTotal, actionHistory };
        }

        // Duplicate detection: if the exact same type action was just done, skip it
        const lastAction = actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : null;
        if (lastAction && parsed.action === 'type' && lastAction.action === 'type' &&
            parsed.text && lastAction.description.includes(parsed.text.substring(0, 20))) {
          actionHistory.push({ action: 'skipped', description: `ALREADY TYPED "${parsed.text.substring(0, 30)}" — it worked. The text is in the field. Move to the NEXT step.` });
          continue;
        }

        console.log(`   ⚡ [${parsed.action}] ${parsed.name || parsed.key || (parsed.text ? parsed.text.substring(0, 40) : '') || ''}`);
        await this.executeAction(inputAction);
        stepsTotal++;
        actionHistory.push({ action: parsed.action, description: `${parsed.action} "${parsed.text || parsed.name || parsed.key || ''}" — ${parsed.description || 'done'}` });

        // Settle: let the UI react before next read
        await this.delay(SETTLE_MS);

        // Cap action history to prevent unbounded growth — keep context entries + most recent actions
        if (actionHistory.length > MAX_ACTION_HISTORY) {
          const contextEntries = actionHistory.filter(a => a.action === 'context');
          const nonContext = actionHistory.filter(a => a.action !== 'context');
          const trimmed = nonContext.slice(-MAX_ACTION_HISTORY + contextEntries.length);
          actionHistory.length = 0;
          actionHistory.push(...contextEntries, ...trimmed);
        }

      } catch (err) {
        const errStr = String(err);
        // API-level errors (credits, rate limit, auth) are not UIA/app failures —
        // don't charge them against the circuit breaker or they'll wrongly disable apps
        const isApiError = /credit balance|rate limit|authentication|invalid.*key|overloaded/i.test(errStr);
        if (isApiError) {
          console.log(`   ❌ Layer 2 API error (non-recoverable): ${errStr.substring(0, 120)}`);
          return { handled: false, description: `API error: ${errStr}`, steps: stepsTotal, actionHistory };
        }

        // RPC_E_SERVERFAULT = UIA is hanging (React SPA) — switch to CDP-only immediately
        const isRpcFault = /RPC_E_SERVERFAULT|0x80010105|SERVERFAULT/i.test(errStr);
        if (isRpcFault && isLikelyBrowser && this.cdpAvailable === true) {
          console.log(`   🔴 RPC_E_SERVERFAULT on browser with CDP available — disabling UIA, CDP-only mode`);
          this.uiaDisabled = true; // prevent all future UIA reads in this session
          actionHistory.push({ action: 'error', description: `UIA CRASHED (RPC_E_SERVERFAULT). ALL UIA/a11y actions permanently disabled. Use ONLY cdp_click, cdp_type, key_press, or type.` });
          await this.delay(SETTLE_MS);
          continue;
        }

        const appKey = (processName || 'global').toLowerCase();
        const failures = (this.failuresByApp.get(appKey) || 0) + 1;
        this.failuresByApp.set(appKey, failures);
        console.log(`   ❌ Layer 2 error (${appKey} ${failures}/${this.MAX_FAILURES}): ${errStr}`);

        // For browser apps, RPC_E_SERVERFAULT means UIA is broken on SPAs — trip immediately
        // For non-browser apps (Notepad, etc.), it's likely transient — just count as normal failure
        if ((isRpcFault && isLikelyBrowser) || failures >= this.MAX_FAILURES) {
          this.disabledApps.add(appKey);
          console.log(`   🔴 Layer 2 circuit breaker tripped for "${appKey}" — subtasks for this app will use vision fallback.`);
          return { handled: false, description: `Layer 2 error: ${errStr}`, steps: stepsTotal, actionHistory };
        }
        if (isRpcFault && !isLikelyBrowser) {
          console.log(`   ⚠️ RPC_E_SERVERFAULT on non-browser app "${appKey}" — retrying (${failures}/${this.MAX_FAILURES})`);
          await this.delay(2000); // extra settle time for UIA recovery
        }

        // Don't give up on single errors — record and continue the loop
        // The LLM will see the error in action history and try a different approach
        actionHistory.push({ action: 'error', description: `Action failed: ${err}` });
        await this.delay(SETTLE_MS);
        continue;
      }
    }

    // Exhausted steps without completing — hand off
    console.log(`   ⚠️ Layer 2: max steps (${MAX_LOOP_STEPS}) reached — task may need human review`);
    return {
      handled: false,
      description: `Max a11y steps reached after: ${actionHistory.map(a => a.description).join(', ')}`,
      unsure: true,
      steps: stepsTotal,
      actionHistory,
    };
  }

  private parseResponse(response: string, step?: number): any {
    // Strip markdown code fences (haiku often wraps in ```json ... ```)
    const stripped = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

    const start = stripped.indexOf('{');
    if (start === -1) {
      return { action: 'unsure', description: 'No JSON in LLM response' };
    }

    // Balance brackets to find the end of the first JSON object
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(start, i + 1));
          } catch (e) {
            return { action: 'unsure', description: 'Failed to parse LLM JSON' };
          }
        }
      }
    }
    return { action: 'unsure', description: 'Failed to parse LLM JSON' };
  }

  private mapAction(parsed: any): InputAction | null {
    switch (parsed.action) {
      case 'a11y_click':
        return { kind: 'a11y_click', name: parsed.name, controlType: parsed.controlType } as A11yAction;

      case 'a11y_set_value':
        return {
          kind: 'a11y_set_value',
          name: parsed.name,
          controlType: parsed.controlType,
          value: parsed.value,
        } as A11yAction;

      case 'a11y_focus':
        return { kind: 'a11y_focus', name: parsed.name, controlType: parsed.controlType } as A11yAction;

      case 'key_press':
        return { kind: 'key_press', key: parsed.key } as InputAction;

      case 'type':
        return { kind: 'type', text: parsed.text } as InputAction;

      default:
        return null;
    }
  }

  private async executeAction(action: InputAction): Promise<void> {
    if (action.kind.startsWith('a11y_')) {
      await this.executeA11yAction(action as A11yAction);
    } else if (action.kind === 'key_press') {
      await this.desktop.keyPress((action as any).key);
    } else if (action.kind === 'type') {
      await this.desktop.typeText((action as any).text);
    }
    // Invalidate cache after every action — next loop reads fresh state
    this.a11y.invalidateCache();
  }

  private async executeA11yAction(action: A11yAction): Promise<void> {
    const actionMap: Record<string, 'click' | 'set-value' | 'get-value' | 'focus'> = {
      a11y_click:     'click',
      a11y_set_value: 'set-value',
      a11y_get_value: 'get-value',
      a11y_focus:     'focus',
    };
    const a11yAction = actionMap[action.kind];
    if (!a11yAction) throw new Error(`Unknown a11y action: ${action.kind}`);

    const result = await this.a11y.invokeElement({
      name:         action.name,
      automationId: action.automationId,
      controlType:  action.controlType,
      action:       a11yAction,
      value:        action.value,
    });

    if (!result.success && !result.clickPoint) {
      throw new Error(result.error ?? 'A11y action failed');
    }

    if (result.clickPoint) {
      await this.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
    }
  }

  /**
   * Vision-as-Coordinate-Spotter (Layer 2.5)
   * Takes a screenshot, asks a cheap vision model "where is [target]?",
   * returns {x, y} coordinates or null.
   */
  private async getCoordinateHint(target: string): Promise<{ x: number; y: number } | null> {
    try {
      // Truncate overly verbose targets from the LLM
      const shortTarget = target.length > 50 ? target.substring(0, 50).trim() : target;

      const frame = await this.desktop.captureForLLM();
      const base64 = frame.buffer.toString('base64');
      const mediaType = frame.format === 'jpeg' ? 'image/jpeg' : 'image/png';

      const prompt = `Look at this screenshot. Find the UI element: "${shortTarget}".\nReturn ONLY JSON: {"x": <number>, "y": <number>}\nCoordinates are in image pixels (${frame.llmWidth}x${frame.llmHeight}).\nClick the CENTER of the element.\nIf not visible: {"x": -1, "y": -1}`;

      const { model, baseUrl } = this.pipelineConfig.layer3;
      const apiKey = this.pipelineConfig.layer3.apiKey || this.pipelineConfig.apiKey;
      const provider = this.pipelineConfig.provider;
      let responseText: string;

      if (provider.openaiCompat || baseUrl.includes('localhost') || baseUrl.includes('11434')) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
          body: JSON.stringify({
            model,
            max_tokens: 60,
            temperature: 0,
            messages: [
              { role: 'system', content: 'You find UI elements in screenshots. Return ONLY JSON coordinates, nothing else.' },
              { role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
                { type: 'text', text: prompt },
              ]},
            ],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json() as any;
        if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
        responseText = data.choices?.[0]?.message?.content ?? '';
      } else {
        // Anthropic vision API — use prefill to force JSON output
        const res = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
          body: JSON.stringify({
            model,
            max_tokens: 60,
            messages: [
              { role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                { type: 'text', text: prompt },
              ]},
              { role: 'assistant', content: '{"x":' },
            ],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json() as any;
        if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
        const raw = data.content?.[0]?.text ?? '';
        responseText = '{"x":' + raw;
      }

      const match = responseText.match(/\{\s*"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)\s*\}/);
      if (!match) return null;

      const x = parseInt(match[1], 10);
      const y = parseInt(match[2], 10);
      if (x < 0 || y < 0) return null;

      // Scale from LLM image space to real screen coordinates
      const realX = Math.round(x * frame.scaleFactor);
      const realY = Math.round(y * frame.scaleFactor);

      return { x: realX, y: realY };
    } catch (err) {
      console.log(`   ⚠️ Layer 2.5 vision hint failed: ${err}`);
      return null;
    }
  }

  /** Get CDP page context for browser windows. Returns null if CDP unavailable. Caches failure state. */
  private async getCdpContext(): Promise<string | null> {
    if (this.cdpAvailable === false) return null;
    try {
      if (!this.cdpDriver) {
        this.cdpDriver = new CDPDriver(9222);
      }
      const connected = await this.cdpDriver.isConnected();
      if (!connected) {
        const ok = await this.cdpDriver.connect();
        if (!ok) {
          this.cdpAvailable = false;
          this.cdpDriver = null;
          return null;
        }
      }
      this.cdpAvailable = true;
      const ctx = await this.cdpDriver.getPageContext();
      return '\n\n⚠️ CDP PAGE CONTEXT — you MUST use cdp_click/cdp_type/cdp_read_text actions (NOT key_press) to interact with this page:\n' + ctx;
    } catch (err) {
      this.cdpAvailable = false;
      this.cdpDriver = null;
      return null;
    }
  }

  /** Execute a cdp_click action — click web element by selector or text */
  private async executeCdpClick(parsed: any): Promise<void> {
    const cdp = await this.ensureCdp();
    let result;
    if (parsed.by_text) {
      result = await cdp.clickByText(parsed.by_text);
    } else if (parsed.selector) {
      result = await cdp.click(parsed.selector);
    } else if (parsed.target) {
      result = await cdp.clickByText(parsed.target);
    } else {
      throw new Error('cdp_click: requires selector, by_text, or target');
    }
    if (!result.success) throw new Error(result.error || 'cdp_click failed');
  }

  /** Execute a cdp_type action — type into web element by selector or label */
  private async executeCdpType(parsed: any): Promise<void> {
    const cdp = await this.ensureCdp();
    if (!parsed.text) throw new Error('cdp_type: text is required');
    let result;
    if (parsed.by_label) {
      result = await cdp.typeByLabel(parsed.by_label, parsed.text);
    } else if (parsed.selector) {
      result = await cdp.typeInField(parsed.selector, parsed.text);
    } else {
      throw new Error('cdp_type: requires selector or by_label');
    }
    if (!result.success) throw new Error(result.error || 'cdp_type failed');
  }

  /** Ensure CDPDriver is connected; throws if unavailable */
  private async ensureCdp(): Promise<CDPDriver> {
    if (!this.cdpDriver || !(await this.cdpDriver.isConnected())) {
      this.cdpDriver = new CDPDriver(9222);
      const ok = await this.cdpDriver.connect();
      if (!ok) {
        this.cdpAvailable = false;
        this.cdpDriver = null;
        throw new Error('CDPDriver: cannot connect to Edge/Chrome on port 9222');
      }
      this.cdpAvailable = true;
    }
    return this.cdpDriver;
  }

  private async callTextModel(userMessage: string): Promise<string> {
    const { model, baseUrl } = this.pipelineConfig.layer2;
    const apiKey  = this.pipelineConfig.apiKey;
    const provider = this.pipelineConfig.provider;

    if (provider.openaiCompat || baseUrl.includes('localhost') || baseUrl.includes('11434')) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content ?? '';
    } else {
      // Anthropic — prefill '{' forces the model to continue with valid JSON
      const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provider.authHeader(apiKey) },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user',      content: userMessage },
            { role: 'assistant', content: '{' },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
      // Prepend the prefilled '{' back since the API only returns the continuation
      const text = data.content?.[0]?.text ?? '';
      return text.startsWith('{') ? text : '{' + text;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
