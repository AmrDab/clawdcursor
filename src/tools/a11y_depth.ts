/**
 * Tranche 2 — accessibility-depth MCP tools: one element by name, and the
 * children of a named element.
 */

import type { ToolDefinition, ToolResult, ToolContext } from './types';
import type { UiElement } from '../platform/types';
import { screenJson, quoteScreenText } from '../core/untrusted-screen-content';

function needPlatform(tool: string): ToolResult {
  return {
    text: `${tool}: platform adapter not initialized`,
    isError: true,
  };
}

/**
 * Default `processId` to the active window's pid when the caller didn't
 * supply one. Without this, UIA / AX searches walk the entire system
 * tree and take 10-20+ seconds (or hang altogether). Pre-scoping to the
 * focused app's process is virtually always what a caller wants.
 */
async function resolveProcessId(
  ctx: ToolContext,
  supplied: number | undefined,
): Promise<number | undefined> {
  if (typeof supplied === 'number') return supplied;
  if (!ctx.platform) return undefined;
  try {
    const active = await ctx.platform.getActiveWindow();
    return active?.processId;
  } catch {
    return undefined;
  }
}

export function getA11yDepthTools(): ToolDefinition[] {
  return [
    {
      name: 'a11y_get_element',
      description:
        'Fetch a single element by accessibility name — returns name, role, ' +
        'bounds, value, state flags (focused/enabled/disabled/selected/busy/' +
        'offscreen/expandable/expanded). Convenience singular form of ' +
        'find_element (which returns an array).',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      safetyTier: 0,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_get_element');
        const pid = await resolveProcessId(ctx, processId);
        const hits = await ctx.platform.findElements({
          name: String(name), controlType, processId: pid,
        });
        if (hits.length === 0) {
          return { text: `a11y_get_element: no element named ${quoteScreenText(name)} found.`, isError: true };
        }
        return { text: screenJson(hits[0], 2) };
      },
    },

    // ── Structural: list children by geometric containment ──
    //
    // The PlatformAdapter's getUiTree returns a FLAT list without parent
    // pointers on Windows (UIA) and macOS (AX flattens similarly). To
    // approximate "children of X" we filter the flat tree by geometric
    // containment inside the parent's bounds. Pragmatic — works for most
    // container→child cases (dialog children, menu items, list items) —
    // without requiring adapter-script changes.
    //
    // When the parent element has zero bounds or is not found, returns
    // an empty list. The agent can always fall back to find_element for
    // free-form searching.

    {
      name: 'a11y_list_children',
      description:
        'List a11y elements geometrically contained within a named parent element. ' +
        'Useful for enumerating menu items, tree children, dialog buttons, list rows. ' +
        'Matches by bounds containment — an element is a child if its rect is fully ' +
        'inside the parent\'s rect. NOT a true a11y-tree child relationship; good enough ' +
        'for most UI patterns.',
      parameters: {
        parentName:  { type: 'string', description: 'Accessibility name of the parent element', required: true },
        controlType: { type: 'string', description: 'Optional role filter on the PARENT match', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
        maxChildren: { type: 'number', required: false, default: 50, description: 'Cap on children returned' },
      },
      category: 'perception',
      safetyTier: 0,
      handler: async ({ parentName, controlType, processId, maxChildren }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_list_children');
        const pid = await resolveProcessId(ctx, processId);

        const parents = await ctx.platform.findElements({
          name: String(parentName), controlType, processId: pid,
        });
        if (parents.length === 0) {
          return { text: `a11y_list_children: parent ${quoteScreenText(parentName)} not found.`, isError: true };
        }
        // findElements can return loose/substring matches ordered by tree
        // position, so [0] is often NOT the element the caller named (live
        // 2026-06-07: list_children("Choose your background color") resolved to
        // the "Back" button at [0] → zero children). Prefer an exact name match,
        // then the largest-area match (a container, the likely parent), before
        // falling back to [0]. OS-agnostic — operates on the returned elements.
        const wantName = String(parentName).trim().toLowerCase();
        const area = (e: typeof parents[number]) => e.bounds.width * e.bounds.height;
        const parent =
          parents.find(p => (p.name ?? '').trim().toLowerCase() === wantName)
          ?? [...parents].sort((a, b) => area(b) - area(a))[0];
        if (parent.bounds.width <= 0 || parent.bounds.height <= 0) {
          // Scrolled out of view: empty bounds, so geometry can't find the
          // children — use the tree structure (depth) when the adapter gives it
          // (live 2026-10-15: Settings → About "Windows specifications").
          // The WINDOW's tree first: a hosted UWP page's elements report their
          // content process (SystemSettings), whose own top-level read is empty.
          const cap = typeof maxChildren === 'number' ? maxChildren : 50;
          const named = parents.filter(p => (p.name ?? '').trim().toLowerCase() === wantName);
          const pids = [...new Set([pid, parent.processId].filter((p): p is number => p !== undefined))];
          for (const treePid of pids.length ? pids : [undefined]) {
            const tree: UiElement[] = await ctx.platform.getUiTree(treePid);
            for (const cand of named.length ? named : [parent]) {
              const at = tree.findIndex(el => el.depth !== undefined && el.name === cand.name && el.controlType === cand.controlType);
              if (at === -1) continue;
              const d = tree[at].depth!;
              const kids: UiElement[] = [];
              for (let i = at + 1; i < tree.length && (tree[i].depth ?? -1) > d; i++) kids.push(tree[i]);
              if (kids.length === 0) continue;
              return {
                text: screenJson({
                  parent: { name: cand.name, controlType: cand.controlType, bounds: cand.bounds },
                  offscreen: true,
                  note: 'parent is scrolled out of view (no bounds); children taken from the accessibility tree — scroll to see them',
                  children: kids.slice(0, cap).map(c => ({ name: c.name, controlType: c.controlType, bounds: c.bounds, value: c.value })),
                  totalCount: kids.length,
                  truncated: kids.length > cap,
                }),
              };
            }
          }
          return { text: `a11y_list_children: parent ${quoteScreenText(parentName)} has zero bounds (scrolled out of view) and no children in the accessibility tree.`, isError: true };
        }

        // For the tree walk, prefer the parent element's own processId so
        // we only enumerate within the parent's owning app (when known).
        const treePid = parent.processId ?? pid;
        const tree = await ctx.platform.getUiTree(treePid);

        const px = parent.bounds.x;
        const py = parent.bounds.y;
        const pr = px + parent.bounds.width;
        const pb = py + parent.bounds.height;
        const parentArea = parent.bounds.width * parent.bounds.height;

        const children = tree.filter(el => {
          // Skip the parent itself.
          if (el.name === parent.name && el.bounds.x === px && el.bounds.y === py) return false;
          if (el.bounds.width <= 0 || el.bounds.height <= 0) return false;
          // Geometric containment.
          const ex = el.bounds.x;
          const ey = el.bounds.y;
          const er = ex + el.bounds.width;
          const eb = ey + el.bounds.height;
          if (ex < px || ey < py || er > pr || eb > pb) return false;
          // Skip obvious ancestors (element larger than parent).
          if (el.bounds.width * el.bounds.height >= parentArea) return false;
          return true;
        });

        const cap = typeof maxChildren === 'number' ? maxChildren : 50;
        const trimmed = children.slice(0, cap);
        return {
          text: screenJson({
            parent: { name: parent.name, controlType: parent.controlType, bounds: parent.bounds },
            children: trimmed.map(c => ({
              name: c.name,
              controlType: c.controlType,
              bounds: c.bounds,
              value: c.value,
            })),
            totalCount: children.length,
            truncated: children.length > cap,
          }),
        };
      },
    },
  ];
}
