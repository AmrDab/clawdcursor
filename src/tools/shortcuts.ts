/**
 * Shortcut tools — expose the keyboard shortcuts database to MCP clients.
 *
 * Three tools:
 *   shortcuts_list    — query available shortcuts by category/context; an app or site with an app guide gets the guide
 *   shortcuts_execute — run a shortcut by intent (fuzzy-matched)
 *   save_guide        — keep what an agent learned about an app as a guide on this PC, if the user says yes on the pause card
 *
 * The shortcuts database is src/shortcuts.ts; these tools let MCP clients use it
 * instead of knowing keyboard combos themselves.
 */

import * as os from 'os';
import { createHash } from 'crypto';
import {
  shortcutsFor,
  findShortcut,
  resolveShortcutKey,
  type ShortcutCategory,
  type ShortcutDefinition,
} from '../shortcuts';
import type { ToolDefinition } from './types';
import { findGuide, termsOf } from '../core/guides/store';
import { renderGuide, guideCounts } from '../core/guides/render';
import { prepareGuide, saveLocalGuide, suggestUrl } from '../core/guides/save';
import { pauseGate } from '../core/pause-gate';
import { foreignOverlayState } from '../core/overlay-state';

const VALID_CATEGORIES: ShortcutCategory[] = [
  'navigation', 'browser', 'editing', 'social', 'window', 'file', 'view', 'quick',
];

/**
 * Build a compact shortcut entry for the list response.
 * Includes the resolved key combo for the current platform.
 */
function formatShortcut(s: ShortcutDefinition, platform: NodeJS.Platform): object {
  return {
    id: s.id,
    category: s.category,
    description: s.description,
    intent: s.canonicalIntent,
    key: resolveShortcutKey(s, platform),
    context: s.contextHints?.length ? s.contextHints : undefined,
  };
}

