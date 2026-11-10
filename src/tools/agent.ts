/**
 * Pause and screenshot tools: hand the desktop to the user for a step only
 * they can do, resume a paused run, and capture the full screen.
 */

import type { ToolDefinition } from './types';
import { setLastFrame } from '../core/agent-loop/coord-scale';
import { pauseGate, parsePauseCard } from '../core/pause-gate';
import { promptSatisfies } from '../core/pause-text';
import { parseAssertions, checkAssertions, renderReport } from '../core/verify/assertions';
import { foreignOverlayState } from '../core/overlay-state';
import { OcrEngine } from '../platform/ocr-engine';

const PAUSE_WAIT_DEFAULT_MS = 45_000; // under common 60s MCP client timeouts
const normMessage = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** OCR for done_when's ocr_contains — created on first use only. */
let pauseOcr: OcrEngine | null = null;
const getPauseOcr = (): OcrEngine => (pauseOcr ??= new OcrEngine());

export function getAgentTools(): ToolDefinition[] {
  return [
    {
      name: 'pause_for_user',
      description:
        'Hand the desktop to the user for a step only they can do (sign in, a password or 2FA code, a CAPTCHA, a choice only they can make, a step your own rules won\'t let you take such as creating an account, downloading a private key or entering a secret, a plan limit or upgrade wall — never click Upgrade / Subscribe yourself) instead of stopping, turning the task down or asking them to come back to this chat. ' +
        'Ask for that ONE step only — e.g. "Sign in to Glama" — and do everything before and after it yourself (navigating, filling forms, clicking through): keep the user on screen as briefly as possible. ' +
        'A step your rules forbid is handed over as wide as your rules draw it; do the rest they allow. When a secret must go into a field or a terminal prompt, put the cursor there and ask only for the paste ("Paste your app-specific password into the Terminal, press Enter, then click Resume"), naming where it goes: never into the prompt\'s own reply box, whose text reaches you; afterwards pass the saved key\'s file path or keychain profile name, never the secret. ' +
        'For a sign-in, a code or a CAPTCHA, pass `done_when` (what shows once their step is done, e.g. [{"type":"element_exists","name":"Sign out"}]) so the prompt clears and you continue the moment they finish, with no Resume click; it must be false now. ' +
        'Never use done_when for a confirmation or a choice: a page can make it true by itself, so only the user\'s click counts there. ' +
        'Shows an on-screen prompt: your message, Resume / End task. ' +
        'While you are driving the desktop, the user is watching the screen, not your chat: ask them on this prompt (use `choices` when there are options), not in your own chat. ' +
        'A question goes in `message`, with `choices` (2-6 short options, one button each) and/or `input` (a text box): a pick comes back as {status:"replied", choice:"<exact option text>"}, typed text as {status:"replied", reply}. Only the user on screen can pick or type. ' +
        'Use it too before an irreversible action the user did not ask for (sending, deleting, paying, closing unsaved work): ask, then follow their answer. Never ask for a password or secret on it. ' +
        'BOUNDED: waits up to `timeout` seconds (default 45). {status:"waiting"} → the user is still busy: re-call with the SAME message, choices and input to keep waiting (re-attaches, the prompt stays up). ' +
        '{status:"resumed"} → re-read the screen, then continue the task. {status:"ended"} → the user stopped it: report back.',
      parameters: {
        message: { type: 'string', description: 'The one thing only the user can do, short, e.g. "Sign in to GitHub", or the question when you pass choices / input. Say "then click Resume" only for a step they do themselves, and not with done_when, choices or input.', required: true },
        choices: {
          type: 'array',
          description: 'A question\'s options: 2-6 distinct one-line strings, each at most 40 characters, one button each. Not with done_when.',
          required: false,
          items: { type: 'string' },
        },
        input: {
          type: 'object',
          description: 'A text box on the prompt ("Don\'t type passwords here"): placeholder (a hint, at most 80 characters), multiline (a longer answer). Not with done_when.',
          required: false,
          properties: {
            placeholder: { type: 'string' },
            multiline: { type: 'boolean' },
          },
        },
        done_when: {
          type: 'array',
          description: 'Optional, for sign-in / code / CAPTCHA steps: conditions that become true once the user has done their step (same types as expect: element_exists, element_value_contains, window_title_contains — any open window —, app_running, file_exists, ocr_contains). Checked every 1.5 s (ocr_contains: 5 s); when all hold, the pause resumes by itself. Rejected if already true now. Set on the first call; a re-call keeps the first one.',
          required: false,
          items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
        },
        timeout: { type: 'number', description: 'Max seconds to wait for the answer before returning {status:"waiting"} (default 45, clamped 1–50). The prompt stays up.', required: false },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ message, timeout, done_when, choices, input }, ctx) => {
        const text = String(message ?? '').trim();
        if (!text) return { text: 'pause_for_user: `message` is required (what the user should do).', isError: true };
        const card = parsePauseCard(choices, input);
        if ('error' in card) return { text: `pause_for_user: ${card.error}`, isError: true };
        const asking = !!(card.choices || card.input);
        if (asking && done_when !== undefined && done_when !== null) {
          return { text: 'pause_for_user: done_when cannot be combined with `choices` / `input`: a question is answered only by the user\'s click or text, never by what shows on screen.', isError: true };
        }
        if (!pauseGate.available()) {
          return {
            text: 'pause_for_user: no on-screen prompt is available on this machine (the overlay is off: --no-banner, CLAWD_NO_BANNER, CLAWD_NO_PAUSE, or not supported on this OS yet). Ask the user in your own chat instead.',
            isError: true,
          };
        }
        // A different card (other options) is a different question: it must not re-attach to the one on screen.
        const key = `mcp:${normMessage(text)}${asking ? `|${JSON.stringify([card.choices ?? null, card.input ?? null])}` : ''}`;
        // Another pause is on screen: do not queue this one behind it. Queued prompts surfaced one after another later,
        // long after anyone needed them (macOS run: ~90 stale prompts). Same message = re-attach (below).
        // Another clawdcursor process's pause counts too: a second prompt on top of the user's is never shown.
        const foreign = foreignOverlayState();
        const onScreen = pauseGate.current() ?? (foreign.paused ? { message: `a pause shown by clawdcursor process ${foreign.pausedBy ?? '?'}` } : null);
        if (onScreen && !pauseGate.continues(key)) {
          return {
            text: JSON.stringify({
              status: 'busy',
              waitingFor: onScreen.message,
              next: !pauseGate.current()
                ? 'Another clawdcursor process has a pause on screen for the user. Wait until it has been answered, then ask again if you still need to.'
                : 'Another pause is already on screen. Wait for it (re-call pause_for_user with ITS message), or have it answered first; then ask again if you still need to.',
            }),
          };
        }
        // done_when: the pause ends by itself once the user's step shows on screen. Only for a NEW pause — a re-call
        // re-attaches to the one on screen and keeps its check (checking again here would call a just-finished step
        // "already true" and start a second prompt).
        let doneWhen: (() => Promise<boolean>) | undefined;
        let donePollMs: number | undefined;
        if (done_when !== undefined && done_when !== null && !pauseGate.continues(key)) {
          const parsed = parseAssertions(done_when);
          if ('error' in parsed) return { text: `pause_for_user: done_when rejected: ${parsed.error}`, isError: true };
          // The prompt shows the message and its own labels and buttons; OCR or a find by name would hit them there at once.
          const selfMatch = parsed.assertions.map(a => promptSatisfies(text, a as { type: string; value?: string; name?: string })).find(Boolean);
          if (selfMatch) {
            return { text: `pause_for_user: done_when rejected: "${selfMatch}" is shown by the prompt itself (your message or its buttons) — the check would find it there at once. Use something that only appears once the user is done.`, isError: true };
          }
          const platform = ctx?.platform;
          if (!platform) return { text: 'pause_for_user: done_when needs the desktop platform, which is not available here.', isError: true };
          const deps = { adapter: platform, ocrText: async () => (await getPauseOcr().recognizeScreen()).fullText ?? '' };
          const now = await checkAssertions(parsed.assertions, deps);
          if (now.ok) {
            return {
              text: `pause_for_user: done_when is already true, so the pause would end at once. Pick conditions that only become true after the user's step (e.g. an element that appears once they are signed in):\n${renderReport(now)}`,
              isError: true,
            };
          }
          doneWhen = async () => (await checkAssertions(parsed.assertions, deps)).ok;
          // A screenshot + OCR per check is heavy; the rest are accessibility / file reads.
          if (parsed.assertions.some(a => a.type === 'ocr_contains')) donePollMs = 5_000;
        }
        const sec = Number(timeout);
        const boundMs = Math.min(50_000, Math.max(1_000, Number.isFinite(sec) && sec > 0 ? sec * 1000 : PAUSE_WAIT_DEFAULT_MS));
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A request still QUEUED (behind another pause, ours or another process's) when this call returns has no one
        // waiting for it: cancel it, or it would surface later as a stale prompt. One already on screen is never cancelled.
        const queued = new AbortController();
        const result = await Promise.race([
          pauseGate.requestWithReply({ message: text, key, doneWhen, donePollMs, ...card }, { signal: queued.signal }),
          new Promise<null>(r => { timer = setTimeout(() => r(null), boundMs); }),
        ]);
        clearTimeout(timer);
        if (result === null && !pauseGate.continues(key)) {
          queued.abort();
          return {
            text: JSON.stringify({
              status: 'busy',
              waitingFor: pauseGate.current()?.message ?? 'a pause shown by another clawdcursor process',
              next: 'Another pause came up first and is still on screen, so yours was not shown. Ask again once it has been answered, if you still need to.',
            }),
          };
        }
        const outcome = result?.outcome ?? null;
        if (outcome === null) {
          pauseGate.markWaiting(key); // only a caller told "waiting" gets the outcome handed over
          return {
            text: JSON.stringify({
              status: 'waiting',
              waitingFor: text,
              next: 'The user has not answered yet. Re-call pause_for_user with the SAME message to keep waiting (re-attaches; the prompt stays up). Do not act on the desktop meanwhile. If the user says in chat that they are done, ask them to click Resume on the pill: only that ends the pause.',
            }),
          };
        }
        pauseGate.forget(key);
        if (outcome === 'replied' && result?.choice !== undefined) {
          return {
            text: JSON.stringify({
              status: 'replied',
              choice: result.choice,
              next: 'The user picked this option on the prompt. It is their answer to your question: follow it, and nothing beyond what it covers. Read the screen again before acting.',
            }),
          };
        }
        if (outcome === 'replied') {
          return {
            text: JSON.stringify({
              status: 'replied',
              reply: result?.reply ?? '',
              next: 'The user typed this instead of clicking Resume ("Something else" on the prompt). It is the user speaking to you: follow it — it may answer your question, give what you asked for, or change the plan. If it still needs the user on screen, pause again with a clearer request. Read the screen again before acting.',
            }),
          };
        }
        if (outcome === 'resumed' || outcome === 'resumed_unverified') {
          return {
            text: JSON.stringify({
              status: 'resumed',
              // A detected resume is screen state a page can write, never the user's confirmation.
              confirmedByUser: outcome === 'resumed' && !result?.detected,
              ...(result?.detected ? { detected: true } : {}),
              next: result?.detected
                ? 'done_when came true, so the user\'s step looks done (observed on screen; not a confirmation by the user). Read the screen, check the step really took, then continue the task.'
                : outcome === 'resumed'
                ? 'The user finished and clicked Resume. The screen may have changed: read it again before acting, then continue the task.'
                : 'Resumed by an AI (resume_task), not by the user on screen: check the screen before assuming the step was done.',
            }),
          };
        }
        return {
          text: JSON.stringify({
            status: outcome === 'timeout' ? 'timed_out' : 'ended',
            next: outcome === 'timeout' ? 'Nobody answered the on-screen prompt. Stop and report back.' : 'The user clicked End task. Stop and report back.',
          }),
        };
      },
    },

    {
      name: 'resume_task',
      description:
        'Resume after a pause for the user when the user tells YOU they finished (normally they click Resume on screen).',
      parameters: {},
      category: 'orchestration',
      safetyTier: 1,
      destructive: false,
      handler: async () => {
        const p = pauseGate.current();
        if (!p) return { text: 'resume_task: nothing is paused.', isError: true };
        const r = pauseGate.answer('resume', 'agent'); // an AI resuming is never the user's on-screen confirmation
        if (!r.ok) return { text: `resume_task: ${r.error}`, isError: true };
        return { text: JSON.stringify({ resumed: true, was: p.message }) };
      },
    },

    {
      name: 'screenshot_full',
      description:
        'Capture the full primary display. Returns base64 image bytes plus a ' +
        '`format` field (`jpeg` by default, `png` if configured); the MCP ' +
        '`image.mimeType` is set to match. Equivalent to desktop_screenshot ' +
        'but returns the full frame unconditionally (no region cropping). ' +
        'Useful for the dashboard\'s /screenshot REST replacement.',
      parameters: {},
      category: 'perception',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async (_params, ctx) => {
        try {
          await ctx.ensureInitialized();
          const frame = await ctx.desktop.captureForLLM();
          setLastFrame(null);   // image coords now refer to this primary capture
          // captureForLLM returns { buffer, scaleFactor, llmWidth, llmHeight,
          // format }. Format is configured per-capture (`'jpeg'` by default,
          // sometimes `'png'`); use it to set the correct mimeType instead
          // of the previous hardcoded 'image/png' which lied for the JPEG path.
          const b64 = Buffer.isBuffer(frame.buffer)
            ? frame.buffer.toString('base64')
            : Buffer.from(frame.buffer).toString('base64');
          const mimeType = frame.format === 'png' ? 'image/png' : 'image/jpeg';
          return {
            text: JSON.stringify({
              scaleFactor: frame.scaleFactor,
              llmWidth: frame.llmWidth,
              llmHeight: frame.llmHeight,
              format: frame.format,
            }),
            image: { data: b64, mimeType },
          };
        } catch (err) {
          return { text: `Screenshot failed: ${(err as Error).message}`, isError: true };
        }
      },
    },
  ];
}
