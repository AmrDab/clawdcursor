/**
 * The click reply ends with "[×1, screen 4480×2520]". On a Retina Mac those are physical pixels while the coordinates in the same
 * reply are points (a click at the tree's (6,68) with space:"screen" lands at point (6,68)): the reply now says which on macOS.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const click = buildUnifiedTools().find(t => t.name === 'click')!;
function ctx(platform: string, screen: AgentToolContext['screen']): AgentToolContext {
  return {
    platform: { platform, getActiveWindow: async () => null, mouseClick: vi.fn(async () => undefined) },
    task: 't', screen, screenshotsCaptured: { n: 0 },
  } as unknown as AgentToolContext;
}

describe('click reply units', () => {
  it('macOS (Retina): says points, with the point size and the pixel size', async () => {
    const r = await click.execute({ x: 6, y: 68, space: 'screen' }, ctx('darwin', { logicalWidth: 2240, logicalHeight: 1260, physicalWidth: 4480, physicalHeight: 2520, dpiRatio: 2 }));
    expect(r.text).toContain('screen (6,68)');
    expect(r.text).toMatch(/points/);
    expect(r.text).toContain('2240×1260 pt');
    expect(r.text).toContain('4480×2520 px');
  });

  it('other OSes keep the old breadcrumb exactly', async () => {
    const r = await click.execute({ x: 6, y: 68, space: 'screen' }, ctx('win32', { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 }));
    expect(r.text).toContain('screen (6,68) [×1, screen 1920×1080]');
    expect(r.text).not.toMatch(/points/);
  });
});
