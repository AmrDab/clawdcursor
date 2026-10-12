/**
 * TOOL_META — MCP-surface metadata for every System B (agent-loop) UnifiedTool.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The MCP surface (System A, src/tools/*) and the agent-loop (System B,
 * buildUnifiedTools) are currently two separate, parallel codebases. System B
 * has reliability tweaks (coord scaling, hedging guard, focus-guard, OCR
 * fallback, etc.) that System A lacks. The planned Step 3 will project the MCP
 * surface FROM System B tools, eliminating duplication. This file is Step 1 of
 * that refactor: a PURE DATA table mapping every System B tool name to the
 * metadata fields a ToolDefinition carries.
 *
 * PURELY ADDITIVE — this file is not imported by any production path yet.
 * Wire-in happens in a later step.
 *
 * COVERAGE
 * --------
 * Terminal / loop-control actions (done, give_up, cannot_read, ask_user) and the vision compound tools
 * (mouse, keyboard, window — defined in compound.ts) are intentionally EXCLUDED:
 *   - Terminal actions do not appear on the MCP surface.
 *   - Vision compounds collapse many granular tools into 3 schemas; they have no
 *     1:1 counterpart in the granular MCP surface and their own tool-meta would
 *     belong in a separate projection layer.
 *
 * NAME DIFFERENCES (System B → System A)
 * ----------------------------------------
 * Where the System B tool name differs from the granular MCP name:
 *   System B name       → MCP (System A) name
 *   list_windows        → get_windows
 *   click               → mouse_click
 *   drag                → mouse_drag
 *   scroll              → mouse_scroll
 *   type                → type_text
 *   key                 → key_press
 *   screenshot          → desktop_screenshot
 *   read_text           → ocr_read_screen
 *   browser_connect     → cdp_connect
 *   browser_navigate    → navigate_browser
 *   browser_read        → cdp_page_context   (structured DOM listing path)
 *   browser_click       → cdp_click
 *   browser_type        → cdp_type
 *
 * All other System B names match their MCP counterparts exactly.
 */

import type {
  ToolCostClass,
  ToolDefinition,
} from '../../tools/types';

// Re-use the ToolDefinition category type rather than duplicating it.
type ToolCategory = ToolDefinition['category'];
// CompactGroup from types.ts
import type { CompactGroup } from '../../tools/types';

/**
 * MCP-surface metadata for a System B UnifiedTool.
 *
 * All fields mirror the corresponding ToolDefinition fields so a projector can
 * assemble a structurally complete ToolDefinition from (UnifiedTool + ToolMeta).
 */
export interface ToolMeta {
  /**
   * MCP surface name to use when projecting this tool.
   * Present ONLY when it differs from the System B tool name.
   * When absent, use the System B name as-is.
   */
  mcpName?: string;
  /** Tool category for organization (matches ToolDefinition.category). */
  category: ToolCategory;
  /** Compact compound group this granular tool belongs to. */
  compactGroup?: CompactGroup;
  /** Safety tier (0=read-only … 3=destructive). */
  safetyTier: 0 | 1 | 2 | 3;
  /** Token cost class. */
  costClass: ToolCostClass;
  /**
   * Cheaper alternatives the caller should try first.
   * Names reference MCP (System A) granular tool names.
   */
  cheaperAlternatives?: string[];
  /**
   * Per-parameter descriptions harvested from the corresponding System A
   * ToolDefinition. Used by project-mcp.ts as a fallback when System B's
   * inputSchema.properties[p].description is absent or empty — so projected
   * MCP tools retain the rich parameter descriptions that System A had.
   *
   * Key: parameter name (matches inputSchema.properties key).
   * Value: description string to use when System B has none.
   */
  paramDescriptions?: Record<string, string>;
}

/**
 * Authoritative metadata table for System B UnifiedTool names.
 *
 * Key: System B tool name (as returned by buildUnifiedTools()).
 * Value: ToolMeta for the projected MCP surface tool.
 */
