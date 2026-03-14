/**
 * Shortcut tools — expose the keyboard shortcuts database to MCP clients.
 *
 * Two tools:
 *   shortcuts_list    — query available shortcuts by category/context
 *   shortcuts_execute — run a shortcut by intent (fuzzy-matched)
 *
 * This bridges the gap between the internal ActionRouter (which knows all
 * shortcuts) and external agents calling MCP tools (which previously had
 * to independently know keyboard combos).
 */

import * as os from 'os';
import {
  SHORTCUTS,
  findShortcut,
  resolveShortcutKey,
  type ShortcutCategory,
  type ShortcutDefinition,
} from '../shortcuts';
import type { ToolDefinition } from './types';

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
          description: 'Filter by app context (e.g. "reddit", "outlook", "x.com"). Shows context-specific shortcuts that match.',
          required: false,
        },
      },
      category: 'keyboard',
      handler: async ({ category, context }) => {
        const platform = os.platform();
        let filtered = SHORTCUTS;

        // Filter by category
        if (category) {
          filtered = filtered.filter(s => s.category === category);
        }

        // Filter by context — include shortcuts with no context hints (universal)
        // plus those whose contextHints match the given context
        if (context) {
          const ctx = context.toLowerCase();
          filtered = filtered.filter(s => {
            if (!s.contextHints?.length) return true; // universal shortcut
            return s.contextHints.some(h => h.toLowerCase().includes(ctx) || ctx.includes(h.toLowerCase()));
          });
        } else {
          // When no context given, exclude context-specific shortcuts
          // (they'd be confusing without context — e.g. reddit "a" for upvote)
          filtered = filtered.filter(s => !s.contextHints?.length);
        }

        const results = filtered.map(s => formatShortcut(s, platform));

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
            hint: 'Use shortcuts_execute with the intent string to run a shortcut, or key_press with the key combo directly.',
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
      handler: async ({ intent, context }, ctx) => {
        await ctx.ensureInitialized();

        // Build context hint — use provided context or detect from active window
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
          // Return helpful error with similar shortcuts
          const suggestions = SHORTCUTS
            .filter(s => !s.contextHints?.length || (contextHint && s.contextHints.some(h => contextHint.toLowerCase().includes(h.toLowerCase()))))
            .slice(0, 10)
            .map(s => `  • "${s.canonicalIntent}" → ${resolveShortcutKey(s, os.platform())} (${s.description})`);

          return {
            text: `No shortcut matched intent "${intent}". Try one of these:\n${suggestions.join('\n')}\n\nOr use key_press directly with a specific key combo.`,
            isError: true,
          };
        }

        // Execute the matched shortcut
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
  ];
}
