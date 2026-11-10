/**
 * Map a dashboard call (named by its granular tool) onto the tools the daemon
 * actually serves. A `--compact` daemon serves only the compound surface, so
 * tools with no compact equivalent (logs) are unavailable → null.
 *
 * Self-contained on purpose: its source is embedded in the dashboard page
 * (`dashboardToolCall.toString()`), so it must not reference anything else.
 */
export function dashboardToolCall(
  served: string[],
  tool: string,
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } | null {
  if (served.length === 0) return { name: tool, arguments: args };
  return served.indexOf(tool) !== -1 ? { name: tool, arguments: args } : null;
}
