import { evaluateInput } from '../core/safety';
import type { ToolDefinition, ToolResult } from './types';
import type { UIMapHolder } from '../core/sense/ui-map-holder';

function labelFromArgs(args: Record<string, unknown>, uiMaps?: UIMapHolder): string | undefined {
  const candidates = [
    args.target,
    args.name,
    args.text,
    args.label,
    args.title,
    args.selector,
  ];
  const value = candidates.find(v => typeof v === 'string' && v.trim().length > 0);
  if (typeof value === 'string') return value;
  // el_NN refs carry no name/target — resolve the element's label from the
  // holder so the destructive-label rule (Send/Delete/Pay…) still fires on
  // the MCP route's ref path. Stale/unknown snapshot → no label → the blunt
  // no-label rule stays in effect (safe default). Audit 2026-06-10, finding E.
  if (uiMaps && typeof args.element_id === 'string' && typeof args.snapshot_id === 'string') {
    const r = uiMaps.resolve(args.snapshot_id, Date.now());
    if (r.ok) {
      const el = r.map.elements.find(e => e.id === args.element_id);
      const label = el?.text ?? el?.normalized_text;
      if (typeof label === 'string' && label.trim().length > 0) return label;
    }
  }
  return undefined;
}

/**
 * Enforce the canonical safety gate before direct MCP/REST tool handlers run.
 *
 * Uses `evaluateInput` from `pipeline/safety/layer` — the single source of
 * truth for allow/block decisions.  Passes `tool.safetyTier` when present so
 * the gate consults the tool's own declared tier rather than guessing from
 * the name string.
 *
 * Returns null when the tool is allowed; returns an error ToolResult when
 * blocked or requiring confirmation.
 */
export function evaluateToolCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  opts?: { uiMaps?: UIMapHolder },
): ToolResult | null {
  const decision = evaluateInput({
    toolName: tool.name,
    args,
    safetyTier: tool.safetyTier,
    ctx: {
      targetLabel: labelFromArgs(args, opts?.uiMaps),
    },
  });

  if (decision.allow) return null;

  const suggestedAction = decision.suggestedAction ?? 'block';
  const reason = decision.reason ?? `${tool.name} requires user approval`;

  if (suggestedAction === 'block') {
    return {
      text: `${tool.name}: safety block - ${reason}`,
      isError: true,
    };
  }

  // confirm / warn path
  return {
    text: `${tool.name}: safety confirm - ${reason} (requires user confirmation). ` +
          `Next step: surface this to the user and wait for approval — re-issuing the same call will just block again. ` +
          `If the user already authorized this intent, run the step inside \`batch({allowConfirm:true})\`.`,
    isError: true,
  };
}
