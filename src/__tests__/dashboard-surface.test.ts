/**
 * The web dashboard called granular tools (submit_task, agent_status, …)
 * directly, so against a `--compact` daemon every task submit and status poll
 * failed ("Tool submit_task not found"). It now asks tools/list once and maps
 * each call onto what the daemon serves.
 */
import { describe, it, expect } from 'vitest';
import { dashboardToolCall } from '../surface/dashboard-tools';
import { mountDashboard } from '../surface/dashboard';

const GRANULAR = ['read_screen', 'submit_task', 'agent_status', 'abort_task', 'resume_task', 'scheduled_task_list', 'favorites_list', 'logs_recent'];
const COMPACT = ['computer', 'accessibility', 'window', 'system', 'browser', 'task', 'batch'];

describe('dashboardToolCall', () => {
  it('granular daemon: the granular tools, unchanged', () => {
    expect(dashboardToolCall(GRANULAR, 'submit_task', { task: 'open calc' })).toEqual({ name: 'submit_task', arguments: { task: 'open calc' } });
    expect(dashboardToolCall(GRANULAR, 'agent_status', {})).toEqual({ name: 'agent_status', arguments: {} });
    expect(dashboardToolCall(GRANULAR, 'favorites_list', {})).toEqual({ name: 'favorites_list', arguments: {} });
  });

  it('compact daemon: the task compound', () => {
    // A 1 s wait: returns a receipt (running / paused) and the task keeps
    // going in the background, like submit_task's fire-and-poll.
    expect(dashboardToolCall(COMPACT, 'submit_task', { task: 'open calc' })).toEqual({ name: 'task', arguments: { instruction: 'open calc', timeout: 1 } });
    expect(dashboardToolCall(COMPACT, 'agent_status', {})).toEqual({ name: 'task', arguments: { action: 'status' } });
    expect(dashboardToolCall(COMPACT, 'abort_task', {})).toEqual({ name: 'task', arguments: { action: 'abort' } });
    expect(dashboardToolCall(COMPACT, 'resume_task', {})).toEqual({ name: 'task', arguments: { action: 'resume' } });
  });

  it('compact daemon: a tool with no compact equivalent is unavailable (null), not a wrong call', () => {
    expect(dashboardToolCall(COMPACT, 'scheduled_task_list', {})).toBeNull();
    expect(dashboardToolCall(COMPACT, 'logs_recent', {})).toBeNull();
  });

  it('unknown surface (tools/list failed): the granular names, as before', () => {
    expect(dashboardToolCall([], 'submit_task', { task: 't' })).toEqual({ name: 'submit_task', arguments: { task: 't' } });
  });
});

describe('dashboard page', () => {
  function page(): string {
    let html = '';
    const app = { get: (_p: string, h: (req: unknown, res: unknown) => void) => h({}, { cookie() {}, type() { return { send: (s: string) => { html = s; } }; } }) };
    mountDashboard(app as never);
    return html;
  }

  it('embeds the mapping and routes every tool call through it', () => {
    const html = page();
    expect(html).toContain('function dashboardToolCall');
    expect(html).toContain("'tools/list'");
    // No direct granular calls left: every mcpCall goes through toolCall().
    expect(html.match(/mcpCall\('/g) ?? []).toEqual([]);
    expect(html).toContain("toolCall('submit_task'");
    expect(html).toContain("toolCall('agent_status'");
    // The pause banner still answers through POST /resume.
    expect(html).toContain("fetch('/resume'");
  });

  it('the embedded script parses', () => {
    const script = page().split('<script>')[1].split('</script>')[0];
    expect(() => new Function(script)).not.toThrow();
  });
});
