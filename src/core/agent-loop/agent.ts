/**
 * Unified agent loop — replaces text-agent + vision-agent with ONE harness.
 *
 * Design summary:
 *   • ONE tool vocabulary built by `tools.ts` (mode-parameterized).
 *   • Perception: accessibility snapshot EVERY turn (cheap, structured).
 *     Screenshots only when:
 *       (a) mode === 'vision' (turn 1 seed), or
 *       (b) the model explicitly calls the `screenshot` tool, or
 *       (c) a screen-changing tool ran AND mode is hybrid/vision
 *           (so the model sees the result before its next turn).
 *   • LLM: native tool_use via callLLMWithTools (Anthropic tool_use / OpenAI
 *     tool_calls). JSON-from-prose fallback for providers without native support.
 *   • Safety: every tool call runs through `safety.evaluate()` BEFORE its
 *     execute() fires. Single chokepoint.
 *   • Stagnation: FingerprintHistory tracks screen state; 3 identical
 *     fingerprints = force the agent to try something different or give_up.
 *   • Streaming logs: tree-shaped turn logs via the observability logger
 *     so the user can watch what the agent is thinking/doing in real time.
 *
 * Model-agnostic + OS-agnostic by construction: provider config comes from
 * AgentLlmDeps, I/O goes through PlatformAdapter, zero `process.platform`
 * branching here.
 */

import { createHash } from 'node:crypto';
import type { ScreenshotResult } from '../../platform/types';
import { FingerprintHistory } from '../sense/fingerprint';
import { captureSnapshot } from '../sense/snapshot';
import { captureTaskBaseline } from '../verify/assertions';
import { UIMapHolder } from '../sense/ui-map-holder';
import { reactiveCheck } from '../sense/reactive-check';
import { validateExpect } from '../verify/assertions';
import { OcrEngine } from '../../platform/ocr-engine';
import { compileUIMap } from '../sense/ui-map';
import { renderUIMap } from '../sense/ui-map-render';
import type { UIMap } from '../sense/ui-map-types';
import { logger, EVENTS, beginSpan } from '../observability/logger';
import { getCorrelationId } from '../observability/correlation';
import { evaluate as safetyEvaluate, isAllowed } from '../safety';
import {
  callLLMWithTools,
  type LLMTool,
  type LLMToolTurn,
  type LLMUserBlock,
  type ToolUseResult,
} from '../../llm/client';
import { buildSystemPrompt, renderSnapshot, renderHistory, wrapUntrustedScreenContent } from './prompt';
import { LLM_TARGET_WIDTH } from './coord-scale';
import { buildUnifiedTools } from './tools';
import { TOOL_META } from './tool-meta';
import type {
  AgentInput,
  AgentLlmConfig,
  AgentLlmDeps,
  AgentResult,
  AgentStep,
  AgentToolContext,
  UnifiedTool,
  AgentExit,
} from './types';

// Backstop turn cap. With the runaway guard (repeated identical actions) and
// stagnation hard-abort catching genuine stuck-loops early, max_turns is a
// safety net, not the primary detector — so it can be generous enough to
// support long sequential tasks (e.g. a multi-challenge benchmark) that
// legitimately need 30+ actions. Was 20, which truncated such runs mid-task.
const DEFAULT_MAX_TURNS = 70;
/**
 * Number of consecutive identical fingerprints that triggers a stagnation
 * WARNING in the next turn's prompt. Below this we trust the agent to
 * recover on its own (a single side-effect-free tool call like
 * `read_screen` legitimately leaves the fingerprint unchanged).
 */
const STAGNATION_WINDOW = 3;
/**
 * Number of consecutive stagnant turns after which the stagnation NUDGE
 * escalates from soft to firm (a stronger, method-switching reminder).
 *
 * This is NOT a task-kill. v1.0.0 removed the pipeline ladder, so there is
 * no rung to "escalate" to — and the stagnation signal is the a11y/OCR
 * fingerprint, which is structurally blind to sparse-a11y form apps (new
 * Outlook / `olk`, web & canvas UIs) where the agent may still be making
 * real progress. Aborting on it killed winnable runs. True stuck-loops are
 * caught by the runaway guard (same tool+args repeated); genuine flailing is
 * capped by max_turns. After a firm nudge the counter re-arms so the
 * reminder recurs in waves rather than every turn.
 */
const STAGNATION_HARD_LIMIT = 5;
const MAX_HISTORY_SCREENSHOTS = 2;
/**
 * After this many consecutive turns of `agent.no_tool_call` (model
 * produced text but no parseable tool call), the rung aborts so the
 * pipeline ladder can climb. Three is conservative — a single
 * malformed turn from a degenerate model state can usually self-correct
 * with the "retry with a tool call" reprompt, but three in a row
 * means the model is stuck in a loop and the next strategy has a
 * better chance.
 */
const NO_TOOL_CALL_LIMIT = 3;

// Lazy OCR singleton for reactiveCheck — mirrors tools.ts getAgentOcr pattern.
let _reactiveOcr: OcrEngine | null = null;
function reactiveOcr(): OcrEngine { return (_reactiveOcr ??= new OcrEngine()); }

export interface AgentDeps {
  adapter: import('../../platform/types').PlatformAdapter;
  llm: AgentLlmDeps;
  /** Optional CDP driver for the browser_* tools (dedicated agent-owned
   *  browser). Resolved lazily by the pipeline from the daemon's driver. */
  cdp?: import('../../platform/cdp-driver').CDPDriver | null;
  /** Optional session-scoped UIMap holder (Part 2). Created per-call if absent. */
  uiMaps?: UIMapHolder;
}

/**
 * Run the unified agent against a task.
 *
 * The function is a pure orchestrator — no side effects outside the
 * tool calls themselves. Returns an AgentResult even on failure.
 */
