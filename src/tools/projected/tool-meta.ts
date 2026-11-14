/**
 * TOOL_META — MCP-surface metadata for every projected UnifiedTool (tools.ts): the published name where it differs
 * (mcpName), category, safety tier and fallback parameter descriptions. project-mcp.ts reads it when
 * src/tools/registry.ts projects these tools onto the MCP surface. The cost class is in tools/cost-class.ts.
 */

import type { ToolDefinition } from '../types';

type ToolCategory = ToolDefinition['category'];

/**
 * MCP-surface metadata for a projected UnifiedTool.
 *
 * All fields mirror the corresponding ToolDefinition fields so a projector can
 * assemble a structurally complete ToolDefinition from (UnifiedTool + ToolMeta).
 */
export interface ToolMeta {
  /**
   * MCP surface name to use when projecting this tool.
   * Present ONLY when it differs from the tool's own name.
   * When absent, the tool's own name is published.
   */
  mcpName?: string;
  /** Tool category for organization (matches ToolDefinition.category). */
  category: ToolCategory;
  /** 0 = reads only, 1 = sends input / changes something (ToolDefinition.safetyTier). */
  safetyTier: 0 | 1;
  /** `true`: a tool that is destructive by itself (ToolDefinition.destructive). */
  destructive?: boolean;
  /**
   * Per-parameter fallback descriptions: project-mcp.ts uses one when the tool's
   * inputSchema.properties[p].description is absent or empty.
   */
  paramDescriptions?: Record<string, string>;
}

/**
 * Key: the tool's name in buildUnifiedTools().
 * Value: ToolMeta for the projected MCP surface tool.
 */
export const TOOL_META: Record<string, ToolMeta> = {
  // ─── PERCEPTION ────────────────────────────────────────────────────────────

  read_screen: {
    category: 'perception',
    safetyTier: 0,
  },

  list_windows: {
    mcpName: 'get_windows',
    category: 'window',
    safetyTier: 0,
  },

  // ─── A11Y ACTIONS ──────────────────────────────────────────────────────────

  invoke_element: {
    // Category 'window', as invoke_element was published before it was projected: kept so it does not change.
    category: 'window',
    safetyTier: 1,
  },

  set_field_value: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      value: 'Value to write',
      processId: 'Scope to a process',
    },
  },

  // ─── A11Y DEPTH ────────────────────────────────────────────────────────────

  a11y_expand: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      name: 'Accessibility name to match',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_collapse: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_toggle: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_select: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_get_value: {
    category: 'perception',
    safetyTier: 0,
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  verify: {
    category: 'perception',
    safetyTier: 0,
  },

  compile_ui: {
    category: 'perception',
    safetyTier: 0,
  },

  find_action_button: {
    category: 'perception',
    safetyTier: 0,
  },

  find_input_field: {
    category: 'perception',
    safetyTier: 0,
  },

  get_element_state: {
    category: 'perception',
    safetyTier: 0,
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  // ─── INPUT (mouse) ─────────────────────────────────────────────────────────

  click: {
    mcpName: 'mouse_click',
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      x: 'X coordinate in image-space',
      y: 'Y coordinate in image-space',
      button: 'Mouse button to click: "left" (default) or "right"',
    },
  },

  drag: {
    mcpName: 'mouse_drag',
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      startX: 'Start X in image-space',
      startY: 'Start Y in image-space',
      endX: 'End X in image-space',
      endY: 'End Y in image-space',
    },
  },

  scroll: {
    mcpName: 'mouse_scroll',
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      x: 'X coordinate in image-space',
      y: 'Y coordinate in image-space',
      direction: 'Scroll direction',
    },
  },

  // ─── INPUT (keyboard) ──────────────────────────────────────────────────────

  type: {
    mcpName: 'type_text',
    category: 'keyboard',
    safetyTier: 1,
    paramDescriptions: {
      text: 'The text to type',
    },
  },

  key: {
    mcpName: 'key_press',
    category: 'keyboard',
    safetyTier: 1,
  },

  // ─── APPS & WINDOWS ────────────────────────────────────────────────────────

  focus_window: {
    category: 'window',
    safetyTier: 1,
    paramDescriptions: {
      processName: 'Process name to focus (e.g. "notepad", "msedge")',
      processId: 'Process ID to focus',
      title: 'Window title substring to match',
    },
  },

  maximize_window: {
    category: 'window',
    safetyTier: 1,
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  minimize_window: {
    // Published as minimize_window_to_taskbar: src/tools/a11y.ts serves a different
    // `minimize_window` (the a11y bridge).
    mcpName: 'minimize_window_to_taskbar',
    category: 'window',
    // Tier 1 (input): minimizing is reversible.
    safetyTier: 1,
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  restore_window: {
    category: 'window',
    safetyTier: 1,
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  close_window: {
    category: 'window',
    safetyTier: 1,
    destructive: true,
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  resize_window: {
    category: 'window',
    safetyTier: 1,
    paramDescriptions: {
      x: 'New X (top-left origin, logical px)',
      y: 'New Y (top-left origin, logical px)',
      width: 'New width in logical px',
      height: 'New height in logical px',
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  list_displays: {
    category: 'window',
    safetyTier: 0,
  },

  // ─── ACCESSIBILITY DEPTH ──────────────────────────────────────

  focus_element: {
    category: 'perception',
    safetyTier: 1,
    paramDescriptions: {
      name: 'Accessibility name of the element',
      controlType: 'Optional role filter (Button, Edit, etc.)',
      processId: 'Optional process id to scope the search',
    },
  },

  wait_for_element: {
    category: 'perception',
    safetyTier: 0,
    paramDescriptions: {
      name: 'Accessibility name to match',
      controlType: 'Role filter (e.g. "Button")',
      processId: 'Scope the search to a process',
    },
  },

  // ─── MOUSE + KEYBOARD EXTENDED ─────────────────────────────────────────────

  mouse_move_relative: {
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      dx: 'X offset in image-space pixels',
      dy: 'Y offset in image-space pixels',
    },
  },

  mouse_down: {
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      button: 'Which button (default: left)',
    },
  },

  mouse_up: {
    category: 'mouse',
    safetyTier: 1,
    paramDescriptions: {
      button: 'Which button (default: left)',
    },
  },

  key_down: {
    category: 'keyboard',
    safetyTier: 1,
    paramDescriptions: {
      key: 'Key token (e.g. "shift", "ctrl", "a", "Return")',
    },
  },

  key_up: {
    category: 'keyboard',
    safetyTier: 1,
    paramDescriptions: {
      key: 'Key token',
    },
  },

  undo_last: {
    category: 'keyboard',
    safetyTier: 1,
  },

  // ─── BROWSER (CDP / DOM) ───────────────────────────────────────────────────

  browser_connect: {
    mcpName: 'cdp_connect',
    category: 'browser',
    safetyTier: 1,
  },

  browser_read: {
    // Published as cdp_page_context (its no-selector path is the structured DOM listing);
    // cdp_read_text (src/tools/cdp.ts) is a separate tool.
    mcpName: 'cdp_page_context',
    category: 'browser',
    safetyTier: 0,
  },

  browser_click: {
    mcpName: 'cdp_click',
    category: 'browser',
    safetyTier: 1,
  },

  browser_type: {
    mcpName: 'cdp_type',
    category: 'browser',
    safetyTier: 1,
  },
};
