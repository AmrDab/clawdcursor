import { evaluateInput } from '../core/safety';
import { pauseGate } from '../core/pause-gate';
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
 * blocked or requiring confirmation (the latter carries `confirmReason`, so a
 * caller with a human at the machine can ask on screen — confirmOnScreen).
 */
export function evaluateToolCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  opts?: { uiMaps?: UIMapHolder },
): (ToolResult & { confirmReason?: string }) | null {
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
    confirmReason: reason,
  };
}

const CONFIRM_WAIT_MS = 45_000; // under common 60s MCP client timeouts

/**
 * Ask the human at the machine to Allow / Deny a confirm-tier call on screen
 * (pause-gate.ts). Bounded like `task`: if they haven't answered within the
 * wait, the caller is told to re-issue the identical call, which re-attaches
 * to the same prompt. Null when no on-screen prompt can be shown — the caller
 * keeps the plain "requires confirmation" error.
 */
export async function confirmOnScreen(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  reason: string,
  opts?: { uiMaps?: UIMapHolder; waitMs?: number },
): Promise<{ allowed: true } | { allowed: false; text: string } | null> {
  if (!pauseGate.available()) return null;
  const action = typeof args.action === 'string' ? ` ${args.action}` : '';
  // Name the target so the user knows what they approve (window, app, URL…).
  const target = labelFromArgs(args, opts?.uiMaps)
    ?? [args.processName, args.app, args.url, args.path].find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const what = `${tool.name}${action}${target ? ` "${target.slice(0, 60)}"` : ''}`;
  const key = `confirm:${tool.name}:${JSON.stringify(args)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pauseGate.request({ kind: 'confirm', message: `An AI agent wants to: ${what} (${reason})`, key }),
    new Promise<null>(r => { timer = setTimeout(() => r(null), opts?.waitMs ?? CONFIRM_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    return { allowed: false, text: `${tool.name}: WAITING for the user to Allow or Deny on screen: ${what}. Re-issue this exact call to keep waiting (it runs as soon as they click Allow). Do not try another way meanwhile.` };
  }
  pauseGate.forget(key);
  if (outcome === 'allowed') return { allowed: true };
  if (outcome === 'denied') return { allowed: false, text: `${tool.name}: the user clicked Deny on screen for: ${what}. Do NOT retry it; find another way or ask the user.` };
  return { allowed: false, text: `${tool.name}: ${outcome === 'timeout' ? 'nobody answered' : 'the user ended the task at'} the on-screen approval for: ${what}. Stop and report back.` };
}