export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const startedAt = Date.now();
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const isAborted = input.isAborted ?? (() => false);
  const correlationId = getCorrelationId();
  const log = correlationId ? logger.with({ correlationId }) : logger;

  // Prefer text model; fall back to vision model if text is absent
  // (vision models handle tool_use without images too).
  const llmConfig: AgentLlmConfig | undefined = deps.llm.text || deps.llm.vision;
  if (!llmConfig) {
    return earlyExit('give_up', 'No model configured. Run `clawdcursor doctor` to set AI_TEXT_MODEL.', startedAt);
  }

  // Session-scoped UIMap holder (Part 2). Created per-call if not provided.
  const holder = deps.uiMaps ?? new UIMapHolder();

  // Set up perception state.
  const fph = new FingerprintHistory(8);
  const screenshotsCaptured = { n: 0 };
  // Pixel-level change evidence. The a11y fingerprint is structurally blind
  // to sparse-a11y apps (new Outlook / `olk`, web & canvas UIs) — it can sit
  // flat for 30+ turns while the screen demonstrably advances. Screenshot
  // bytes are ground truth: when the model captures one and it differs from
  // the previous capture, the screen moved, whatever the fingerprint says.
  let lastShotDigest: string | null = null;
  let lastPixelMoveTurn = 0;

  // Cache screen size once — used for scroll center coordinates.
  let screen: AgentToolContext['screen'];
  try {
    screen = await deps.adapter.getScreenSize();
  } catch {
    screen = { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 };
  }

  // Build the flat tool catalog. Mode and capability params are no longer
  // accepted — the full catalog is served regardless of mode.
  const tools = buildUnifiedTools();
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const llmTools = toUnifiedLLMTools(tools);

  const systemPrompt = buildSystemPrompt();

  // Seed the conversation.
  const history: LLMToolTurn[] = [];
  const steps: AgentStep[] = [];
  let llmCalls = 0;
  let activeApp: string | undefined;
  /**
   * Counts consecutive turns where stagnation fired (a11y fingerprint flat
   * after a screen-changing action). Reset to 0 when the fingerprint moves —
   * or after a firm nudge at `STAGNATION_HARD_LIMIT` (the nudge re-arms in
   * waves; it does NOT abort the task). The runaway guard + max_turns are the
   * terminators.
   */
  // P1 verification integrity: task-level flag — set once any screen-changing
  // tool actually moved the screen. The `done` gate requires machine-checkable
  // evidence (and rejects non-discriminating evidence) when this is true.
  let taskMutated = false;
  let consecutiveStagnantTurns = 0;
  /**
   * Counts consecutive turns where the model produced no tool call.
   * Reset to 0 whenever the model successfully emits a tool call. When
   * this hits `NO_TOOL_CALL_LIMIT` the rung aborts with `'give_up'` so
   * the pipeline ladder can climb to the next strategy. Without this,
   * a Kimi/Moonshot model that fell into degenerate generation (loop
   * of repeated tokens, hits max_tokens with no parseable tool call)
   * just kept producing more garbage every turn for 5 minutes until the
   * task-level timeout fired — 12 wasted turns, ~$0.03 wasted, 0
   * actions taken. Real trace: Outlook subtask 3 ("type recipient")
   * after focus_element failed legitimately on turn 1, the model
   * emitted `functions.read_screen:1ORTYMQAQBAA…(1024 tokens of
   * garbage)` for 11 turns straight.
   */
  let consecutiveNoToolCallTurns = 0;

  // Cross-turn anchor continuity for compileUIMap. Hoisted above the turn-1
  // block so storeUIMap can be called there and update prevAnchors.
  let prevAnchors: UIMap['anchors'] | undefined = undefined;

  // P1: cheap baseline snapshot at task start (window list + clipboard, NO
  // extra OCR — the strong discriminating signals are window titles, clipboard,
  // file mtime; an ambient clock changes regardless so baseline OCR buys little
  // and would cost a screen capture every task). The `done` gate uses this to
  // reject completion evidence that was ALREADY true before the task acted.
  // Best-effort — never blocks the run.
  const taskBaseline = await captureTaskBaseline(deps.adapter).catch(() => undefined);

  // Turn-1 perception — compiled UIMap (el_NN) so the agent acts on the same
  // vocabulary from its very first decision and el_NN refs resolve immediately.
  // Falls back to a plain a11y snapshot text if compilation fails.
  try {
    const firstSnapshot = await captureSnapshot(deps.adapter);
    activeApp = firstSnapshot.activeWindow?.processName;
    fph.push(firstSnapshot.fingerprint);

    // Turn-1 perception = the compiled UI map (el_NN), so the agent acts on the
    // same vocabulary from its very first decision. storeUIMap stores it in the
    // holder, so turn-1 el_NN refs resolve.
    let firstUiRender: string;
    try {
      const ui0 = await storeUIMap(holder, firstSnapshot, deps.adapter, prevAnchors);
      prevAnchors = ui0.anchors;
      firstUiRender = ui0.render;
    } catch {
      firstUiRender = renderSnapshot(firstSnapshot, { screenWidth: screen.physicalWidth, screenHeight: screen.physicalHeight, focusProcessId: firstSnapshot.activeWindow?.processId });
    }

    // DPI/scale header — tells the model how screenshot pixels map to tool coords.
    const imgScaleNum = screen.physicalWidth > LLM_TARGET_WIDTH
      ? screen.physicalWidth / LLM_TARGET_WIDTH
      : 1;
    const ssScale = imgScaleNum.toFixed(2);
    const dpiNote = `\nDISPLAY: ${screen.physicalWidth}×${screen.physicalHeight} physical, screenshot ${LLM_TARGET_WIDTH}px wide (×${ssScale} to screen).`;
    log.info('agent.coordinate_space', {
      physical: `${screen.physicalWidth}×${screen.physicalHeight}`,
      screenshotScale: ssScale,
      snapshotSpace: 'screen',
    });

    // Anchor the agent to its working window (when the caller resolved one)
    // so it refocuses there instead of thrashing to unrelated apps/tools.
    const windowAnchor = input.targetWindow
      ? `WORKING WINDOW: the "${input.targetWindow.processName}" window ("${input.targetWindow.title}") — perform this task there. If focus drifts to another window, refocus it with focus_window(processName:"${input.targetWindow.processName}") rather than opening new apps, tabs, or tools.\n\n`
      : '';
    const initialBlocks: LLMUserBlock[] = [
      {
        type: 'text',
        text: `${windowAnchor}TASK: ${input.task}${dpiNote}\n\nCOMPILED UI (act on an element via invoke_element/set_field_value with {element_id, snapshot_id}):\n${wrapUntrustedScreenContent(firstUiRender)}\n\nPICK ONE TOOL CALL.`,
      },
    ];
    if (input.targetWindow) log.info('agent.window_anchor', { window: input.targetWindow.title, process: input.targetWindow.processName });

    history.push({ role: 'user', content: initialBlocks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('agent.perception.initial.failed', { error: msg });
    return earlyExit('cannot_read', `initial perception failed: ${msg}`, startedAt);
  }

  // ─── Main turn loop ─────────────────────────────────────────
  const outerSpan = beginSpan();
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

      log.info(EVENTS.AGENT_TURN_START, { turn, historyTurns: history.length });
      const turnStart = Date.now();

      // Route THIS turn to the vision model when a screenshot is in context —
      // the text model (a11y-first) reads images poorly, and the configured
      // vision model exists for exactly these turns. Text-model cost is kept
      // for a11y turns. General: any vision-needing task.
      //
      // imageInContext is ALSO the coordinate-space signal: raw click/drag
      // coords default to image-space only while a screenshot is actually in
      // the model's context. Keying that default on "the vision model is
      // active" conflated model choice with coordinate provenance — in a
      // vision-only config it scaled a11y/@x,y screen coords from turn 1
      // with no screenshot anywhere (audit 2026-06-10, finding C1). Old
      // screenshots age out of history (see trimOldScreenshots), so neither
      // the image default nor vision routing latches for the rest of the run.
      const imageInContext = historyHasImage(history);
      const activeLlm = (deps.llm.vision && imageInContext) ? deps.llm.vision : llmConfig;
      log.info('agent.turn_model', { turn, model: activeLlm.model, vision: activeLlm === deps.llm.vision });

      // 1. Call the LLM with tools. Retry TRANSIENT failures (overload, rate
      //    limit, timeout, 5xx, dropped socket) with exponential backoff — a
      //    single API blip must not throw away a long multi-step run (a live
      //    14-challenge run died at turn 45 to one transient error after
      //    completing 10 steps). Non-transient errors (bad request, auth) fail
      //    fast — retrying them is pointless.
      let llmResult: ToolUseResult;
      {
        const LLM_MAX_ATTEMPTS = 4;
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            llmResult = await callLLMWithTools({
              baseUrl: activeLlm.baseUrl,
              model: activeLlm.model,
              apiKey: activeLlm.apiKey,
              isAnthropic: activeLlm.isAnthropic,
              system: systemPrompt,
              tools: llmTools,
              messages: history,
              maxTokens: activeLlm.maxTokens ?? 1024,
              timeoutMs: 45_000,
              toolChoice: 'auto',
              signal: input.abortSignal,
            });
            llmCalls += 1;
            break;
          } catch (err) {
            // User abort (stop command) cancels the in-flight fetch via
            // input.abortSignal — exit cleanly as 'aborted', never as
            // llm_error, and never retry. The timeout signal throws
            // 'TimeoutError', a user abort throws 'AbortError', so the two
            // are distinguishable.
            if (isAborted() || input.abortSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
              log.info('agent.aborted', { turn, during: 'llm_call' });
              return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);
            }
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /\b(timeout|timed out|429|rate.?limit|overload|529|50[0-4]|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed)\b/i.test(msg);
            if (attempt < LLM_MAX_ATTEMPTS && transient) {
              const backoffMs = 800 * 2 ** (attempt - 1); // 0.8s, 1.6s, 3.2s
              log.warn('agent.llm.retry', { turn, attempt, error: truncate(msg, 120), backoffMs });
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }
            log.error('agent.llm.failed', { turn, attempt, error: msg });
            return finish('llm_error', `LLM call failed after ${attempt} attempt(s): ${msg}`, steps, llmCalls, screenshotsCaptured.n, startedAt);
          }
        }
      }

      // 2. Log the agent's thinking, if any.
      if (llmResult.text && llmResult.text.trim()) {
        log.info(EVENTS.AGENT_THINK, { turn, text: truncate(llmResult.text.trim(), 160) });
      }

      // 3. Record the assistant turn in history so the next turn sees it.
      //    SAFETY: when the model hit max_tokens with no parseable tool
      //    call, the content is almost certainly degenerate (token-loop
      //    garbage). Feeding it back as assistant context just feeds the
      //    loop. Replace with a short placeholder in that case.
      const looksDegenerate =
        llmResult.toolCalls.length === 0
        && llmResult.stopReason === 'length'
        && llmResult.text.length > 200;
      if (looksDegenerate) {
        history.push({
          role: 'assistant',
          content: [{ type: 'text', text: '(previous response exceeded token limit and produced no tool call)' }],
        });
      } else {
        history.push({ role: 'assistant', content: llmResult.raw });
      }

      // 4. No tool call → treat as parse failure (re-prompt once).
      if (llmResult.toolCalls.length === 0) {
        consecutiveNoToolCallTurns += 1;
        log.warn('agent.no_tool_call', {
          turn,
          stopReason: llmResult.stopReason,
          text: truncate(llmResult.text, 200),
          consecutive: consecutiveNoToolCallTurns,
          degenerate: looksDegenerate,
        });

        // Hard abort if the model has produced no tool call N turns in
        // a row — it's stuck in a degenerate state and won't recover.
        // Exit with 'give_up' so the pipeline ladder climbs to the
        // next rung (blind → hybrid → vision), which uses a different
        // model / prompt shape and is likely to escape the loop.
        if (consecutiveNoToolCallTurns >= NO_TOOL_CALL_LIMIT) {
          log.error('agent.no_tool_call.runaway_abort', {
            turn,
            consecutive: consecutiveNoToolCallTurns,
            hardLimit: NO_TOOL_CALL_LIMIT,
          });
          return finish(
            'give_up',
            `Model produced no parseable tool call for ${consecutiveNoToolCallTurns} consecutive turns (last stopReason="${llmResult.stopReason}"). Likely degenerate generation — aborting rung so the pipeline ladder can escalate.`,
            steps,
            llmCalls,
            screenshotsCaptured.n,
            startedAt,
          );
        }

        history.push({
          role: 'user',
          content: [{ type: 'text', text: 'You must call exactly one tool per turn. Try again with a tool call.' }],
        });
        steps.push({
          turn,
          toolName: '(no-tool)',
          toolArgs: {},
          result: { success: false, text: llmResult.text.slice(0, 200) || '(empty response)' },
          durationMs: Date.now() - turnStart,
          fingerprintChanged: false,
          thought: llmResult.text,
        });
        continue;
      }

      // Successful tool-call emission resets the runaway counter.
      consecutiveNoToolCallTurns = 0;

      // 5. Process every tool call the model emitted this turn. Most
      //    models return exactly one; if more, we process them in order
      //    and all results flow back on the next turn.
      const toolResults: Array<{ id: string; text: string; isError: boolean; screenshot?: ScreenshotResult; stop?: boolean; terminalExit?: AgentExit }> = [];
      let terminal: { exit: AgentExit; text: string } | null = null;
      // Tracks whether ANY tool in this turn was supposed to change the
      // screen. Pure-compute tools (build_uri, wait, list_windows,
      // read_screen, etc.) don't move the fingerprint by design, so they
      // must NOT count as stagnant turns. Without this, the agent's last
      // turn before dispatching a mailto URI (build_uri -> open_uri) was
      // killed by the stagnation hard-abort because build_uri is
      // changesScreen=false. The agent had the right plan and got cut off
      // one step before execution.
      let anyScreenChangingTool = false;

      for (const call of llmResult.toolCalls) {
        if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

        const tool = toolMap.get(call.name);
        if (!tool) {
          log.warn('agent.unknown_tool', { turn, tool: call.name });
          toolResults.push({
            id: call.id,
            text: `Unknown tool "${call.name}". Available: ${tools.map(t => t.name).join(', ')}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: 'unknown tool' },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        // Malformed arguments: refuse, never execute. The provider sent
        // something that was not valid JSON, so `call.args` is an empty
        // placeholder. Running the tool with `{}` would perform a DIFFERENT
        // action from the one the model asked for — e.g. `window close` with
        // no selector targets the foreground window. Same shape as the
        // unknown-tool branch above: report back so the model can re-issue.
        if (call.parseError) {
          log.warn('agent.malformed_tool_args', { turn, tool: call.name, error: call.parseError });
          toolResults.push({
            id: call.id,
            text: `NOT EXECUTED: the arguments for "${call.name}" were not valid JSON (${call.parseError}). Re-issue the call with valid JSON arguments.`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: 'malformed arguments, not executed' },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        let targetLabel = typeof call.args.name === 'string' ? call.args.name
          : typeof call.args.target === 'string' ? call.args.target
          : undefined;
        // el_NN ref clicks carry no name/target — look the element's name up from
        // the holder's CURRENT map so the safety gate sees a real label (correct
        // label-pattern rule + intent-match bypass) instead of the blunt "no target
        // label" confirm. No safety weakening: same gate, more info; a stale/unknown
        // snapshot → no label → blunt confirm still fires (safe default). The action
        // path's own resolveRef still applies the full window guard at execute time.
        if (!targetLabel && call.name === 'invoke_element'
            && typeof call.args.element_id === 'string' && typeof call.args.snapshot_id === 'string') {
          const res = holder.resolve(call.args.snapshot_id, Date.now());
          if (res.ok) {
            const el = res.map.elements.find(e => e.id === call.args.element_id);
            if (el) targetLabel = el.text ?? el.normalized_text ?? undefined;
          }
        }

        // 5a. Safety gate — single chokepoint. Pass through the user's task
        // text so the layer can detect intent-matched bypasses (when the user
        // explicitly asked for a destructive action, the confirm tier is
        // skipped — the agent isn't hallucinating a Send click out of nowhere,
        // the user typed "hit send").
        const decision = safetyEvaluate({
          tool: call.name,
          args: call.args,
          targetLabel,
          activeApp,
          userTaskText: input.task,
        });
        if (!isAllowed(decision)) {
          const reason = decision.decision === 'block'
            ? decision.reason
            : decision.decision === 'confirm'
              ? `${decision.reason} — headless run: no human to confirm. DO NOT retry the same click. Name the target instead: find_action_button(intent:"...") then invoke_element({element_id, snapshot_id}), or invoke_element(name:"<label>"). If the user's task explicitly asked for this action, restate that intent.`
              : `requires ${decision.decision}: ${decision.tier}`;
          log.info('agent.tool.blocked', { turn, tool: call.name, decision: decision.decision, reason });
          toolResults.push({
            id: call.id,
            text: `[${decision.decision}] ${reason}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: `safety_${decision.decision}: ${'reason' in decision ? decision.reason : decision.tier}` },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        // 5a' v0.8.3 RUNAWAY GUARD. If the agent has issued the SAME
        // tool+args combination more than REPEAT_THRESHOLD times in the
        // last REPEAT_WINDOW turns, force-exit with `give_up`. This is the
        // fix for the "Outlook keeps opening" class of bug — when the
        // agent can't see the result of its own action (sparse WebView2
        // a11y, for example) it sometimes re-issues the same action every
        // turn. Platform-level idempotency on open_app already prevents
        // duplicate Outlook windows; this guard protects against the same
        // anti-pattern generalized to every tool.
        const REPEAT_THRESHOLD = 3;
        const REPEAT_WINDOW = 6;
        const argKey = JSON.stringify(call.args ?? {});
        const recentRepeats = steps
          .slice(-REPEAT_WINDOW)
          .filter(s => s.toolName === call.name && JSON.stringify(s.toolArgs ?? {}) === argKey)
          .length;
        // Only ACTION tools (changesScreen) can "run away" — re-issuing the
        // same action because the agent can't see its result. Perception tools
        // (screenshot, read_screen, list_windows, wait — all changesScreen:false)
        // are HOW a vision agent sees a canvas that changes every challenge;
        // repeating them is mandatory, not a loop. Counting them aborted a
        // legitimately-progressing vision run mid-exam (live test 2026-05-28).
        //
        // Scroll is also exempt: traversing a long list/panel legitimately
        // repeats the SAME scroll (same x,y,direction,amount) many times — that
        // is forward progress, not a stuck loop. max_turns still caps a truly
        // endless scroll. Observed: scrolling a 60-row list to row 48 tripped
        // the guard after 3 identical scrolls and aborted the run mid-exam.
        const isScroll = call.name === 'scroll'
          || (call.name === 'mouse' && (call.args as Record<string, unknown>)?.action === 'scroll');
        if (tool.changesScreen && !isScroll && recentRepeats >= REPEAT_THRESHOLD) {
          log.warn('agent.runaway_guard', {
            turn, tool: call.name, repeats: recentRepeats, window: REPEAT_WINDOW,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: {
              success: false,
              text: `runaway-guard: ${call.name} called ${recentRepeats} times in last ${REPEAT_WINDOW} turns with same args — aborting to prevent infinite loop`,
            },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          return finish(
            'give_up',
            `runaway-guard: repeated ${call.name} with identical args (${recentRepeats}× in last ${REPEAT_WINDOW} turns). The agent is likely unable to see whether the action succeeded — try a different approach or use detect_webview_apps + CDP bridge if the target is an Electron/WebView2 app.`,
            steps, llmCalls, screenshotsCaptured.n, startedAt,
          );
        }

        // 5a''. cannot_read soft-guard. cannot_read is meant for genuinely
        // unreadable screens (CAPTCHA, blank canvas, OCR garbage). Some models
        // — especially safety-trained text models on irreversible actions like
        // "Send" — try to use it as a "can I have a moment to think" pause AFTER
        // they already located an interactive target. That stalls the pipeline
        // for no good reason. If a perception/locator tool succeeded with REAL
        // CONTENT in the last few turns, refuse cannot_read and tell the model
        // to act on what it already found. Pattern-based; doesn't care which
        // model is asking.
        //
        // v0.9.0: tightened to check for actual content, not just "success".
        // A read_screen that returned "(empty a11y tree — app may be
        // custom-canvas)" is technically successful but has no content for the
        // model to act on — don't block cannot_read in that case.
        if (call.name === 'cannot_read') {
          const LOOKBACK = 4;
          // Resolvers split into two tiers:
          //   STRONG: action-y tools whose success means the agent actually
          //   resolved a specific target (invoke_element, set_field_value,
          //   focus_window). Pure success = real resolution.
          //   WEAK: perception tools (read_screen, screenshot, a11y_snapshot,
          //   list_windows) where success can be returned with empty content.
          //   For those we ALSO require the result text to look non-empty.
          const STRONG_RESOLVERS = new Set([
            'wait_for_element', 'find_element', 'invoke_element', 'set_field_value',
            'focus_window',
          ]);
          const WEAK_RESOLVERS = new Set([
            'read_screen', 'a11y_snapshot', 'screenshot', 'list_windows',
          ]);
          const EMPTY_TREE_HINTS = /empty a11y tree|app may be custom-canvas|\(empty\)|\(no elements found\)|no elements/i;
          const recentReal = steps.slice(-LOOKBACK).some(s => {
            if (!s.result.success) return false;
            if (STRONG_RESOLVERS.has(s.toolName)) return true;
            if (WEAK_RESOLVERS.has(s.toolName)) {
              const txt = (s.result as { text?: string }).text ?? '';
              if (!txt || txt.length < 60) return false;
              if (EMPTY_TREE_HINTS.test(txt)) return false;
              return true;
            }
            return false;
          });
          if (recentReal) {
            log.info('agent.cannot_read.suppressed', {
              turn, reason: 'recent perception or locator returned real content',
              lookback: LOOKBACK,
            });
            toolResults.push({
              id: call.id,
              text: 'cannot_read refused: a recent perception/locator tool succeeded with real content in this run, so the screen IS readable. Act on what you already located (invoke_element / mouse_click / key) instead. cannot_read is for blank/garbled screens only.',
              isError: true,
            });
            steps.push({
              turn,
              toolName: call.name,
              toolArgs: call.args,
              result: { success: false, text: 'cannot_read suppressed (perception just succeeded)' },
              durationMs: Date.now() - turnStart,
              fingerprintChanged: false,
              thought: llmResult.text,
            });
            continue;
          }
        }

        // 5a'''. BLIND-MODE RAW-COORDINATE-CLICK GUARD.
        //
        // Failure mode (BUG-D): in blind mode the LLM sometimes can't locate
        // a target in the a11y snapshot and, instead of emitting `cannot_read`,
        // starts random-clicking at guessed coordinates like click(1280,800).
        // In a live run, this advanced an exam-test UI from the landing screen
        // through several screens — real user-visible state damage — before
        // the verifier even ran. The verifier alone (confidence threshold) is
        // not a sufficient safety net because a more confident model could
        // produce false-positive success.
        //
        // The guard: in blind mode, refuse `click(x, y)` unless an a11y-aware
        // selector tool (invoke_element / set_field_value / focus_element /
        // a11y_select / a11y_toggle / a11y_expand / a11y_collapse /
        // wait_for_element) SUCCEEDED in the last A11Y_RECENCY turns. That
        // tight window covers the legitimate "I just located the element by
        // a11y; coord-click as fallback" pattern while rejecting guesses.
        //
        // 5b. Log and execute.
        log.info(EVENTS.AGENT_TOOL_CALL, { turn, tool: call.name, args: compactArgs(call.args), costClass: TOOL_META[call.name]?.costClass });
        const toolStart = Date.now();
        const ctx: AgentToolContext = {
          platform: deps.adapter,
          task: input.task,
          screen,
          screenshotsCaptured,
          activeApp,
          targetWindow: input.targetWindow,
          cdp: deps.cdp ?? null,
          uiMaps: holder,
          coordSpaceDefault: imageInContext ? 'image' : 'screen',
          // P1 verification integrity — the `done` gate reads these.
          taskStartedAt: startedAt,
          mutatedScreen: taskMutated,
          taskBaseline,
        };

        // Validate `expect` BEFORE acting — a malformed one is refused with
        // nothing executed, so a retry cannot double-act.
        const expectError = validateExpect((call.args as Record<string, unknown>).expect);
        let result: Awaited<ReturnType<UnifiedTool['execute']>>;
        if (expectError) {
          result = { success: false, text: `expect rejected (nothing executed): ${expectError}` };
        } else {
          try {
            result = await tool.execute(call.args, ctx);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result = { success: false, text: `tool threw: ${msg}` };
          }
        }

        const toolMs = Date.now() - toolStart;
        log.info(EVENTS.AGENT_TOOL_RESULT, {
          turn,
          tool: call.name,
          success: result.success,
          ms: toolMs,
          // 200 (was 120) so the click/drag coordinate-space + focus breadcrumb
          // survives — that line is what makes wrong-window clicks diagnosable.
          text: truncate(result.text, 200),
        });

        // 5c. Re-capture perception if the tool changed the screen. We do
        // this AFTER the tool, BEFORE stagnation detection.
        let postSnapshot: Awaited<ReturnType<typeof captureSnapshot>> | null = null;
        if (tool.changesScreen) {
          try {
            postSnapshot = await captureSnapshot(deps.adapter);
            activeApp = postSnapshot.activeWindow?.processName ?? activeApp;
          } catch {
            postSnapshot = null;
          }
        }

        const fingerprintChanged = postSnapshot ? fph.getHistory().slice(-1)[0] !== postSnapshot.fingerprint : false;
        if (postSnapshot) fph.push(postSnapshot.fingerprint);

        // Invalidate the UIMap holder only when the action actually DID
        // something: the tool reported success, or the fingerprint moved
        // anyway (a failed action that still touched the screen). A rejected
        // action that provably changed nothing must NOT stale the current
        // map — keying on the static changesScreen flag alone meant every
        // ref-rejection re-minted the map and inflated the stagnation
        // counter (audit 2026-06-10, findings A1/M3).
        if (tool.changesScreen && (result.success || fingerprintChanged)) {
          anyScreenChangingTool = true;
          taskMutated = true; // P1: task-level — the `done` gate requires proof
          holder.invalidate();
        }

        // Layer C: reactive step discipline — verify the agent-stated `expect`
        // (HARD → DEVIATION) or apply the tolerant soft net when omitted. Reuses
        // the verify engine + the fingerprintChanged signal already computed.
        const reactive = expectError ? null : await reactiveCheck({
          expect: (call.args as Record<string, unknown>).expect,
          toolText: result.text,
          toolSuccess: result.success,
          changesScreen: tool.changesScreen,
          observedChange: fingerprintChanged,
          adapter: deps.adapter,
          ocrText: async () => (await reactiveOcr().recognizeScreen()).fullText ?? '',
        }).catch(() => null);
        if (reactive) {
          result = { ...result, success: reactive.success, text: reactive.text };
        }

        steps.push({
          turn,
          toolName: call.name,
          toolArgs: call.args,
          result: { success: result.success, text: result.text },
          durationMs: toolMs,
          fingerprintChanged,
          thought: llmResult.text,
        });

        toolResults.push({
          id: call.id,
          text: result.text,
          isError: !result.success,
          screenshot: result.screenshot,
          stop: result.stop,
          terminalExit: result.terminalExit,
        });

        // Terminal action → wrap up after this turn.
        if (result.stop && result.terminalExit) {
          terminal = { exit: result.terminalExit, text: result.text };
          break;
        }
      }

      // 6. Build next-turn user payload: tool_result blocks + fresh
      //    perception + (for hybrid/vision) optional screenshot of the
      //    post-action state.
      const nextBlocks: LLMUserBlock[] = [];

      // 6a. tool_result blocks preserve the Anthropic contract and feed
      //     OpenAI's `tool` messages when we normalize in llm-client.
      for (const tr of toolResults) {
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
          { type: 'text', text: tr.text },
        ];
        if (tr.screenshot) {
          content.push(shotToInnerBlock(tr.screenshot));
        }
        nextBlocks.push({ type: 'tool_result', tool_use_id: tr.id, content, is_error: tr.isError });
      }

      // 6b. If any tool changed the screen, append a fresh COMPILED UI map
      //     (el_NN) for the next turn — the single per-turn perception (the
      //     legacy a11y-snapshot render was unified away into this map).
      const anyChanged = toolResults.some(r => !!r.screenshot) || steps[steps.length - 1]?.fingerprintChanged;
      if (anyChanged || toolResults.length > 0) {
        try {
          const snap = await captureSnapshot(deps.adapter);
          activeApp = snap.activeWindow?.processName ?? activeApp;
          nextBlocks.push({
            type: 'text',
            text: `\nRECENT ACTIONS:\n${renderHistory(steps, 6)}`,
          });
          // §6b UIMap (Part 2): compile + store a UIMap from the already-captured
          // snapshot (no second a11y read). Skip on terminal turns — the loop
          // exits right after, so a re-put would un-invalidate the holder and mask
          // the changesScreen invalidation from the prior action turn.
          if (terminal === null) {
            try {
              // Only mint a FRESH perception map when the screen actually changed
              // (or there is no fresh current map). Otherwise reuse the current
              // map — e.g. a finder/compile_ui established one this turn — so its
              // snapshot_id stays current and el_NN refs resolve on the NEXT turn
              // (the realistic find-this-turn / act-next-turn flow). Reusing also
              // avoids a redundant recompile when nothing changed.
              const curId = holder.currentId();
              const currentFresh = curId !== undefined && holder.resolve(curId, Date.now()).ok === true;
              let uiId: string;
              let uiRender: string;
              if (anyScreenChangingTool || !currentFresh) {
                const ui = await storeUIMap(holder, snap, deps.adapter, prevAnchors);
                prevAnchors = ui.anchors;
                uiId = ui.id;
                uiRender = ui.render;
              } else {
                const cur = holder.current()!;          // currentFresh implies it exists
                uiId = cur.snapshot_id;
                uiRender = renderUIMap(cur);
                // Re-advertising this map to the model — restart its TTL clock
                // so the ref survives the upcoming LLM round-trip (the clock
                // otherwise still runs from the original mid-turn compile).
                holder.touch(uiId, Date.now());
              }
              nextBlocks.push({
                type: 'text',
                text: `\nCOMPILED UI (act on an element via invoke_element/set_field_value with {element_id, snapshot_id="${uiId}"}):\n${wrapUntrustedScreenContent(uiRender)}`,
              });
            } catch {
              // UIMap compilation failure is non-fatal — the agent still has the a11y snapshot.
            }
            // NOTE: deliberately NO invalidate here. The map stored above was
            // compiled from the POST-action snapshot — it is the freshest
            // truth available, and its snapshot_id is exactly what the text
            // block above invites the model to act on next turn. Invalidating
            // it made every advertised el_NN ref dead on arrival (audit
            // 2026-06-10, finding A1). The pre-action staleness hazard is
            // already covered by the 5c invalidation that ran before this map
            // was compiled.
          }
        } catch {
          nextBlocks.push({
            type: 'text',
            text: '\n(perception refresh failed — rely on tool results above)',
          });
        }
      }

      // 6c. Stagnation check — two-stage:
      //
      //  Stage 1 (warn): the last STAGNATION_WINDOW (3) fingerprints are
      //    identical. Tell the agent to change approach — most of the time
      //    a single nudge is enough and we trust it to recover.
      //
      //  Stage 2 (abort): stagnation has fired for STAGNATION_HARD_LIMIT
      //    consecutive turns. The agent is stuck — abort the rung with
      //    `exit: 'stagnation'` so the pipeline ladder climbs to hybrid
      //    or vision. Without this, the agent kept tying actions to a
      //    stale screen until max_turns and then fabricated `done()`
      //    evidence ("the email should have been sent...").
      //
      //  The counter is reset to 0 every turn the fingerprint moves, so
      //  legitimate stagnant patches (slow window opening, transient a11y
      //  hiccup) don't trip the hard limit.
      // Stagnation is only meaningful for turns where the agent *tried* to
      // change the screen. Pure-compute tools (build_uri, wait, list_windows,
      // read_screen, screenshot, ...) legitimately leave the fingerprint
      // unchanged and must not be counted as stale. The previous behavior
      // killed the Outlook send-email run mid-plan: the agent had called
      // build_uri to construct a mailto URI and was one turn away from
      // dispatching it via open_uri when the stagnation hard-abort fired.
      // Pixel evidence overrides the a11y fingerprint. Live run 2026-06-06:
      // an Outlook compose in `olk` (sparse, near-static a11y tree) warned
      // "stagnation" on EVERY turn 7–37 while the screen demonstrably
      // advanced — and the firm nudge ("switch to a FUNDAMENTALLY different
      // method") drove the model to abandon the desktop app for a browser.
      // Any screenshot whose bytes differ from the previous capture proves
      // the screen moved; treat that as fresh progress for a full window.
      for (const tr of toolResults) {
        if (!tr.screenshot?.buffer?.length) continue;
        const digest = createHash('sha1').update(tr.screenshot.buffer).digest('hex');
        if (lastShotDigest !== null && digest !== lastShotDigest) lastPixelMoveTurn = turn;
        lastShotDigest = digest;
      }
      const recentPixelMove = lastPixelMoveTurn > 0 && turn - lastPixelMoveTurn < STAGNATION_WINDOW;
      const stagnant = fph.isStagnant(STAGNATION_WINDOW) && !recentPixelMove;
      // In the hybrid loop the agent perceives via both a11y and screenshots.
      // The a11y fingerprint can stay constant while the screen advances (canvas,
      // browser WebView). Only count stagnation when the agent tried a screen-
      // changing action but the fingerprint stayed the same. The runaway guard
      // and max_turns are the primary backstops for non-stagnation scenarios.
      if (stagnant && anyScreenChangingTool) {
        consecutiveStagnantTurns += 1;
      } else if (!stagnant) {
        consecutiveStagnantTurns = 0;
      }
      // else: neutral turn (compute-only tool) — leave the counter alone.

      // Stagnation in the thin loop is a NUDGE, never a task-kill. The old
      // code here returned exit:'stagnation' to force the pipeline ladder to
      // climb to a hybrid/vision rung — but v1.0.0 removed the ladder, so the
      // abort just killed the task. Worse, the fingerprint is a11y/OCR
      // STRUCTURE only (see fingerprint.ts) — it cannot see a sparse-a11y form
      // app advancing (new Outlook / `olk`, web & canvas UIs). That false
      // signal aborted the Outlook send-email run at turn 33 while it was
      // genuinely progressing (focusing To, typing the recipient). Real stuck-
      // loops (same tool+args repeated) are already caught by the runaway guard
      // above; genuine flailing is capped by max_turns. So here we only
      // ESCALATE the nudge — and steer toward the methods that work when the
      // a11y tree is blind: keyboard-only navigation and focus verification.
      // Warn only on turns where the agent actually TRIED to change the
      // screen. Pure observation/compute turns (screenshot, read_text,
      // list_windows) legitimately leave the fingerprint flat — re-injecting
      // the warning there just spams the prompt with a persistent "you're
      // stuck" signal (it rode along on every screenshot()-only turn in the
      // live Outlook run).
      if (stagnant && anyScreenChangingTool) {
        const firm = consecutiveStagnantTurns >= STAGNATION_HARD_LIMIT;
        log.warn(EVENTS.AGENT_STAGNATION, {
          turn,
          window: STAGNATION_WINDOW,
          consecutiveStagnantTurns,
          fingerprint: fph.getHistory().slice(-1)[0],
          ...(firm ? { firm: true } : {}),
        });
        nextBlocks.push({
          type: 'text',
          text: firm
            ? `\n⚠ STAGNATION (${consecutiveStagnantTurns} turns, no accessibility change). The screen may still be advancing — this app likely has a sparse a11y tree (new Outlook, web/canvas UIs). STOP repeating the last action. Switch APPROACH WITHIN this app: prefer a keyboard-only flow (open a fresh compose, the recipient field is focused — type, Return to commit the chip, Tab to the next field), or find_input_field/find_action_button to get an el_NN target, or call focus_window to confirm the right window is active, or give_up with a concrete reason. Do NOT open the web version of this app or switch to another app.`
            : `\n⚠ STAGNATION (${consecutiveStagnantTurns}/${STAGNATION_HARD_LIMIT}): the last ${STAGNATION_WINDOW} actions did not change the accessibility tree. Try a DIFFERENT approach (keyboard shortcut, Tab between fields, different target, focus_window to check the active window) — or, if the screen really is changing, verify with a screenshot. give_up if you're truly stuck.`,
        });
        // Re-arm after a firm nudge so it recurs in waves (not every turn) and a
        // later genuine change cleanly resets the cadence. max_turns + the
        // runaway guard remain the actual terminators.
        if (firm) consecutiveStagnantTurns = 0;
      }

      history.push({ role: 'user', content: nextBlocks });

      // 7. Trim old screenshots to stay under the token budget.
      trimOldScreenshots(history, MAX_HISTORY_SCREENSHOTS);

      const turnMs = Date.now() - turnStart;
      log.info(EVENTS.AGENT_TURN_END, {
        turn,
        ms: turnMs,
        tools: toolResults.length,
        changed: !!anyChanged,
      });

      if (terminal) {
        return finish(terminal.exit, terminal.text, steps, llmCalls, screenshotsCaptured.n, startedAt);
      }
    }
  } finally {
    outerSpan.end();
  }

  return finish('max_turns', `hit max turns (${maxTurns}) without a terminal action`, steps, llmCalls, screenshotsCaptured.n, startedAt);
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * True if any message in the model's context carries an image block (a
 * screenshot). Such turns must go to the vision model, not the text model.
 * Checks both top-level image blocks and images nested inside tool_result
 * content arrays (the form the screenshot tool produces).
 */
