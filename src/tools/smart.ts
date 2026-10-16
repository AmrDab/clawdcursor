/**
 * Smart tools — high-level name-based interaction for blind agents.
 *
 * These tools let MCP clients interact with the desktop WITHOUT needing
 * screenshots or coordinate math.
 *
 * Perception order: OCR first (primary), a11y tree in parallel (supplement).
 * If combined OCR+a11y can't handle it → CDP fallback → fail.
 * Vision is never called from here — that's the caller's last resort.
 *
 * Key design: NO coordinate conversion needed by the caller.
 * OCR coords and a11y coords both match nut-js mouseClick coords directly.
 */

import type { ToolDefinition } from './types';
import { OcrEngine } from '../platform/ocr-engine';
import { getBrowserProcessNames } from '../llm/browser-config';
import { windowOcrRegion } from './ocr';

// Shared OCR engine singleton — avoids re-initialization per call
let sharedOcr: OcrEngine | null = null;
function getOcr(): OcrEngine {
  if (!sharedOcr) sharedOcr = new OcrEngine();
  return sharedOcr;
}

// ── Known apps with empty accessibility trees ──
// These apps expose no useful UIA nodes — skip a11y, go straight to OCR.
/** Spoken names of calculator keys (Windows names, macOS AX identifiers). */
const KEY_NAME_ALIASES: Record<string, string[]> = {
  '0': ['Zero'], '1': ['One'], '2': ['Two'], '3': ['Three'], '4': ['Four'],
  '5': ['Five'], '6': ['Six'], '7': ['Seven'], '8': ['Eight'], '9': ['Nine'],
  '+': ['Plus', 'Add'], '-': ['Minus', 'Subtract'], '−': ['Minus', 'Subtract'],
  '*': ['Multiply by', 'Multiply'], '×': ['Multiply by', 'Multiply'], 'x': ['Multiply by', 'Multiply'],
  '/': ['Divide by', 'Divide'], '÷': ['Divide by', 'Divide'],
  '=': ['Equals'], '.': ['Decimal separator', 'Decimal'], ',': ['Decimal separator', 'Decimal'],
  '%': ['Percent'],
};

/** Control types that take typed text, across UIA / AX / AT-SPI names. */
const EDITABLE_TYPE = /edit|entry|textfield|textarea|text field|text area|combo|password|document/i;

const EMPTY_A11Y_APPS = new Set([
  'windowsterminal', 'terminal', 'wt', 'alacritty', 'wezterm',
  'hyper', 'mintty', 'conhost',
]);


/**
 * Convert an OCR hit (PHYSICAL pixels, on every OS) into the coordinate space
 * NativeDesktop.mouseClick expects — which differs by OS (see physicalToMouse):
 *
 *   Windows / Linux — mouseClick takes PHYSICAL and divides by dpiRatio itself.
 *     Dividing here too double-converted: on a 2.25x display an OCR click
 *     landed at ~1/5 of the target.
 *   macOS — mouseClick takes LOGICAL; physicalToMouse is a no-op there. This
 *     division is the ONLY one, mapping Retina-physical OCR coords to logical
 *     points. Removing it re-introduces #154 (every click ~2x off on Retina).
 *
 * Exported so the per-OS rule is pinned by a test: a plausible-looking fix
 * ("just remove the division") fixes Windows and silently breaks every Mac.
 */
export function ocrPointToClickPoint(
  x: number, y: number, dpiRatio: number, platform: NodeJS.Platform,
): { x: number; y: number } {
  const div = platform === 'darwin' ? (dpiRatio || 1) : 1;
  return { x: Math.round(x / div), y: Math.round(y / div) };
}