export function getShortcutTools(): ToolDefinition[] {
  return [
    {
      name: 'shortcuts_list',
      description:
        'List available keyboard shortcuts. Filter by category (navigation, browser, editing, social, window, file, view, quick) and/or context (e.g. "reddit", "outlook"). Returns shortcut names, descriptions, and key combos for the current platform. Use this BEFORE reaching for mouse_scroll or mouse_click — there is often a faster keyboard shortcut.',
      parameters: {
        category: {
          type: 'string',
          description: `Filter by category: ${VALID_CATEGORIES.join(', ')}. Omit to list all.`,
          required: false,
          enum: VALID_CATEGORIES as unknown as string[],
        },
        context: {
          type: 'string',
          description: 'Filter by app context (e.g. "reddit", "outlook", "x.com"). Shows context-specific shortcuts that match. An app or site with an app guide (an app id, its name, a process name or a site) returns the guide: its shortcuts for this OS (* = hard to undo), workflows and tips.',
          required: false,
        },
        query: {
          type: 'string',
          description: 'Only the shortcuts whose name or keys contain these words (e.g. "bold", "next tab"). Use it on a big guide.',
          required: false,
        },
      },
      category: 'keyboard',
      safetyTier: 0,
      handler: async ({ category, context, query }) => {
        const platform = os.platform();
        if (context) {
          const guide = findGuide(termsOf(String(context)), undefined, platform);
          if (guide) return { text: renderGuide(guide, platform, typeof query === 'string' ? query : undefined) };
        }
        let filtered = shortcutsFor(platform);   // this OS's shortcuts only
        if (query) {
          const words = String(query).toLowerCase().split(/s+/).filter(Boolean);
          filtered = filtered.filter(s => words.every(w => `${s.id} ${s.description} ${s.canonicalIntent}`.toLowerCase().includes(w)));
        }

        if (category) {
          filtered = filtered.filter(s => s.category === category);
        }

        if (context) {
          const ctx = context.toLowerCase();
          filtered = filtered.filter(s => {
            if (!s.contextHints?.length) return true;
            return s.contextHints.some(h => h.toLowerCase().includes(ctx) || ctx.includes(h.toLowerCase()));
          });
        } else {
          // When no context given, exclude context-specific shortcuts
          // (they'd be confusing without context — e.g. reddit "a" for upvote)
          filtered = filtered.filter(s => !s.contextHints?.length);
        }

        // Drop shortcuts that have NO key on this platform (e.g. macOS-only
        // entries like Hide-Others/App-Exposé resolve to "" on Windows/Linux),
        // and dedupe by id so a stray duplicate definition can't surface the
        // same shortcut twice (gauntlet F6).
        const seen = new Set<string>();
        const results = filtered
          .map(s => formatShortcut(s, platform) as { id: string; key: string })
          .filter(r => {
            if (!r.key || r.key.trim() === '') return false;
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });

        if (results.length === 0) {
          return {
            text: `No shortcuts found${category ? ` in category "${category}"` : ''}${context ? ` for context "${context}"` : ''}. Available categories: ${VALID_CATEGORIES.join(', ')}`,
          };
        }

        return {
          text: JSON.stringify({
            platform,
            count: results.length,
            shortcuts: results,
            hint: 'Run a shortcut with the system compound: { action: "shortcuts_run", intent: "<intent>" }. Or press the key combo directly via computer.key.',
          }, null, 2),
        };
      },
    },

    {
      name: 'shortcuts_execute',
      description:
        'Execute a keyboard shortcut by describing what you want to do (e.g. "scroll down", "close tab", "upvote"). Uses fuzzy matching against the shortcuts database. Provide context (active app name) for app-specific shortcuts like Reddit or Outlook.',
      parameters: {
        intent: {
          type: 'string',
          description: 'What you want to do (e.g. "scroll down", "new tab", "copy", "upvote", "reply to email")',
          required: true,
        },
        context: {
          type: 'string',
          description: 'Active app context for app-specific shortcuts (e.g. "reddit", "outlook"). Auto-detected from active window if omitted.',
          required: false,
        },
      },
      category: 'keyboard',
      safetyTier: 1,
      handler: async ({ intent, context }, ctx) => {
        await ctx.ensureInitialized();

        let contextHint = context ?? '';
        if (!contextHint) {
          try {
            const win = await ctx.a11y.getActiveWindow();
            if (win) {
              contextHint = `${win.processName ?? ''} ${win.title ?? ''}`;
            }
          } catch { /* non-fatal — proceed without context */ }
        }

        const match = findShortcut(intent, os.platform(), {
          contextHint,
          enableFuzzy: true,
        });

        if (!match) {
          const suggestions = shortcutsFor(os.platform())
            .filter(s => !s.contextHints?.length || (contextHint && s.contextHints.some(h => contextHint.toLowerCase().includes(h.toLowerCase()))))
            .slice(0, 10)
            .map(s => `  • "${s.canonicalIntent}" → ${resolveShortcutKey(s, os.platform())} (${s.description})`);

          return {
            text: `No shortcut matched intent "${intent}". Try one of these:\n${suggestions.join('\n')}\n\nOr use key_press directly with a specific key combo.`,
            isError: true,
          };
        }

        const active = await ctx.a11y.getActiveWindow().catch(() => null);
        const activeInfo = active ? `[${active.processName}] "${active.title}"` : '(unknown)';

        await ctx.desktop.keyPress(match.combo);
        ctx.a11y.invalidateCache();

        return {
          text: JSON.stringify({
            executed: match.combo,
            intent: match.canonicalIntent,
            matched: match.matchedIntent,
            matchType: match.matchType,
            description: match.shortcut.description,
            window: activeInfo,
          }),
        };
      },
    },

    {
      name: 'save_guide',
      description:
        'Keep what you learned about an app or site as an app guide on this PC, for next time: its keyboard shortcuts, tips, optionally workflows. ' +
        'Call it once, at the end of a task, after you worked out shortcuts for an app that has no guide (or found a listed one wrong). ' +
        'The user decides: a card on screen asks Save / Save and suggest to clawdcursor-guides / Don\'t save, and the result says which they chose. ' +
        'Nothing is saved when pausing is off. Facts only (shortcuts you saw work or read in the app\'s help), no secrets, nothing about the user.',
      parameters: {
        app: { type: 'string', description: 'save_guide: lowercase id, a-z 0-9 and "-", e.g. "gmail".', required: true },
        name: { type: 'string', description: 'save_guide: display name, e.g. "Gmail".', required: true },
        kind: { type: 'string', description: 'save_guide: "web" (needs domainHints) or "desktop" (needs processNames).', required: true, enum: ['web', 'desktop'] },
        os: { type: 'array', description: 'save_guide: win32 / darwin / linux, only if the guide is for some OSes; omit for all.', required: false, items: { type: 'string' } },
        domainHints: { type: 'array', description: 'save_guide: hostnames of a web app, e.g. ["mail.google.com"].', required: false, items: { type: 'string' } },
        processNames: { type: 'array', description: 'save_guide: process names of a desktop app without .exe, e.g. ["EXCEL"].', required: false, items: { type: 'string' } },
        shortcuts: { type: 'object', description: 'save_guide: {name: chord}, at most 60. name = snake_case, what the key does ("go_to_inbox"). chord = "mod+Return" (mod = Ctrl, or Cmd on macOS), tokens joined by +, a sequence separated by one space ("g i"), keys lowercase, named keys Return Tab Escape Space Backspace Delete Up Down Left Right Home End PageUp PageDown Plus F1-F12; or per OS {"default","darwin","win32","linux"} ("" = none).', required: true },
        consequential: { type: 'array', description: 'save_guide: names of shortcuts that send, post, delete, pay or close (hard to undo).', required: false, items: { type: 'string' } },
        tips: { type: 'array', description: 'save_guide: at most 8 short facts about operating the app.', required: false, items: { type: 'string' } },
        workflows: { type: 'object', description: 'save_guide: optional {id: {name, steps:[{type: pressKey|typeAtFocus|wait|verify, key?, field?, ms?, name?, note?}]}}.', required: false },
      },
      category: 'keyboard',
      safetyTier: 0,
      handler: async (args) => {
        const prepared = prepareGuide(args);
        if ('error' in prepared) return { text: `save_guide: ${prepared.error}`, isError: true };
        const guide = prepared.guide;
        const say = (o: Record<string, unknown>) => ({ text: JSON.stringify(o) });
        if (!(await pauseGate.whenAvailable())) {
          return say({ status: 'not_saved', reason: 'no on-screen card to ask the user on (pausing is off: CLAWD_NO_PAUSE, --no-banner, or not supported on this OS)', next: 'Nothing was saved, and the guide was not shown to anyone. Do not retry.' });
        }
        const { shortcuts, workflows } = guideCounts(guide);
        const label = String(guide.name ?? guide.app).replace(/["\r\n]+/g, ' ').slice(0, 40);
        const message = `Your AI wants to save what it learned about "${label}": ${shortcuts} shortcuts${guide.tips?.length ? `, ${guide.tips.length} tips` : ''}${workflows ? `, ${workflows} workflows` : ''}. Saved only on this PC. Suggesting also opens a prefilled GitHub issue for you to review and send.`;
        const choices = ['Save', 'Save and suggest to clawdcursor-guides', 'Don\'t save'];
        const key = `guide:${guide.app}:${createHash('sha1').update(JSON.stringify(guide)).digest('hex').slice(0, 12)}`;
        const foreign = foreignOverlayState();
        const onScreen = pauseGate.current() ?? (foreign.paused ? { message: 'a pause shown by another clawdcursor process' } : null);
        if (onScreen && !pauseGate.continues(key)) {
          return say({ status: 'busy', waitingFor: onScreen.message, next: 'Another pause is on screen. Ask again once it has been answered.' });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const queued = new AbortController();
        const result = await Promise.race([
          pauseGate.requestWithReply({ message, key, choices }, { signal: queued.signal }),
          new Promise<null>(r => { timer = setTimeout(() => r(null), 45_000); }),
        ]);
        clearTimeout(timer);
        if (result === null && !pauseGate.continues(key)) {
          queued.abort();
          return say({ status: 'busy', next: 'Another pause came up first, so the question was not shown. Ask again once it has been answered.' });
        }
        if (result === null) {
          pauseGate.markWaiting(key);
          return say({ status: 'waiting', next: 'The user has not answered yet. Re-call save_guide with the SAME guide to keep waiting (the card stays up).' });
        }
        pauseGate.forget(key);
        // Only the user's click on the card is a choice (pause-gate.ts answer()): an agent's resume_task never is.
        const choice = result.outcome === 'replied' ? result.choice : undefined;
        if (choice !== choices[0] && choice !== choices[1]) {
          return say({ status: 'declined', next: 'The user did not save it. Do not ask again for this app in this task.' });
        }
        const saved = saveLocalGuide(guide);
        if ('error' in saved) return say({ status: 'not_saved', reason: saved.error, next: 'The user said yes but it could not be saved.' });
        if (choice === choices[0]) return say({ status: 'saved', file: saved.file, next: 'Saved on this PC for the user. One line to the user is enough.' });
        const url = suggestUrl(guide);
        if (!url) return say({ status: 'saved', file: saved.file, suggested: false, next: 'Saved on this PC. It is too long to prefill a GitHub issue, so nothing was opened: the user can send the file themselves.' });
        const { openInBrowser } = await import('../surface/report');
        const opened = await openInBrowser(url).catch(() => false);
        return say({
          status: 'saved_and_suggested', file: saved.file, opened,
          next: opened ? 'Saved on this PC, and the suggestion form is open in the user\'s browser: nothing is sent until they review and submit it.' : 'Saved on this PC, but the browser could not be opened: the user can send the file themselves.',
        });
      },
    },
  ];
}