function historyHasImage(history: LLMToolTurn[]): boolean {
  for (const m of history) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      // Top-level image block (direct image in a user turn).
      if (b.type === 'image' || b.type === 'image_url') return true;
      // Image nested inside a tool_result block (produced by the screenshot tool).
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const c of b.content as Array<Record<string, unknown>>) {
          if (c && typeof c === 'object' && c.type === 'image') return true;
        }
      }
    }
  }
  return false;
}

/**
 * Compile a UIMap from an already-captured snapshot and store it in the holder.
 * REUSES the caller's snapshot — never triggers a second a11y read or real OCR/vision.
 * Called in §6b so the agent sees el_NN ids on the NEXT turn.
 */
async function storeUIMap(
  holder: UIMapHolder,
  snap: Awaited<ReturnType<typeof captureSnapshot>>,
  adapter: AgentDeps['adapter'],
  prevAnchors: UIMap['anchors'] | undefined,
): Promise<{ render: string; anchors: UIMap['anchors']; id: string }> {
  const now = Date.now();
  const id = holder.nextId();
  const map = await compileUIMap({
    captureSnapshot: async () => snap,                                    // REUSE — no second a11y read
    ocr: async () => ({ elements: [], fullText: '', durationMs: 0 }),     // loop perception is a11y-only
    vision: async () => { throw new Error('no vision in loop perception'); },
    getScreenSize: () => adapter.getScreenSize(),
    getFocusedElement: () => adapter.getFocusedElement(),
    prevAnchors,
    now, snapshotId: id,
  }, { max_cost: 'cheap' });                                              // cheap = window+a11y only
  holder.put(map, now, 'cheap');
  return { render: renderUIMap(map), anchors: map.anchors, id };
}

