/**
 * Live blind test (Ubuntu 24.04): `window open_app "calculator"` launched
 * nothing yet answered "Launched". open_app now reports success only when a
 * window surfaced; otherwise it says the launch is unconfirmed (isError) and
 * passes the adapter's failure through.
 */
import { describe, it, expect, vi } from 'vitest';
import { getOrchestrationTools } from '../tools/orchestration';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { ToolContext } from '../tools/types';

const mcpOpenApp = getOrchestrationTools().find(t => t.name === 'open_app')!;
const agentOpenApp = buildUnifiedTools().find(t => t.name === 'open_app')!;

function mcpCtx(launchApp: (...a: unknown[]) => unknown): ToolContext {
  return {
    ensureInitialized: async () => {},
    platform: { platform: 'linux', launchApp: vi.fn(launchApp) },
    a11y: { invalidateCache: () => {} },
  } as unknown as ToolContext;
}
function agentCtx(launchApp: (...a: unknown[]) => unknown) {
  return { platform: { platform: 'linux', launchApp: vi.fn(launchApp) } } as any;
}

describe('MCP open_app', () => {
  it('reports Opened when a window surfaced', async () => {
    const r = await mcpOpenApp.handler({ name: 'calculator' }, mcpCtx(async () => ({ pid: 7, title: 'Calculator' })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Opened "calculator"');
  });

  it('is an error, not "Launched", when no window appeared', async () => {
    const r = await mcpOpenApp.handler({ name: 'calculator' }, mcpCtx(async () => ({ pid: 7 })));
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/^Launched/);
    expect(r.text).toMatch(/no window appeared/i);
    expect(r.text).toContain('pid=7');
  });

  it('passes a launch failure through', async () => {
    const r = await mcpOpenApp.handler({ name: 'nosuchapp' }, mcpCtx(async () => { throw new Error('no executable or desktop entry named "nosuchapp"'); }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/desktop entry/);
  });
});

describe('agent-loop open_app', () => {
  it('fails (success:false) when no window appeared', async () => {
    const r = await agentOpenApp.execute({ name: 'calculator' }, agentCtx(async () => ({})));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/no window appeared/i);
  });

  it('fails cleanly when the launch throws', async () => {
    const r = await agentOpenApp.execute({ name: 'nosuchapp' }, agentCtx(async () => { throw new Error('no executable or desktop entry named "nosuchapp"'); }));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/desktop entry/);
  });

  it('succeeds when a window surfaced', async () => {
    const r = await agentOpenApp.execute({ name: 'calculator' }, agentCtx(async () => ({ pid: 7, title: 'Calculator' })));
    expect(r.success).toBe(true);
  });
});
