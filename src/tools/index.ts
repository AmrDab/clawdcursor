/**
 * Tool Registry — central registry of all clawd-cursor tools.
 *
 * Import this to get all 36 tools in a transport-agnostic format.
 * Adapters (HTTP, MCP) consume this registry.
 */

import { getDesktopTools } from './desktop';
import { getA11yTools } from './a11y';
import { getCdpTools } from './cdp';
import { getOrchestrationTools } from './orchestration';
import { getShortcutTools } from './shortcuts';
import { getOcrTools } from './ocr';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { toOpenAiFunctions, toJsonSchema } from './types';

export type { ToolDefinition, ToolContext, ToolResult };
export { toOpenAiFunctions, toJsonSchema };

/** Get all registered tools */
export function getAllTools(): ToolDefinition[] {
  return [
    ...getDesktopTools(),
    ...getA11yTools(),
    ...getCdpTools(),
    ...getOrchestrationTools(),
    ...getShortcutTools(),
    ...getOcrTools(),
  ];
}

/** Get tools by category */
export function getToolsByCategory(category: string): ToolDefinition[] {
  return getAllTools().filter(t => t.category === category);
}

/** Get a tool by name */
export function getTool(name: string): ToolDefinition | undefined {
  return getAllTools().find(t => t.name === name);
}