function toUnifiedLLMTools(tools: UnifiedTool[]): LLMTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Deep-safe compact — strings over 60 chars are truncated for logs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 60) out[k] = v.slice(0, 57) + '…';
    else out[k] = v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function shotToInnerBlock(shot: ScreenshotResult): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.buffer.toString('base64') },
  };
}

/**
 * How long a screenshot stays in context, measured in HISTORY MESSAGES
 * (each loop turn appends ~2: assistant + user). 6 ≈ 3 turns. After that
 * the image is replaced with a placeholder, so (a) the model stops
 * reasoning over stale pixels, (b) vision-model routing and the
 * image-space coordinate default decay back to text/screen instead of
 * latching for the rest of the run (audit 2026-06-10, finding C1), and
 * (c) the run stops paying vision pricing on image-free turns.
 */
const MAX_SCREENSHOT_AGE_MESSAGES = 6;

/**
 * Remove image content from all but the most recent N RECENT user turns.
 * Keeps the agent in budget when many screenshots accumulate; ages out
 * even the newest screenshot once it falls MAX_SCREENSHOT_AGE_MESSAGES
 * behind the head of history.
 */
function trimOldScreenshots(history: LLMToolTurn[], keepLast: number): void {
  const imageTurnIndices: number[] = [];
  history.forEach((turn, i) => {
    if (Array.isArray(turn.content)) {
      const hasImage = (turn.content as any[]).some(
        b => b.type === 'image' || b.type === 'image_url' ||
             (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'image')),
      );
      if (hasImage) imageTurnIndices.push(i);
    }
  });

  const cutoff = history.length - MAX_SCREENSHOT_AGE_MESSAGES;
  const keep = new Set(imageTurnIndices.filter(i => i >= cutoff).slice(-keepLast));
  const dropList = imageTurnIndices.filter(i => !keep.has(i));
  if (dropList.length === 0) return;

  const dropSet = new Set(dropList);
  for (const i of dropSet) {
    const turn = history[i];
    if (!Array.isArray(turn.content)) continue;
    turn.content = (turn.content as any[]).map(b => {
      if (b.type === 'image' || b.type === 'image_url') {
        return { type: 'text', text: '[earlier screenshot removed to save tokens]' };
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        b.content = b.content.map((c: any) =>
          c.type === 'image' ? { type: 'text', text: '[earlier tool screenshot removed]' } : c,
        );
        return b;
      }
      return b;
    }) as any;
  }
}

function finish(
  exit: AgentExit,
  text: string,
  steps: AgentStep[],
  llmCalls: number,
  screenshotsCaptured: number,
  startedAt: number,
): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps,
    llmCalls,
    screenshotsCaptured,
    durationMs: Date.now() - startedAt,
  };
}

function earlyExit(exit: AgentExit, text: string, startedAt: number): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps: [],
    llmCalls: 0,
    screenshotsCaptured: 0,
    durationMs: Date.now() - startedAt,
  };
}
