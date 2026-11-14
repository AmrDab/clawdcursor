/**
 * Live blind test (Ubuntu 24.04): `window open_app "calculator"` launched
 * nothing yet answered "Launched". open_app now reports success only when a
 * window surfaced; otherwise it says the launch is unconfirmed (isError) and
 * passes the adapter's failure through.
 */
import { describe, it, expect, vi } from 'vitest';
import { getOrchestrationTools } from '../tools/orchestration';
import type { ToolContext } from '../tools/types';

const mcpOpenApp = getOrchestrationTools().find(t => t.name === 'open_app')!;

function mcpCtx(launchApp: (...a: unknown[]) => unknown): ToolContext {
  return {
    ensureInitialized: async () => {},
    platform: { platform: 'linux', launchApp: vi.fn(launchApp) },
    a11y: { invalidateCache: () => {} },
  } as unknown as ToolContext;
}

describe('MCP open_app', () => {
  it('reports Opened when a window surfaced', async () => {
    const r = await mcpOpenApp.handler({ name: 'calculator' }, mcpCtx(async () => ({ pid: 7, title: 'Calculator' })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Opened "calculator"');
  });

  it('is an error, not "Launched", when no process and no window appeared', async () => {
    const r = await mcpOpenApp.handler({ name: 'calculator' }, mcpCtx(async () => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/^Launched/);
    expect(r.text).toMatch(/no window appeared/i);
  });

  it('a running process with no window yet is "started, still loading" — not an error (an error invites a second launch)', async () => {
    const r = await mcpOpenApp.handler({ name: 'outlook' }, mcpCtx(async () => ({ pid: 7 })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Started "outlook" \(pid=7\).*Do not launch it again/);
  });

  it('passes a launch failure through', async () => {
    const r = await mcpOpenApp.handler({ name: 'nosuchapp' }, mcpCtx(async () => { throw new Error('no executable or desktop entry named "nosuchapp"'); }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/desktop entry/);
  });
});

describe('open_app tells the adapter which processes are the app (a window is the app\'s by identity, not by title)', () => {
  it.each([
    ['Calculator', ['CalculatorApp', 'Calculator', 'calc']],
    ['Outlook', ['OUTLOOK', 'olk']],
    ['edge', ['msedge']],
  ])('%s → %j', async (name, processNames) => {
    const mcp = mcpCtx(async () => ({ pid: 7, title: 'x' }));
    await mcpOpenApp.handler({ name }, mcp);
    expect((mcp.platform as any).launchApp).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ processNames }));
  });
});

describe('open_app — started, window not up yet (a slow starter: Designcenter / ugraf.exe took longer than the wait)', () => {
  const slow = async () => ({ pid: 5150, processName: 'ugraf' });

  it('MCP: says the process is up, is not an error, and points to window focus by process — not to list_windows', async () => {
    const r = await mcpOpenApp.handler({ name: 'Designcenter' }, mcpCtx(slow));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Started "Designcenter" \(ugraf(\.exe)?, pid=5150\) but its window isn't up yet/);
    expect(r.text).toContain('window {"action":"focus","processName":"ugraf"}');
    expect(r.text).toMatch(/Do not launch it again/);
    expect(r.text).not.toMatch(/list_windows/);
  });

  it('only a pid is known (macOS / Linux): focus by process id', async () => {
    const r = await mcpOpenApp.handler({ name: 'outlook' }, mcpCtx(async () => ({ pid: 7 })));
    expect(r.text).toContain('window {"action":"focus","processId":7}');
  });

  it('nothing found at all: still an error, and the advice is focus by process, not list_windows', async () => {
    const r = await mcpOpenApp.handler({ name: 'Designcenter' }, mcpCtx(async () => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no window appeared/);
    expect(r.text).toContain('window {"action":"focus","processName":"Designcenter"}');
    expect(r.text).not.toMatch(/list_windows/);
  });
});

describe('open_app — the launch was handed to a process that was already running', () => {
  it('says "running", not "Started", and still points to focus by process', async () => {
    const r = await mcpOpenApp.handler({ name: 'edge' }, mcpCtx(async () => ({ pid: 6001, processName: 'msedge', alreadyRunning: true })));
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/Started/);
    expect(r.text).toMatch(/handed off to the running msedge(\.exe)?, pid=6001/);
    expect(r.text).toContain('window {"action":"focus","processName":"msedge"}');
    expect(r.text).toMatch(/Do not launch it again/);
  });
});
