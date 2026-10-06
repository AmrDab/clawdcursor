/**
 * Tranche 2 — accessibility-depth MCP tools.
 *
 * These wrap the widened InvokeAction set (`expand`/`collapse`/`toggle`/
 * `select`) and the richer UiElement state fields added in Tranche 1A.
 * The adapter-level support is already in place for all three OSes:
 *   - Windows: ps-bridge.ps1 + invoke-element.ps1 (UIA ExpandCollapse,
 *     Selection, Toggle patterns)
 *   - macOS: invoke-element.jxa (AXExpanded / AXValue / AXSelected
 *     attributes + AXPress / AXShowMenu action fallbacks)
 *   - Linux: atspi-bridge.py (AT-SPI Action / EditableText / Value /
 *     Selection interfaces). Without AT-SPI the adapter answers
 *     {success:false} and the tools report a structured failure.
 */

import type { ToolDefinition, ToolResult, ToolContext } from './types';

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
    // ── ExpandCollapse pattern (tree views, combo boxes, disclosures) ──

    {
      name: 'a11y_expand',
      description:
        'Expand a tree node, combo box, or disclosure element by accessibility name. ' +
        'Uses UIA ExpandCollapsePattern on Windows and AXExpanded attribute on macOS. ' +
        'More reliable than click-to-toggle when the element is already in a mixed state.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name to match', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', description: 'Scope to a process', required: false },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_expand');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: String(name), controlType, processId: pid, action: 'expand',
        });
        return {
          text: res.success ? `Expanded "${name}".` : `a11y_expand failed for "${name}".`,
          isError: !res.success,
        };
      },
    },

    {
      name: 'a11y_collapse',
      description:
        'Collapse a tree node, combo box, or disclosure element by accessibility name. ' +
        'Counterpart of a11y_expand.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_collapse');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: String(name), controlType, processId: pid, action: 'collapse',
        });
        return {
          text: res.success ? `Collapsed "${name}".` : `a11y_collapse failed for "${name}".`,
          isError: !res.success,
        };
      },
    },

    // ── ValuePattern (text fields, combos, set value directly) ──

    {
      name: 'set_field_value',
      description:
        'Set the value of a named text field directly via accessibility — more ' +
        'reliable than focus+type for forms (no IME issues, no autocomplete races). ' +
        'Uses UIA ValuePattern on Windows and AXValue on macOS. Referenced as the ' +
        'delegate for the compact `accessibility({"action":"set_value", ...})` route.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name of the field', required: true },
        value:       { type: 'string', description: 'Value to write', required: true },
        controlType: { type: 'string', description: 'Optional role filter (e.g. "Edit")', required: false },
        processId:   { type: 'number', description: 'Scope to a process', required: false },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, value, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('set_field_value');
        const safeNameStr = String(name ?? '');
        const safeValue = String(value ?? '');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: safeNameStr,
          controlType,
          processId: pid,
          action: 'set-value',
          value: safeValue,
        });
        if (res.success) {
          const preview = safeValue.length > 40 ? safeValue.slice(0, 40) + '…' : safeValue;
          return { text: `Set "${safeNameStr}" = "${preview}".` };
        }

        // ValuePattern not available on this element (common for Win11 XAML
        // controls such as the Save As filename ComboBox+Pane composite).
        // Fall back: focus the element, select-all existing text, type the
        // new value. We first try a UIA focus(), then fall back to clicking
        // the element's bounding-rect centre if focus() didn't work.
        if (ctx.platform.platform === 'win32') {
          // Try UIA focus first (brings keyboard to element without a click)
          const focusRes = await ctx.platform.invokeElement({
            name: safeNameStr,
            controlType,
            processId: pid,
            action: 'focus',
          });

          // If we have bounds (either from focus result or from a find),
          // click the element centre to ensure it really has keyboard focus.
          // When multiple elements share the same name (e.g. a Text label
          // and a ComboBox input both named "File name:"), prefer the widest
          // one — the actual input is always wider than its label.
          let bounds = focusRes.bounds;
          if (!bounds) {
            const found = await ctx.platform.findElements({
              name: safeNameStr,
              controlType,
              processId: pid,
            });
            if (found.length > 0) {
              const widest = found.reduce((best, el) =>
                (el.bounds?.width ?? 0) > (best.bounds?.width ?? 0) ? el : best, found[0]);
              bounds = widest.bounds;
            }
          }
          if (bounds && bounds.width > 0) {
            const cx = Math.round(bounds.x + bounds.width / 2);
            const cy = Math.round(bounds.y + bounds.height / 2);
            await ctx.platform.mouseClick(cx, cy);
          }

          // Select all existing content, then type the replacement value.
          // mod, NOT ctrl: on macOS Ctrl+A moves the caret to line start, so
          // the value used to be PREPENDED to the old text instead of
          // replacing it. mod = Cmd on macOS, Ctrl elsewhere.
          await ctx.platform.keyPress('mod+a');
          await ctx.platform.typeText(safeValue);
          const preview = safeValue.length > 40 ? safeValue.slice(0, 40) + '…' : safeValue;
          return { text: `Set "${safeNameStr}" = "${preview}" (via keyboard fallback).` };
        }

        return { text: `set_field_value failed for "${safeNameStr}".`, isError: true };
      },
    },

    // ── Toggle pattern (checkboxes, switches, toggle buttons) ──

    {
      name: 'a11y_toggle',
      description:
        'Toggle a checkbox, switch, or toggle-button by accessibility name. ' +
        'Uses UIA TogglePattern on Windows and AXValue flip on macOS. ' +
        'Returns the NEW toggle state (On/Off/Indeterminate) in the result.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_toggle');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: String(name), controlType, processId: pid, action: 'toggle',
        });
        if (!res.success) return { text: `a11y_toggle failed for "${name}".`, isError: true };
        const state = res.data?.toggleState ?? 'unknown';
        return { text: `Toggled "${name}" → ${state}.` };
      },
    },

    // ── SelectionItem pattern (list items, tabs, radios) ──

    {
      name: 'a11y_select',
      description:
        'Select a list item, tab, or radio button by accessibility name. ' +
        'Uses UIA SelectionItemPattern on Windows; sets AXSelected on macOS. ' +
        'More reliable than clicking when an item is scrolled out of view.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 1,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_select');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: String(name), controlType, processId: pid, action: 'select',
        });
        return {
          text: res.success ? `Selected "${name}".` : `a11y_select failed for "${name}".`,
          isError: !res.success,
        };
      },
    },

    // ── Read-only queries ──

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
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_get_element');
        const pid = await resolveProcessId(ctx, processId);
        const hits = await ctx.platform.findElements({
          name: String(name), controlType, processId: pid,
        });
        if (hits.length === 0) {
          return { text: `a11y_get_element: no element named "${name}" found.`, isError: true };
        }
        return { text: JSON.stringify(hits[0], null, 2) };
      },
    },

    {
      name: 'a11y_get_value',
      description:
        'Read the current value of a named text field, slider, or editable element ' +
        '(UIA ValuePattern / AX AXValue). Use this to verify what a form field contains ' +
        'before deciding whether to type into it.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_get_value');
        const pid = await resolveProcessId(ctx, processId);
        const res = await ctx.platform.invokeElement({
          name: String(name), controlType, processId: pid, action: 'get-value',
        });
        if (!res.success) {
          return { text: `a11y_get_value: "${name}" exposes no ValuePattern or AXValue.`, isError: true };
        }
        const value = res.data?.value ?? '';
        return { text: JSON.stringify({ name, value }) };
      },
    },

    {
      name: 'get_element_state',
      description:
        'Return only the state flags of a named element (focused, enabled/disabled, ' +
        'selected, busy, offscreen, expandable, expanded). Use for quick state checks ' +
        'without pulling the entire element record.',
      parameters: {
        name:        { type: 'string', description: 'Accessibility name', required: true },
        controlType: { type: 'string', description: 'Optional role filter', required: false },
        processId:   { type: 'number', required: false, description: 'Scope to a process' },
      },
      category: 'perception',
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ name, controlType, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('get_element_state');
        const pid = await resolveProcessId(ctx, processId);
        const hits = await ctx.platform.findElements({
          name: String(name), controlType, processId: pid,
        });
        if (hits.length === 0) {
          return { text: `get_element_state: no element named "${name}".`, isError: true };
        }
        const el = hits[0];
        const state = {
          name: el.name,
          controlType: el.controlType,
          focused: el.focused ?? false,
          enabled: el.enabled ?? true,
          disabled: el.disabled ?? false,
          selected: el.selected ?? false,
          busy: el.busy ?? false,
          offscreen: el.offscreen ?? false,
          expandable: el.expandable ?? false,
          expanded: el.expanded ?? false,
        };
        return { text: JSON.stringify(state) };
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
      compactGroup: 'accessibility',
      safetyTier: 0,
      handler: async ({ parentName, controlType, processId, maxChildren }, ctx) => {
        await ctx.ensureInitialized();
        if (!ctx.platform) return needPlatform('a11y_list_children');
        const pid = await resolveProcessId(ctx, processId);

        const parents = await ctx.platform.findElements({
          name: String(parentName), controlType, processId: pid,
        });
        if (parents.length === 0) {
          return { text: `a11y_list_children: parent "${parentName}" not found.`, isError: true };
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
          return { text: `a11y_list_children: parent "${parentName}" has zero bounds.`, isError: true };
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
          text: JSON.stringify({
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
