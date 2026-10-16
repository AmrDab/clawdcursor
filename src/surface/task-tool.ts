/**
 * Which MCP tool runs a task on the daemon: the granular `submit_task {task}`,
 * or — on a `--compact` daemon, which serves only the compound surface — the
 * `task` compound's default run action `{instruction}`.
 */
export interface TaskTool { name: 'submit_task' | 'task'; key: 'task' | 'instruction' }

export function pickTaskTool(toolNames: readonly string[]): TaskTool {
  return !toolNames.includes('submit_task') && toolNames.includes('task')
    ? { name: 'task', key: 'instruction' }
    : { name: 'submit_task', key: 'task' };
}

/** Ask the daemon (tools/list) which one it serves; submit_task if it can't say. */
export async function resolveTaskTool(url: string, headers: Record<string, string>): Promise<TaskTool> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return pickTaskTool([]);
    const data = await res.json() as { result?: { tools?: Array<{ name?: string }> } };
    return pickTaskTool((data.result?.tools ?? []).map(t => String(t.name)));
  } catch {
    return pickTaskTool([]);
  }
}
