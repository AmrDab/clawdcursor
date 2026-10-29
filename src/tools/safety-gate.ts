import { evaluateInput } from '../core/safety';
import type { ToolDefinition, ToolResult } from './types';
import type { UIMapHolder } from '../core/sense/ui-map-holder';

const present = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * The label of the element an el_NN ref points at. Refs carry no name/target —
 * resolve the element's label from the holder so the destructive-label rule
 * (Send/Delete/Pay…) still fires on the ref path. Stale/unknown snapshot → no
 * label → the blunt no-label rule stays in effect (safe default). Audit
 * 2026-06-10, finding E.
 */
export function refLabel(args: Record<string, unknown>, uiMaps?: Pick<UIMapHolder, 'resolve'>): string | undefined {
  if (!uiMaps || typeof args.element_id !== 'string' || typeof args.snapshot_id !== 'string') return undefined;
  const r = uiMaps.resolve(args.snapshot_id, Date.now());
  if (!r.ok) return undefined;
  const el = r.map.elements.find(e => e.id === args.element_id);
  const label = el?.text ?? el?.normalized_text;
  return present(label) ? label : undefined;
}

/**
 * Every selector a handler may act on. invoke_element acts on the ref when one
 * is given, then `name`, then `automationId` — gating only the first non-empty
 * argument let a benign `name` beside a ref to "Send", or `automationId:
 * "Send"` alone, through with no confirmation. Each label is evaluated on its
 * own (`gateEachLabel`), so the intent-match bypass for one ("send the email" →
 * Send) cannot approve another (Delete). No selector → `[undefined]`, one
 * no-label evaluation, as before.
 */
export function selectorLabels(selectors: unknown[]): Array<string | undefined> {
  const labels = [...new Set(selectors.filter(present))];
  return labels.length > 0 ? labels : [undefined];
}

const STRICTNESS: Record<string, number> = { block: 2, confirm: 1, warn: 1 };

/** Run `evaluate` once per label and return the strictest decision (block > confirm > allow). */
export function gateEachLabel<D extends { decision?: string; suggestedAction?: string }>(
  labels: Array<string | undefined>, evaluate: (targetLabel: string | undefined) => D,
): D {
  const decisions = labels.map(evaluate);
  const rank = (d: D) => STRICTNESS[d.decision ?? d.suggestedAction ?? ''] ?? 0;
  return decisions.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

function labelsFromArgs(args: Record<string, unknown>, uiMaps?: UIMapHolder): Array<string | undefined> {
  // `text` beside a target/name is what gets typed into it (smart_type), not a selector.
  const text = present(args.target) || present(args.name) ? undefined : args.text;
  return selectorLabels([refLabel(args, uiMaps), args.name, args.automationId, args.target, text, args.label, args.title, args.selector]);
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
  const decision = gateEachLabel(labelsFromArgs(args, opts?.uiMaps), targetLabel => evaluateInput({
    toolName: tool.name,
    args,
    safetyTier: tool.safetyTier,
    ctx: {
      targetLabel,
    },
  }));

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
