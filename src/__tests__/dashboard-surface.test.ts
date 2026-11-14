/**
 * The web dashboard called granular tools directly, so against a `--compact`
 * daemon those calls failed. It now asks tools/list once and maps each call
 * onto what the daemon serves.
 */
import { describe, it, expect } from 'vitest';
import { dashboardToolCall } from '../surface/dashboard-tools';
import { dashboardPage } from '../surface/dashboard';

const GRANULAR = ['read_screen', 'resume_task', 'logs_recent'];
const COMPACT = ['computer', 'accessibility', 'window', 'system', 'browser', 'batch'];

describe('dashboardToolCall', () => {
  it('granular daemon: the granular tools, unchanged', () => {
    expect(dashboardToolCall(GRANULAR, 'logs_recent', {})).toEqual({ name: 'logs_recent', arguments: {} });
  });

  it('compact daemon: a tool with no compact equivalent is unavailable (null), not a wrong call', () => {
    expect(dashboardToolCall(COMPACT, 'logs_recent', {})).toBeNull();
  });

  it('unknown surface (tools/list failed): the granular names, as before', () => {
    expect(dashboardToolCall([], 'logs_recent', {})).toEqual({ name: 'logs_recent', arguments: {} });
  });
});

describe('dashboard page', () => {
  function page(): string {
    let html = '';
    const res = { cookie() {}, type() { return { send: (s: string) => { html = s; } }; } };
    dashboardPage()({} as never, res as never, () => {});
    return html;
  }

  it('embeds the mapping and routes every tool call through it', () => {
    const html = page();
    expect(html).toContain('function dashboardToolCall');
    expect(html).toContain("'tools/list'");
    // No direct granular calls left: every mcpCall goes through toolCall().
    expect(html.match(/mcpCall\('/g) ?? []).toEqual([]);
    expect(html).not.toContain("toolCall('agent_status'");
    // The pause banner still answers through POST /resume.
    expect(html).toContain("fetch('/resume'");
  });

  it('shows the pause banner from the authenticated GET /resume, not from /health', () => {
    const html = page();
    expect(html).toMatch(/fetch\('\/resume', \{ headers: authHeaders\(\) \}\)/);
    expect(html).toContain('Resume');
    expect(html).toContain('End task');
  });

  it('has no Tasks or Scheduled tab, task form or favorites left', () => {
    const html = page();
    for (const gone of ['panelTask', 'panelScheduled', 'sendTask', 'taskInput', 'switchTab', 'Scheduled', 'favorites_', 'submit_task']) {
      expect(html).not.toContain(gone);
    }
  });

  it('the embedded script parses', () => {
    const script = page().split('<script>')[1].split('</script>')[0];
    expect(() => new Function(script)).not.toThrow();
  });
});
