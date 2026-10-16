/**
 * Map a dashboard call (named by its granular tool) onto the tools the daemon
 * actually serves. A `--compact` daemon serves only the compound surface: the
 * task family goes through the `task` compound; tools with no compact
 * equivalent (schedules, favorites, logs) are unavailable → null.
 *
 * Self-contained on purpose: its source is embedded in the dashboard page
 * (`dashboardToolCall.toString()`), so it must not reference anything else.
 */
export function dashboardToolCall(
  served: string[],
  tool: string,
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } | null {
  const compact = served.indexOf('submit_task') === -1 && served.indexOf('task') !== -1;
  if (!compact) return { name: tool, arguments: args };
  if (tool === 'submit_task') return { name: 'task', arguments: { instruction: args.task, timeout: 1 } };
  if (tool === 'agent_status') return { name: 'task', arguments: { action: 'status' } };
  if (tool === 'abort_task') return { name: 'task', arguments: { action: 'abort' } };
  if (tool === 'resume_task') return { name: 'task', arguments: { action: 'resume' } };
  return served.indexOf(tool) !== -1 ? { name: tool, arguments: args } : null;
}
