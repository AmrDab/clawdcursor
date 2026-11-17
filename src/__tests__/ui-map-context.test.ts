import { describe, it, expect } from 'vitest';
import { toolContextToAgent } from '../tools/projected/project-mcp';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { ToolContext } from '../tools/types';

describe('toolContextToAgent — uiMaps holder passthrough', () => {
  it('copies ctx.uiMaps onto the synthetic AgentToolContext', async () => {
    const holder = new UIMapHolder();
    const ctx = {
      ensureInitialized: async () => {},
      platform: {} as any,
      desktop: { getScreenSize: () => ({ width: 800, height: 600 }) },
      cdp: null,
      getMouseScaleFactor: () => 1,
      getScreenshotScaleFactor: () => 1,
      uiMaps: holder,
    } as unknown as ToolContext;
    const agentCtx = await toolContextToAgent(ctx);
    expect(agentCtx.uiMaps).toBe(holder);
  });
});