export const TOOL_META: Record<string, ToolMeta> = {
  // ─── PERCEPTION ────────────────────────────────────────────────────────────

  read_screen: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 0,
    costClass: 'perceive-text',
    cheaperAlternatives: ['find_element', 'get_focused_element'],
    paramDescriptions: {
      processId: 'Focus on a specific process ID (optional — reads foreground window by default)',
    },
  },

  list_windows: {
    mcpName: 'get_windows',
    category: 'window',
    compactGroup: 'window',
    safetyTier: 0,
    costClass: 'inspect',
    // get_windows has no parameters in System A
  },

  // ─── A11Y ACTIONS ──────────────────────────────────────────────────────────

  invoke_element: {
    // System A (smart.ts) invoke_element has category 'window'. The projected tool
    // preserves this to match the System A behavior — same category, no regression.
    category: 'window',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['focus_element'],
    paramDescriptions: {
      name: 'Element name to find',
      automationId: 'Element automation ID (more precise than name)',
      controlType: 'Filter by control type (e.g., "ControlType.Button")',
      processId: 'Target process ID',
      action: 'Action to perform (default: "click"). Options: click, set-value, get-value, focus, expand, collapse',
      value: 'Value for set-value action',
    },
  },

  set_field_value: {
    // a11y input action — same category as System A's a11y_depth.ts set_field_value
    // (category: 'perception'). 'window' was incorrect; this is an accessibility
    // write action, not a window-management action.
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['invoke_element'],
    paramDescriptions: {
      name: 'Accessibility name of the field',
      value: 'Value to write',
      controlType: 'Optional role filter (e.g. "Edit")',
      processId: 'Scope to a process',
    },
  },

  // ─── A11Y DEPTH ────────────────────────────────────────────────────────────

  a11y_expand: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Accessibility name to match',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_collapse: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_toggle: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_select: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  a11y_get_value: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 0,
    costClass: 'inspect',
    cheaperAlternatives: ['get_element_state'],
    paramDescriptions: {
      name: 'Accessibility name',
      controlType: 'Optional role filter',
      processId: 'Scope to a process',
    },
  },

  verify: {
    category: 'perception',
    safetyTier: 0,
    costClass: 'inspect',
    paramDescriptions: {
      assertions: 'Array of machine-checkable assertions, each {type, ...fields}',
    },
  },

  compile_ui: {
    category: 'perception',
    safetyTier: 0,
    costClass: 'perceive-text',
    paramDescriptions: {
      purpose: 'What the compile is for',
      target_text: 'Text to find (may pull OCR)',
      max_cost: 'Perception cost ceiling',
    },
  },

  find_action_button: {
    category: 'perception',
    safetyTier: 0,
    costClass: 'perceive-text',
    paramDescriptions: {
      intent: 'What you want to do (submit/cancel/search/login/...)',
      max_cost: 'Perception cost ceiling (default ocr_ok)',
    },
  },

  find_input_field: {
    category: 'perception',
    safetyTier: 0,
    costClass: 'perceive-text',
    paramDescriptions: {
      purpose: 'What the field is for (recipient/subject/body/search/...)',
      max_cost: 'Perception cost ceiling (default ocr_ok)',
    },
  },

  get_element_state: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 0,
    costClass: 'inspect',
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
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['invoke_element'],
    paramDescriptions: {
      x: 'X coordinate in image-space',
      y: 'Y coordinate in image-space',
      button: 'Mouse button to click: "left" (default) or "right"',
      count: 'Click count: 1=single (default), 2=double',
      // MCP callers omit `space` to get the image-space default (backward-compat).
      // Pass space:"screen" to use a11y-snapshot coords without scaling.
      space: 'Coordinate space. Omit (default) or pass "image" for screenshot coords (scaled to physical). Pass "screen" for a11y-snapshot coords that are already in physical pixels.',
    },
  },

  drag: {
    mcpName: 'mouse_drag',
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      startX: 'Start X in image-space',
      startY: 'Start Y in image-space',
      endX: 'End X in image-space',
      endY: 'End Y in image-space',
      path: 'Stepped drag path: array of {x,y} points (min 2). When given, startX/startY/endX/endY are ignored.',
      space: 'Coordinate space. Omit (default) or pass "image" for screenshot coords. Pass "screen" for a11y coords already in physical pixels.',
    },
  },

  move: {
    mcpName: 'mouse_hover',
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      x: 'X coordinate in image-space',
      y: 'Y coordinate in image-space',
      space: 'Coordinate space. Omit (default) or pass "image" for screenshot coords. Pass "screen" for a11y coords already in physical pixels.',
    },
  },

  scroll: {
    mcpName: 'mouse_scroll',
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      x: 'X coordinate in image-space',
      y: 'Y coordinate in image-space',
      direction: 'Scroll direction',
      amount: 'Scroll amount in wheel ticks (default: 3)',
      space: 'Coordinate space. Omit (default) or pass "image" for screenshot coords. Pass "screen" for a11y coords already in physical pixels.',
    },
  },

  // ─── INPUT (keyboard) ──────────────────────────────────────────────────────

  type: {
    mcpName: 'type_text',
    category: 'keyboard',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['set_field_value'],
    paramDescriptions: {
      text: 'The text to type',
    },
  },

  key: {
    mcpName: 'key_press',
    category: 'keyboard',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      // MCP surface (key_press) uses the parameter name 'key' for backward-compat.
      // System B now also accepts 'key' as an alias for 'combo' — both are valid.
      key: 'Key/combo to press (e.g. "Return", "ctrl+a", "F5"). Space-separate combos for a sequence ("Down Down End").',
    },
  },

  // ─── APPS & WINDOWS ────────────────────────────────────────────────────────

  open_app: {
    category: 'orchestration',
    compactGroup: 'system',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Application name (e.g. "notepad", "calc", "mspaint", "Outlook", "Chrome")',
    },
  },

  focus_window: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      processName: 'Process name to focus (e.g. "notepad", "msedge")',
      processId: 'Process ID to focus',
      title: 'Window title substring to match',
    },
  },

  maximize_window: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  minimize_window: {
    // System B name is 'minimize_window'; the MCP surface distinguishes it as
    // 'minimize_window_to_taskbar' (routed through the PlatformAdapter, not the
    // legacy a11y bridge). The separate a11y-bridge 'minimize_window' in
    // src/tools/a11y.ts is kept as-is; only 'minimize_window_to_taskbar' (from
    // extras.ts) is re-projected from this System B tool.
    mcpName: 'minimize_window_to_taskbar',
    category: 'window',
    compactGroup: 'window',
    safetyTier: 2,
    costClass: 'act',
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  restore_window: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  close_window: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 2,
    costClass: 'act',
    paramDescriptions: {
      processName: 'Optional process name match',
      processId: 'Optional process id match',
      title: 'Optional title-substring match',
    },
  },

  resize_window: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
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
    compactGroup: 'window',
    safetyTier: 0,
    costClass: 'inspect',
    // list_displays has no parameters
  },

  switch_tab_os: {
    category: 'window',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      index: 'Jump to tab N (1-based, 1-9). If omitted, direction must be provided.',
      direction: 'Cycle "next" or "previous". Ignored when `index` is given.',
    },
  },

  // ─── ACCESSIBILITY DEPTH (Tranche 1B) ──────────────────────────────────────

  focus_element: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      name: 'Accessibility name of the element',
      controlType: 'Optional role filter (Button, Edit, etc.)',
      processId: 'Optional process id to scope the search',
    },
  },

  wait_for_element: {
    category: 'perception',
    compactGroup: 'accessibility',
    safetyTier: 0,
    costClass: 'inspect',
    paramDescriptions: {
      name: 'Accessibility name to match',
      controlType: 'Role filter (e.g. "Button")',
      processId: 'Scope the search to a process',
      timeoutMs: 'Max wait in milliseconds (default 5000)',
      intervalMs: 'Poll interval in ms (default 250)',
    },
  },

  // ─── SYSTEM OPEN HELPERS ───────────────────────────────────────────────────

  open_file: {
    category: 'orchestration',
    compactGroup: 'window',
    safetyTier: 2,
    costClass: 'act',
    paramDescriptions: {
      path: 'Absolute filesystem path',
    },
  },

  open_url: {
    category: 'orchestration',
    compactGroup: 'window',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      url: 'https:// or http:// URL',
    },
  },

  open_uri: {
    category: 'orchestration',
    compactGroup: 'window',
    safetyTier: 2,
    costClass: 'act',
    paramDescriptions: {
      uri: 'A full URI like "mailto:bob@example.com?subject=hi&body=hello", "tel:+15551234", "slack://channel?team=T123&id=C456", "vscode://file/Users/me/code/x.ts", "https://example.com". Must be properly URL-encoded.',
    },
  },

  build_uri: {
    category: 'orchestration',
    compactGroup: 'window',
    safetyTier: 0,
    costClass: 'inspect',
    paramDescriptions: {
      scheme: 'URI scheme without the colon: mailto, tel, sms, webcal, slack, vscode, obsidian, spotify, https, etc.',
      path: 'Scheme-specific path (for mailto: the recipient address; for tel:/sms: the number; for https: the host+path). URL-encoded for you.',
      query: 'JSON object of query parameters, e.g. {"subject":"hi","body":"hello"}. Each value will be URL-encoded.',
    },
  },

  get_system_time: {
    category: 'perception',
    compactGroup: 'system',
    safetyTier: 0,
    costClass: 'inspect',
    // get_system_time has no parameters
  },

  // ─── MOUSE + KEYBOARD EXTENDED ─────────────────────────────────────────────

  mouse_move_relative: {
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      dx: 'X offset in image-space pixels',
      dy: 'Y offset in image-space pixels',
    },
  },

  mouse_down: {
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      button: 'Which button (default: left)',
    },
  },

  mouse_up: {
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      button: 'Which button (default: left)',
    },
  },

  key_down: {
    category: 'keyboard',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      key: 'Key token (e.g. "shift", "ctrl", "a", "Return")',
    },
  },

  key_up: {
    category: 'keyboard',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      key: 'Key token',
    },
  },

  undo_last: {
    category: 'keyboard',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'act',
    // undo_last has no parameters
  },

  // ─── CLIPBOARD ─────────────────────────────────────────────────────────────

  read_clipboard: {
    category: 'clipboard',
    compactGroup: 'system',
    safetyTier: 0,
    costClass: 'inspect',
    // read_clipboard has no parameters
  },

  write_clipboard: {
    category: 'clipboard',
    compactGroup: 'system',
    safetyTier: 2,
    costClass: 'act',
    paramDescriptions: {
      text: 'Text to write to clipboard',
    },
  },

  // ─── FLOW CONTROL ──────────────────────────────────────────────────────────

  wait: {
    category: 'orchestration',
    compactGroup: 'system',
    safetyTier: 0,
    costClass: 'act',
    paramDescriptions: {
      // System B uses 'ms'; System A uses 'seconds'. The param names differ.
      ms: 'Duration to wait in milliseconds (max 5000)',
    },
  },

  // ─── VISION ────────────────────────────────────────────────────────────────

  screenshot: {
    mcpName: 'desktop_screenshot',
    category: 'perception',
    compactGroup: 'computer',
    safetyTier: 0,
    costClass: 'perceive-image',
    cheaperAlternatives: ['read_screen', 'ocr_read_screen'],
    // screenshot has no parameters
  },

  // ─── OCR PERCEPTION ────────────────────────────────────────────────────────

  read_text: {
    mcpName: 'ocr_read_screen',
    category: 'perception',
    compactGroup: 'system',
    safetyTier: 0,
    costClass: 'perceive-text',
    cheaperAlternatives: ['read_screen', 'find_element'],
    // System B 'filter' param has its own description; no System A counterpart
  },

  smart_click: {
    category: 'mouse',
    compactGroup: 'computer',
    safetyTier: 1,
    costClass: 'perceive-text',
    cheaperAlternatives: ['invoke_element', 'mouse_click'],
    paramDescriptions: {
      target: 'Element name/text to click (e.g., "Send", "Submit", "New Email")',
      processId: 'Limit search to a specific process',
      timeout: 'Max time in ms (default 5000)',
    },
  },

  // ─── BROWSER (CDP / DOM) ───────────────────────────────────────────────────

  browser_connect: {
    mcpName: 'cdp_connect',
    category: 'browser',
    compactGroup: 'browser',
    safetyTier: 1,
    costClass: 'act',
    // browser_connect has no parameters
  },

  browser_navigate: {
    mcpName: 'navigate_browser',
    category: 'browser',
    compactGroup: 'browser',
    safetyTier: 1,
    costClass: 'act',
    paramDescriptions: {
      url: 'URL to navigate to',
    },
  },

  browser_read: {
    // Closest System A equivalent is cdp_page_context (structured DOM listing).
    // cdp_read_text covers the selector-based text path, but cdp_page_context
    // is the more analogous default path. The projector uses this MCP name.
    mcpName: 'cdp_page_context',
    category: 'browser',
    compactGroup: 'browser',
    safetyTier: 0,
    costClass: 'perceive-text',
    cheaperAlternatives: ['read_screen'],
    paramDescriptions: {
      selector: 'Optional CSS selector to read text from (default: structured interactive-element list for the whole page).',
    },
  },

  browser_click: {
    mcpName: 'cdp_click',
    category: 'browser',
    compactGroup: 'browser',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['invoke_element'],
    paramDescriptions: {
      selector: 'CSS selector to click (e.g. "#submit", "button.primary")',
      text: 'Visible text of the element to click (alternative to selector)',
    },
  },

  browser_type: {
    mcpName: 'cdp_type',
    category: 'browser',
    compactGroup: 'browser',
    safetyTier: 1,
    costClass: 'act',
    cheaperAlternatives: ['set_field_value'],
    paramDescriptions: {
      selector: 'CSS selector for the input field',
      label: 'Label text associated with the input (alternative to selector)',
      text: 'Text to type into the field',
    },
  },

  // ─── BATCHED PLANNING ──────────────────────────────────────────────────────

  batch: {
    category: 'orchestration',
    compactGroup: 'system',
    safetyTier: 1,
    costClass: 'act',
    // batch has its own complex schema; no direct System A counterpart
  },
};