export function getSmartTools(): ToolDefinition[] {
  return [
    // ─── smart_read ──────────────────────────────────────────────────────
    {
      name: 'smart_read',
      description:
        'Read text from the screen with automatic fallback. ' +
        'OCR-first pipeline: runs OCR (primary) and a11y tree (supplement) in parallel. ' +
        'Returns structured text without needing a screenshot. Use this as your primary perception tool.',
      parameters: {
        scope: {
          type: 'string',
          description: 'Read scope: "focused" for focused element, "window" for active window, "screen" for full screen',
          required: false,
          enum: ['focused', 'window', 'screen'],
        },
        target: {
          type: 'string',
          description: 'Element name to read from specifically. Alias: "name".',
          required: false,
        },
        name: {
          type: 'string',
          description: 'Alias for "target".',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Limit to specific process',
          required: false,
        },
      },
      category: 'perception',
      safetyTier: 0,
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const scope = (params.scope as string) || 'window';
        const target = (params.target ?? params.name) as string | undefined;
        const processId = params.processId as number | undefined;

        // ── Focused element read (shortcut — no OCR needed) ──
        if (scope === 'focused') {
          try {
            const el = await ctx.a11y.getFocusedElement();
            if (el) {
              return {
                text: `[via UI Automation focused element]\n${JSON.stringify(el, null, 2)}`,
              };
            }
          } catch { /* fall through */ }
        }

        // ── Target-specific read (a11y search — precise) ──
        if (target) {
          try {
            const elements = await ctx.a11y.findElement({ name: target, processId });
            if (elements?.length) {
              const lines = elements.slice(0, 10).map((el: any) =>
                `[${el.controlType}] "${el.name}" id:${el.automationId} @${el.bounds.x},${el.bounds.y} ` +
                `${el.bounds.width}x${el.bounds.height}` +
                (el.value ? ` value="${el.value}"` : '') +
                (el.isEnabled === false ? ' DISABLED' : '')
              );
              return { text: `[via UI Automation search]\n${lines.join('\n')}` };
            }
          } catch { /* fall through */ }
        }

        // ── OCR + a11y in parallel (OCR is primary, a11y supplements) ──
        const activeWin = await ctx.a11y.getActiveWindow().catch(() => null);
        const appName = activeWin?.processName?.toLowerCase() || '';
        const hasA11y = !EMPTY_A11Y_APPS.has(appName);

        // Launch both in parallel
        const ocrPromise = (async () => {
          try {
            const engine = getOcr();
            if (!engine.isAvailable()) return null;
            const result = await engine.recognizeScreen();
            if (result.elements.length === 0) return null;

            // Group by line for readability
            const lines = new Map<number, typeof result.elements>();
            for (const el of result.elements) {
              const lineEls = lines.get(el.line) ?? [];
              lineEls.push(el);
              lines.set(el.line, lineEls);
            }
            const ocrLines: string[] = [];
            for (const [, lineEls] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
              ocrLines.push(lineEls.sort((a, b) => a.x - b.x).map(el => el.text).join(' '));
            }
            return { text: ocrLines.join('\n'), count: result.elements.length, ms: result.durationMs };
          } catch { return null; }
        })();

        const a11yPromise = (async () => {
          if (!hasA11y || scope === 'screen') return null;
          try {
            const active = processId ?? activeWin?.processId;
            const context = await ctx.a11y.getScreenContext(active);
            if (context && context.length > 50) return context;
          } catch { /* */ }
          return null;
        })();

        const [ocrResult, a11yResult] = await Promise.all([ocrPromise, a11yPromise]);

        // OCR succeeded — return OCR text, attach a11y tree if available
        if (ocrResult) {
          const a11ySuffix = a11yResult
            ? `\n\n=== A11Y TREE (supplement) ===\n${a11yResult}`
            : '';
          return {
            text: `[via OCR — ${ocrResult.count} lines, ${ocrResult.ms}ms]\n${ocrResult.text}${a11ySuffix}`,
          };
        }

        // OCR failed but a11y succeeded — return a11y alone
        if (a11yResult) {
          return { text: `[via UI Automation active window]\n${a11yResult}` };
        }

        // ── CDP fallback (browser content) ──
        try {
          if (await ctx.cdp.isConnected()) {
            const page = ctx.cdp.getPage();
            if (page) {
              const title = await page.title().catch(() => '');
              const text = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '').catch(() => '');
              if (text) {
                return { text: `[via CDP — "${title}"]\n${text}` };
              }
            }
          }
        } catch { /* fall through */ }

        return { text: '(could not read screen via any method)', isError: true };
      },
    },

    // ─── smart_click ─────────────────────────────────────────────────────
    {
      name: 'smart_click',
      description:
        'Click a UI element by its visible name — works even where the accessibility tree is empty ' +
        '(web pages, canvas apps): an a11y invoke and an OCR text match run in parallel and the first to ' +
        'succeed wins; CDP is the last fallback. No screenshot or coordinate math needed — just the element text. ' +
        'For an element the tree already names, `invoke` is the most direct.',
      parameters: {
        target: {
          type: 'string',
          description: 'Element name/text to click (e.g., "Send", "Submit", "New Email"). Alias: "name".',
          required: false,
        },
        name: {
          type: 'string',
          description: 'Alias for "target" — the rest of the accessibility surface uses "name".',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Limit search to a specific process. OCR matches outside the window of that process are refused, never clicked.',
          required: false,
        },
        timeout: {
          type: 'number',
          description: 'Max time in ms (default 5000)',
          required: false,
        },
      },
      category: 'orchestration',
      safetyTier: 1,
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const target = (params.target ?? params.name) as string;
        if (!target || typeof target !== 'string' || target.trim() === '') {
          return { text: 'smart_click: "target" (alias "name") is required — the element text to click, e.g. "Send".', isError: true };
        }
        const processId = params.processId as number | undefined;
        const timeoutMs = (params.timeout as number) || 10000; // default 10s, was 5s
        const attempted: string[] = [];

        // Deadline-aware budget. Each fallback checks `remaining()` BEFORE
        // starting an expensive operation. If <500ms remain we skip and
        // record a `deadline_exceeded_before_*` entry so the outer wall-clock
        // timeout never fires mid-fallback and discards diagnostic state.
        // See issue #101: bare `Promise.race` swallowed the inner work's
        // candidates[] / attempted[] arrays whenever it lost the race.
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        const remaining = () => Math.max(0, deadline - Date.now());
        const MIN_BUDGET_MS = 500;

        // Structured candidate evidence — populated as each subsystem reports
        // what it saw (e.g. OCR matched the text but the click didn't take).
        // Surfaces in the JSON failure payload so callers can debug WHY a
        // click missed, not just THAT it missed.
        type Candidate = {
          source: 'ocr' | 'a11y' | 'cdp';
          text: string;
          bounds: { x: number; y: number; w: number; h: number };
          confidence: number | null;
        };
        const candidates: Candidate[] = [];

        const buildFailure = (
          error: 'no_clickable_target' | 'deadline_exceeded',
          reason: string,
        ) => {
          const payload = {
            error,
            reason,
            target,
            candidates,
            tried: attempted,
            elapsedMs: Date.now() - startedAt,
          };
          return { text: JSON.stringify(payload), isError: true };
        };

        // Detect active window and check traits
        const activeWin = await ctx.a11y.getActiveWindow().catch(() => null);
        const appName = activeWin?.processName?.toLowerCase() || '';
        const isBrowser = getBrowserProcessNames().includes(appName);
        const emptyA11y = EMPTY_A11Y_APPS.has(appName);

        // The window an OCR match must fall in: the caller's process when one is
        // named (live macOS: processId=Calculator, yet the menu-bar clock was
        // clicked), else the focused window.
        let scopeWin: { bounds?: { x: number; y: number; width: number; height: number } } | null = activeWin;
        if (processId && activeWin?.processId !== processId) {
          const wins: Array<{ processId: number; isMinimized?: boolean; bounds: { x: number; y: number; width: number; height: number } }> =
            await Promise.resolve(ctx.a11y.getWindows?.(true)).catch(() => []) ?? [];
          scopeWin = wins
            .filter(w => w.processId === processId && !w.isMinimized && w.bounds?.width > 0 && w.bounds?.height > 0)
            .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] ?? null;
        }
        // Set when OCR matched only outside the caller's window and was refused.
        let ocrRefused = false;

        // ── Step 1: OCR + a11y in parallel ──
        // OCR finds text coordinates, a11y tries invoke — whoever succeeds first wins.

        // Start OCR scan
        type OcrHit = { x: number; y: number; text: string; warning?: string; bounds: { x: number; y: number; w: number; h: number }; confidence: number | null; sentence?: string };
        // Why OCR gave no target, for the failure report: "no match" alone hid
        // whether OCR failed, read nothing, or read text that didn't match.
        let ocrDiag: string | null = null;
        const ocrPromise: Promise<OcrHit | null> = (async (): Promise<OcrHit | null> => {
          try {
            const engine = getOcr();
            if (!engine.isAvailable()) { ocrDiag = 'ocr: engine unavailable'; return null; }
            const result = await engine.recognizeScreen();
            const wordsRead = result.elements?.length ?? 0;
            ocrDiag = wordsRead === 0 ? 'ocr: read no text on screen' : `ocr: read ${wordsRead} words, none matched`;

            // Pick best OCR candidate from a (possibly filtered) subset.
            // Builds n-grams from adjacent same-line tokens so a multi-word
            // target like "begin exam" matches the actual button (whose OCR
            // output is two adjacent tokens "begin" + "exam") rather than the
            // first stray occurrence of one of those words in unrelated
            // instructional text. Returns null if no candidate clears 0.5.
            const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const targetNorm = norm(target);
            const targetWords = targetNorm.split(' ').filter(Boolean);
            const targetWordSet = new Set(targetWords);
            // A short or numeric target ("1", "OK", "50") is a whole token or
            // nothing: "1" inside the menu-bar clock's "14" scored 0.45 and was
            // clicked (live macOS 2026-10-15).
            const wholeTokenOnly = targetNorm.length <= 2 || /^[\d ]+$/.test(targetNorm);

            const pickBest = (cands: typeof result.elements) => {
              // Group by OCR line index; sort each line left-to-right
              const lineMap = new Map<number, typeof cands>();
              for (const el of cands) {
                if (!el.text) continue;
                const arr = lineMap.get(el.line) ?? [] as typeof cands;
                arr.push(el);
                lineMap.set(el.line, arr);
              }

              let bestMatch: typeof cands[number] | null = null;
              let bestScore = 0;
              let bestSentence: string | undefined;

              const scorePhrase = (phrase: string, tokenCount: number) => {
                if (!phrase) return 0;
                if (phrase === targetNorm) return 1.0;
                if (wholeTokenOnly) return 0;
                // A single-character token can never claim a multi-char target.
                // OCR routinely emits stray 1-char fragments ("O", "x", "|"),
                // and the substring rule below scores "O" vs "OK" at
                // min(1,2)/max(1,2)*0.9 = 0.45 — above the 0.4 floor. Live
                // regression 2026-06-06: smart_click("OK") on a discard-draft
                // dialog clicked a stray "O" near the taskbar instead.
                if (phrase.length === 1 && targetNorm.length > 1) return 0;
                // Nor can a 2-char FRAGMENT of a longer target: "in" inside
                // "sin" scored 0.6 and smart_click("sin") clicked an "in" in
                // another window while xcalc's key went unread (VM 2026-10-15).
                if (phrase.length === 2 && targetNorm.length > 2 && targetNorm.includes(phrase)) return 0;
                let raw: number;
                if (phrase.includes(targetNorm) || targetNorm.includes(phrase)) {
                  raw = Math.min(phrase.length, targetNorm.length) / Math.max(phrase.length, targetNorm.length) * 0.9;
                } else {
                  // Token-overlap fallback (handles transposed / partial matches)
                  const phraseWords = phrase.split(' ').filter(Boolean);
                  if (!phraseWords.length) return 0;
                  // Coverage counts DISTINCT target words present. Counting
                  // phrase tokens let a repeat stand in for a missing word:
                  // "Row Row" covered 2/2 of "Row 50" and the wrong row was
                  // clicked (live, 2026-10).
                  const phraseWordSet = new Set(phraseWords);
                  const overlap = [...targetWordSet].filter(w => phraseWordSet.has(w)).length;
                  const cov = overlap / targetWordSet.size;
                  // OCR dropped ONE word of a 3+ word label (live macOS: "Make
                  // Plain Text" read as "Make … Text"): the rest present in
                  // order, first and last words intact. Below a full match.
                  let ti = 0;
                  for (const w of phraseWords) { while (ti < targetWords.length && targetWords[ti] !== w) ti++; ti++; }
                  const droppedOne = targetWords.length >= 3 && phraseWords.length === targetWords.length - 1
                    && phraseWords[0] === targetWords[0] && phraseWords[phraseWords.length - 1] === targetWords[targetWords.length - 1]
                    && ti <= targetWords.length;
                  if (cov >= 1) raw = 0.85;
                  else if (droppedOne) raw = 0.6;
                  else if (cov >= 0.5) raw = 0.5 * cov;
                  else return 0;
                }
                // Penalize a SINGLE token claiming to match a MULTI-WORD target
                // (the exact failure mode that mis-clicked "begin" in instruction
                // text instead of the actual "begin exam" button).
                if (targetWords.length > 1 && tokenCount === 1 && raw < 0.95) raw *= 0.55;
                return raw;
              };

              const recordCandidate = (span: typeof cands, score: number) => {
                if (score <= bestScore) return;
                bestScore = score;
                // Synthesize a virtual element covering the full n-gram bounds
                // so the click lands at its visual centroid, not the first token.
                const minX = Math.min(...span.map(t => t.x));
                const minY = Math.min(...span.map(t => t.y));
                const maxX = Math.max(...span.map(t => t.x + t.width));
                const maxY = Math.max(...span.map(t => t.y + t.height));
                const head = span[0];
                bestMatch = {
                  ...head,
                  text: span.map(t => t.text).join(' '),
                  x: minX,
                  y: minY,
                  width: maxX - minX,
                  height: maxY - minY,
                  confidence: span.reduce((a, t) => a + (t.confidence ?? 0), 0) / span.length,
                };
              };

              const MAX_N = Math.min(8, targetWords.length + 2);
              // Two tokens belong to one visual chunk (a phrase) unless a big
              // horizontal gap separates them.
              const joined = (a: typeof cands[number], b: typeof cands[number]) =>
                b.x - (a.x + a.width) <= Math.max(a.height * 1.5, 30);
              for (const lineToks of lineMap.values()) {
                const sorted = [...lineToks].sort((a, b) => a.x - b.x);
                for (let i = 0; i < sorted.length; i++) {
                  for (let n = 1; n <= MAX_N && i + n <= sorted.length; n++) {
                    const span = sorted.slice(i, i + n);
                    // Reject spans with a big horizontal gap (different visual chunks)
                    let contiguous = true;
                    for (let k = 1; k < span.length; k++) {
                      if (!joined(span[k - 1], span[k])) { contiguous = false; break; }
                    }
                    if (!contiguous) continue;
                    const phrase = norm(span.map(t => t.text).join(' '));
                    let score = scorePhrase(phrase, span.length);
                    // A span that is only PART of a longer phrase ("Save" inside
                    // the title "Save as") ranks below the same text standing
                    // alone, the way a button label does. Live 2026-10-14:
                    // smart_click("Save") on Notepad's Save as dialog tied the
                    // title's "Save" with the button's and clicked the title.
                    const inPhrase = (i > 0 && joined(sorted[i - 1], span[0]))
                      || (i + n < sorted.length && joined(span[n - 1], sorted[i + n]));
                    if (inPhrase) score *= 0.95;
                    if (score > bestScore) {
                      recordCandidate(span, score);
                      // Inside a SENTENCE (2+ more words in the same visual
                      // chunk): that is running text, not a control's label.
                      let l = i, r = i + n - 1;
                      while (l > 0 && joined(sorted[l - 1], sorted[l])) l--;
                      while (r + 1 < sorted.length && joined(sorted[r], sorted[r + 1])) r++;
                      bestSentence = r - l + 1 >= n + 2 ? sorted.slice(l, r + 1).map(t => t.text).join(' ') : undefined;
                    }
                  }
                }
              }
              return bestMatch && bestScore >= 0.4 ? { match: bestMatch, score: bestScore, sentence: bestSentence } : null;
            };

            // Prefer matches inside the focused window's bounds — full-screen OCR can
            // see text in background windows (e.g. Outlook visible behind a "Pick an
            // account" dialog showing the same email). Only widen to the full screen
            // when the foreground window has no match. See issue #71.
            // Window bounds are screen coordinates (points on macOS), OCR is
            // physical pixels: compare in OCR space, or on a Retina Mac the
            // window's own text never counts as inside it.
            const winBounds = windowOcrRegion(scopeWin?.bounds, ctx.desktop.getDpiRatio?.() || 1, process.platform);
            let pick: { match: typeof result.elements[number]; score: number; sentence?: string } | null = null;
            let warning: string | undefined;

            if (winBounds) {
              const inWindow = result.elements.filter(el => {
                const cx = el.x + el.width / 2;
                const cy = el.y + el.height / 2;
                return cx >= winBounds.x && cx < winBounds.x + winBounds.width &&
                       cy >= winBounds.y && cy < winBounds.y + winBounds.height;
              });
              pick = pickBest(inWindow);
            }

            // The caller scoped the click to a process: a match anywhere else is
            // refused, never clicked with a warning.
            if (!pick && processId) {
              const outside = pickBest(result.elements) as { match: typeof result.elements[number] } | null;
              ocrRefused = !!outside;
              ocrDiag = !winBounds
                ? `ocr: no visible window for process ${processId}, so no OCR click was made`
                : outside
                  ? `ocr: "${outside.match.text}" matched only outside the window of process ${processId}; refused, nothing clicked`
                  : `ocr: read ${wordsRead} words, none matched inside the window of process ${processId}`;
              return null;
            }
            // Fall through to full-screen only if foreground produced nothing.
            // Annotate the response so the caller has a signal that the click may
            // have landed in a background window.
            if (!pick) {
              pick = pickBest(result.elements);
              if (pick && winBounds) {
                warning = 'matched outside focused window';
              }
            }

            if (!pick) return null;
            const m = pick.match;
            return {
              x: m.x + Math.round(m.width / 2),
              y: m.y + Math.round(m.height / 2),
              text: m.text,
              warning,
              bounds: { x: m.x, y: m.y, w: m.width, h: m.height },
              confidence: typeof (m as any).confidence === 'number' ? (m as any).confidence : null,
              sentence: pick.sentence,
            };
          } catch (err) {
            ocrDiag = `ocr: failed (${err instanceof Error ? err.message.slice(0, 80) : String(err)})`;
            return null;
          }
        })();

        // Start a11y invoke in parallel
        type A11yHit =
          | { method: 'invoke'; pending?: boolean; lateInvokeError?: string }
          | { method: 'bounds'; clickPoint: { x: number; y: number }; bounds?: { x: number; y: number; w: number; h: number }; text?: string };
        const a11yPromise: Promise<A11yHit | null> = (async (): Promise<A11yHit | null> => {
          if (emptyA11y) return null;
          try {
            const aliases = KEY_NAME_ALIASES[target.trim().toLowerCase()] ?? [];
            // The Windows bridge THROWS on "not found" (others return a miss):
            // with key-name aliases to try, treat that as a miss, not the end.
            let result = await ctx.a11y.invokeElement({
              name: target,
              processId: processId || activeWin?.processId,
              action: 'click',
            }).catch((err: unknown) => {
              if (aliases.length && /not found/i.test(err instanceof Error ? err.message : String(err))) return { success: false } as { success: boolean; clickPoint?: { x: number; y: number } };
              throw err;
            });
            // Calculator keys are named in words ("One", "Multiply by", AX
            // identifier "One" on macOS), and OCR rarely reads a lone digit on
            // a button: try the spoken names before giving up.
            for (const alias of aliases) {
              if (result.success || result.clickPoint) break;
              result = await ctx.a11y.invokeElement({ name: alias, processId: processId || activeWin?.processId, action: 'click' })
                .catch(() => result);
            }
            if (result.success) {
              const data = (result as any).data;
              return { method: 'invoke', pending: data?.pending === true, lateInvokeError: typeof data?.lateInvokeError === 'string' ? data.lateInvokeError : undefined };
            }
            if (result.clickPoint) return { method: 'bounds', clickPoint: result.clickPoint };
            return null;
          } catch (err) {
            // Invocation threw (e.g. RPC error on UWP apps) — try to get bounds for coordinate fallback.
            // Not for a plain "not found": a second full-tree search finds
            // nothing either and doubled the wait (live macOS: 24 s).
            if (/not found/i.test(err instanceof Error ? err.message : String(err)) || remaining() < MIN_BUDGET_MS) return null;
            try {
              const elements = await ctx.a11y.findElement({
                name: target,
                processId: processId || activeWin?.processId,
              });
              if (elements?.length) {
                const el = elements[0];
                if (el.bounds?.width > 0) {
                  const cx = el.bounds.x + Math.floor(el.bounds.width / 2);
                  const cy = el.bounds.y + Math.floor(el.bounds.height / 2);
                  return {
                    method: 'bounds',
                    clickPoint: { x: cx, y: cy },
                    bounds: { x: el.bounds.x, y: el.bounds.y, w: el.bounds.width, h: el.bounds.height },
                    text: el.name,
                  };
                }
              }
            } catch { /* fall through */ }
            return null;
          }
        })();

        // Wait for OCR + a11y in parallel, but bounded by the overall deadline.
        // If both subsystems hang we abandon them at the deadline rather than
        // letting an outer race fire — but we keep the diagnostic state we've
        // already collected.
        const parallelResult: { ocr: OcrHit | null; a11y: A11yHit | null; timedOut: boolean; ocrDone: boolean } = {
          ocr: null,
          a11y: null,
          timedOut: false,
          ocrDone: false,
        };
        // The a11y invoke IS the click (it presses the element), so its outcome
        // is always awaited — it carries its own bridge timeout. Abandoning it
        // reported failure while the press still landed a moment later (live
        // macOS 2026-10: deadline_exceeded, then "Row 50" got clicked). Only
        // the read-only OCR search is cut off at the deadline.
        await new Promise<void>((resolve) => {
          let a11yDone = false, ocrDone = false, expired = false;
          const check = () => { if (a11yDone && (ocrDone || expired)) resolve(); };
          const timer = setTimeout(() => {
            parallelResult.timedOut = true;
            expired = true;
            check();
          }, remaining());
          ocrPromise.then(r => { parallelResult.ocr = r; }, () => {}).finally(() => { ocrDone = true; parallelResult.ocrDone = true; check(); });
          a11yPromise.then(r => { parallelResult.a11y = r; }, () => {}).finally(() => { a11yDone = true; check(); });
          // Cancel the deadline timer once both settle so we don't keep the event loop alive
          Promise.allSettled([ocrPromise, a11yPromise]).then(() => clearTimeout(timer));
        });
        const ocrMatch = parallelResult.ocr;
        const a11yResult = parallelResult.a11y;
        const parallelTimedOut = parallelResult.timedOut;
        // OCR finished inside the budget: its "no match" is the answer, even if
        // the a11y search (always awaited) ran past the deadline.
        const ocrCutOff = parallelTimedOut && !parallelResult.ocrDone;

        // a11y invoke succeeded — best outcome (OS-level click, most reliable)
        if (a11yResult && (a11yResult as any).method === 'invoke') {
          ctx.a11y.invalidateCache();
          const stillRunning = (a11yResult as { pending?: boolean }).pending
            ? ' The action is still running — a dialog probably opened; re-read the screen before the next step.' : '';
          const late = (a11yResult as { lateInvokeError?: string }).lateInvokeError;
          const lateNote = late ? ` Note: an earlier action that was still running later failed: ${late}.` : '';
          return { text: `Clicked "${target}" via UI Automation (invoke_element)${stillRunning}${lateNote}` };
        }

        // OCR found the element — coordinate click. OCR returns PHYSICAL
        // pixels (it's running against `screen.grab()` output). On Windows
        // with DPI scaling > 100%, nut-js mouseClick expects LOGICAL pixels,
        // so a physical (1800, 900) on a 2x display would land at logical
        // (1800, 900) — which is far past the actual element. Apply the
        // physical→logical DPI correction. On 100% DPI dpiRatio === 1 and
        // this is a no-op, so the fix is safe across every Windows config
        // and on macOS / Linux (where dpiRatio always returns 1).
        if (ocrMatch) {
          const m = ocrMatch as NonNullable<typeof ocrMatch>;
          // Record the OCR hit as a candidate even on the happy path —
          // if mouseClick throws below, the failure payload still shows
          // "OCR did find the text, the click itself failed".
          candidates.push({
            source: 'ocr',
            text: m.text,
            bounds: m.bounds,
            confidence: m.confidence,
          });
          const { x: cx, y: cy } = ocrPointToClickPoint(
            m.x, m.y, ctx.desktop.getDpiRatio?.() || 1, process.platform,
          );
          try {
            await ctx.desktop.mouseClick(cx, cy);
          } catch (err: any) {
            attempted.push(`ocr_match_click_threw: ${err?.message?.substring(0, 80) || 'unknown'}`);
            return buildFailure('no_clickable_target', 'ocr_match_click_threw');
          }
          ctx.a11y.invalidateCache();
          const warningSuffix = m.warning ? `  [WARNING: ${m.warning} — verify with read_screen]` : '';
          // The match was a word inside running text, not a control's label
          // (live 2026-10-15: "Resume" in the pause pill's message, while OCR
          // never read the button). Check the click did something before
          // calling it a hit: re-read the screen text and the focused window.
          if (m.sentence) {
            await new Promise(r => setTimeout(r, 400));
            let changed: boolean | null = null;
            try {
              const eng = getOcr();
              eng.invalidateCache();
              const after = await eng.recognizeScreen();
              const awAfter = await ctx.a11y.getActiveWindow().catch(() => null);
              // Not a whole-screen text diff: a clock tick or OCR jitter elsewhere
              // reads as "changed" (live: the pause pill). Did the clicked text
              // itself go away, or did the focused window change?
              const flat = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
              changed = !flat(after.fullText ?? '').includes(flat(m.sentence))
                || (awAfter?.title ?? '') !== (activeWin?.title ?? '');
            } catch { /* unverifiable */ }
            const where = `the word inside the text "${m.sentence}"`;
            if (changed === false) {
              // The click WAS performed. Not an error: an error invites a second
              // click, which re-flips a toggle or double-submits (a checkbox whose
              // label is running text stays on screen after a real hit).
              return {
                text: `smart_click "${target}": clicked at ${cx},${cy}, but NOT confirmed — the only OCR match was ${where}, `
                  + `and nothing visible changed. It may be text rather than a control. Do NOT click it again blindly: `
                  + `check the state (accessibility state / read_screen), or find the real control by name (find / compile_ui).`,
              };
            }
            return { text: `Clicked "${target}" via OCR (matched "${m.text}" at ${cx},${cy}) — note: that is ${where}, `
              + `${changed ? 'and the screen changed after the click' : 'and the effect could not be verified'}; check the result.${warningSuffix}` };
          }
          return { text: `Clicked "${target}" via OCR (matched "${m.text}" at ${cx},${cy}${(cx !== m.x || cy !== m.y) ? ` — DPI-corrected from physical ${m.x},${m.y}` : ''})${warningSuffix}` };
        }

        // a11y had bounds but couldn't invoke — coordinate fallback
        if (a11yResult && (a11yResult as any).method === 'bounds') {
          const a = a11yResult as Extract<NonNullable<typeof a11yResult>, { method: 'bounds' }>;
          if (a.bounds) {
            candidates.push({
              source: 'a11y',
              text: a.text ?? target,
              bounds: a.bounds,
              confidence: null,
            });
          }
          try {
            await ctx.desktop.mouseClick(a.clickPoint.x, a.clickPoint.y);
          } catch (err: any) {
            attempted.push(`a11y_bounds_click_threw: ${err?.message?.substring(0, 80) || 'unknown'}`);
            return buildFailure('no_clickable_target', 'a11y_bounds_click_threw');
          }
          ctx.a11y.invalidateCache();
          return { text: `Clicked "${target}" via a11y bounds (coordinate fallback at ${a.clickPoint.x},${a.clickPoint.y})` };
        }

        // Track what was attempted for diagnostics
        if (ocrCutOff) {
          attempted.push('deadline_exceeded_during_ocr_a11y_parallel');
        } else if (parallelTimedOut) {
          attempted.push(`UIA(invoke): search ran past the ${timeoutMs}ms budget`);
        }
        if (emptyA11y) {
          attempted.push(`UIA(skipped): app "${appName}" has known traits: emptyAxTree`);
        } else {
          attempted.push('UIA(invoke): element not found or not invocable');
        }
        attempted.push(ocrDiag ?? (ocrMatch === null ? 'ocr: no text match found' : 'ocr: unavailable'));

        // ── Step 2: CDP click (browser content) ──
        // Deadline-gated so the outer wall-clock can't fire mid-evaluate.
        const cdpBudget = remaining();
        const cdpEligible = isBrowser || (cdpBudget >= MIN_BUDGET_MS &&
          await ctx.cdp.isConnected().catch(() => false));
        if (cdpBudget < MIN_BUDGET_MS) {
          attempted.push('deadline_exceeded_before_cdp');
        } else if (cdpEligible) {
          try {
            const connected = await ctx.cdp.isConnected();
            if (connected) {
              const page = ctx.cdp.getPage();
              if (page) {
                const clicked = await page.evaluate((text: string) => {
                  const selectors = 'button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"], [onclick]';
                  const elements = document.querySelectorAll(selectors);
                  for (const el of elements) {
                    const htmlEl = el as HTMLElement;
                    const elText = htmlEl.textContent?.trim() || htmlEl.getAttribute('aria-label') || htmlEl.getAttribute('title') || '';
                    if (elText.toLowerCase().includes(text.toLowerCase())) {
                      htmlEl.click();
                      return true;
                    }
                  }
                  return false;
                }, target).catch(() => false);

                if (clicked) {
                  ctx.a11y.invalidateCache();
                  return { text: `Clicked "${target}" via CDP (JS click)` };
                }
                attempted.push('CDP: no text match found');
              }
            } else {
              attempted.push('CDP: not connected');
            }
          } catch (err: any) {
            attempted.push(`CDP: ${err.message?.substring(0, 80)}`);
          }
        } else {
          attempted.push(`CDP(skipped): foreground app "${appName}" is not a browser`);
        }

        // All methods failed. Choose the error code based on whether the
        // deadline ate any of our subsystems — if so the caller should retry
        // with a longer timeout; if not, the target is genuinely unfindable.
        const deadlineHit = ocrCutOff || (cdpBudget < MIN_BUDGET_MS && isBrowser);
        if (deadlineHit) {
          return buildFailure('deadline_exceeded', 'deadline_exceeded');
        }
        if (ocrRefused) return buildFailure('no_clickable_target', 'ocr_match_outside_target_window');
        return buildFailure('no_clickable_target', 'all_fallbacks_failed');
      },
    },

    // ─── smart_type ──────────────────────────────────────────────────────
    {
      name: 'smart_type',
      description:
        'Type text into a UI element. With a target, finds and focuses the element, then REPLACES its whole ' +
        'content (select-all, then paste) — pass mode:"append" to keep the content and type at the cursor. ' +
        'Without a target, types at the cursor of the focused element. ' +
        'Uses clipboard paste for reliability (no dropped characters).',
      parameters: {
        text: {
          type: 'string',
          description: 'The text to type',
          required: true,
        },
        target: {
          type: 'string',
          description: 'Element name to focus before typing (optional — types into currently focused element if omitted). Alias: "name".',
          required: false,
        },
        name: {
          type: 'string',
          description: 'Alias for "target".',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Limit search to a specific process',
          required: false,
        },
        mode: {
          type: 'string',
          description: '"replace" (default with a target): select all of the field, then type. "append": type at the cursor, keeping the content (default without a target).',
          required: false,
          enum: ['replace', 'append'],
        },
      },
      category: 'keyboard',
      safetyTier: 1,
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();
        const text = params.text as string;
        const target = (params.target ?? params.name) as string | undefined;
        const processId = params.processId as number | undefined;
        // Setting a field means replacing it: macOS preselects only a file's base
        // name in a Save panel, so pasting there gave "name.txt.txt".
        const replace = params.mode === 'replace' || (params.mode !== 'append' && !!target);

        // If target specified, find and focus it first
        if (target) {
          let focused = false;

          // Try UIA focus
          try {
            const activeWin = await ctx.a11y.getActiveWindow().catch(() => null);
            const appName = activeWin?.processName?.toLowerCase() || '';

            if (!EMPTY_A11Y_APPS.has(appName)) {
              // The Windows bridge throws on "not found" — e.g. when the name
              // matched only a label that can't take focus. Treat it as a miss
              // so the editable-element fallback below still runs.
              const result = await ctx.a11y.invokeElement({
                name: target,
                processId: processId || activeWin?.processId,
                action: 'focus',
              }).catch(() => ({ success: false } as { success: boolean; clickPoint?: { x: number; y: number } }));
              if (result.success) {
                focused = true;
              } else if (result.clickPoint) {
                // Focus failed but we have bounds — click to focus
                // a11y coords match nut-js mouse coords directly
                await ctx.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
                await new Promise(r => setTimeout(r, 100));
                focused = true;
              } else {
                // A label and its field often share the name ("First name"):
                // the first match was the label, which can't take focus. Click
                // the EDITABLE element of that name instead.
                const found = await ctx.a11y.findElement({ name: target, processId: processId || activeWin?.processId }).catch(() => []);
                const field = (found ?? []).filter((el: any) => EDITABLE_TYPE.test(String(el.controlType ?? '')) && !/^text$/i.test(String(el.controlType ?? ''))
                  && el.bounds?.width > 0 && el.bounds?.height > 0)[0];
                if (field) {
                  await ctx.desktop.mouseClick(field.bounds.x + Math.floor(field.bounds.width / 2), field.bounds.y + Math.floor(field.bounds.height / 2));
                  await new Promise(r => setTimeout(r, 100));
                  focused = true;
                }
              }
            }
          } catch { /* fall through */ }

          // Try CDP focus (browser)
          if (!focused) {
            try {
              if (await ctx.cdp.isConnected()) {
                const page = ctx.cdp.getPage();
                if (page) {
                  const found = await page.evaluate((label: string) => {
                    const inputs = document.querySelectorAll('input, textarea, [contenteditable]');
                    for (const el of inputs) {
                      const htmlEl = el as HTMLElement;
                      const ariaLabel = htmlEl.getAttribute('aria-label') || '';
                      const placeholder = htmlEl.getAttribute('placeholder') || '';
                      const name = htmlEl.getAttribute('name') || '';
                      if ([ariaLabel, placeholder, name].some(a => a.toLowerCase().includes(label.toLowerCase()))) {
                        htmlEl.focus();
                        return true;
                      }
                    }
                    return false;
                  }, target).catch(() => false);
                  if (found) focused = true;
                }
              }
            } catch { /* fall through */ }
          }

          if (!focused) {
            return { text: `Could not find element "${target}" to focus before typing`, isError: true };
          }
        }

        // Type via clipboard paste. `mod+v` resolves to Cmd+V on macOS and
        // Ctrl+V everywhere else — the platform-portable key combo handles
        // the OS difference without raw `process.platform` branching here.
        ctx.desktop.takeInputWarning?.();      // a warning left by some earlier keystrokes is not this call's
        // macOS only (the only OS where the keyboard can be refused): remember the clipboard so a refusal can put it back.
        let prior: string | null = null;
        if (process.platform === 'darwin') {
          try { prior = await ctx.a11y.readClipboard(); } catch { /* unreadable: nothing to put back */ }
        }
        try {
          await ctx.a11y.writeClipboard(text);
          await new Promise(r => setTimeout(r, 50));
          if (replace) await ctx.desktop.keyPress('mod+a');
          await ctx.desktop.keyPress('mod+v');
        } catch (err) {
          // The keys were refused (a system dialog owns the keyboard): nothing was typed, so the text must not stay on the
          // user's clipboard. (A paste that worked leaves it there, as smart_type always has.)
          if (prior !== null) await ctx.a11y.writeClipboard(prior).catch(() => {});
          throw err;
        }
        await new Promise(r => setTimeout(r, 100));
        ctx.a11y.invalidateCache();

        const active = await ctx.a11y.getActiveWindow().catch(() => null);
        const activeInfo = active ? `[${active.processName}] "${active.title}"` : '(unknown)';
        // macOS: a modal dialog of another app may have had the keyboard — say where the text went.
        const warn = ctx.desktop.takeInputWarning?.();
        return { text: `Typed ${text.length} chars${target ? ` into "${target}"` : ''}${replace ? ' (replaced its content)' : ''} in ${activeInfo}${warn ? ` ⚠ ${warn}` : ''}` };
      },
    },

    // ─── invoke_element ──────────────────────────────────────────────────
    {
      name: 'invoke_element',
      description:
        'PREFERRED way to act on a named element: invoke its accessibility action (click, set-value, ' +
        'get-value, focus, expand, collapse) — no coordinates, unaffected by DPI or layout. Replies ' +
        '"Invoked …", or says it fell back to a coordinate click, or fails with the reason. ' +
        'If the tree does not name the target, use smart_click (adds OCR).',
      parameters: {
        name: {
          type: 'string',
          description: 'Element name to find',
          required: false,
        },
        automationId: {
          type: 'string',
          description: 'Element automation ID (more precise than name)',
          required: false,
        },
        controlType: {
          type: 'string',
          description: 'Filter by control type (e.g., "ControlType.Button")',
          required: false,
        },
        processId: {
          type: 'number',
          description: 'Target process ID',
          required: false,
        },
        action: {
          type: 'string',
          description: 'Action to perform',
          required: false,
          enum: ['click', 'set-value', 'get-value', 'focus', 'expand', 'collapse'],
        },
        value: {
          type: 'string',
          description: 'Value for set-value action',
          required: false,
        },
      },
      category: 'window',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async (params, ctx) => {
        await ctx.ensureInitialized();

        if (!params.name && !params.automationId) {
          return { text: 'Either "name" or "automationId" is required', isError: true };
        }

        try {
          const result = await ctx.a11y.invokeElement({
            name: params.name,
            automationId: params.automationId,
            controlType: params.controlType,
            processId: params.processId,
            action: params.action || 'click',
            value: params.value,
          });

          if (result.success) {
            ctx.a11y.invalidateCache();
            const valueInfo = result.value ? ` → value: "${result.value}"` : '';
            return { text: `Invoked "${params.name || params.automationId}" (${params.action || 'click'})${valueInfo}` };
          }

          // Coordinate fallback for click actions
          // a11y coords match nut-js mouse coords directly
          if (result.clickPoint && (params.action === 'click' || !params.action)) {
            await ctx.desktop.mouseClick(result.clickPoint.x, result.clickPoint.y);
            ctx.a11y.invalidateCache();
            return { text: `Invoked "${params.name || params.automationId}" via coordinate fallback (${result.clickPoint.x},${result.clickPoint.y})` };
          }

          return {
            text: `invoke_element failed: ${result.error || 'element not found or action not supported'}`,
            isError: true,
          };
        } catch (err: any) {
          // On any invocation error (e.g. RPC_E_SERVERFAULT on UWP apps, AXError on macOS),
          // try a coordinate fallback for click actions by finding the element's bounds.
          if (params.action === 'click' || !params.action) {
            try {
              const elements = await ctx.a11y.findElement({
                name: params.name,
                automationId: params.automationId,
                processId: params.processId,
              });
              if (elements?.length) {
                const el = elements[0];
                if (el.bounds?.width > 0) {
                  const cx = el.bounds.x + Math.floor(el.bounds.width / 2);
                  const cy = el.bounds.y + Math.floor(el.bounds.height / 2);
                  await ctx.desktop.mouseClick(cx, cy);
                  ctx.a11y.invalidateCache();
                  return { text: `Invoked "${params.name || params.automationId}" via coordinate fallback after error (${cx},${cy})` };
                }
              }
            } catch { /* give up */ }
          }
          return { text: `invoke_element error: ${err.message}`, isError: true };
        }
      },
    },
  ];
}
