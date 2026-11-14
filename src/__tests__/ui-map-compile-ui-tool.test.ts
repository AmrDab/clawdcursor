import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { AgentToolContext } from '../tools/projected/types';
import type { PlatformAdapter } from '../platform/types';

const tool = () => buildUnifiedTools().find(t => t.name === 'compile_ui')!;

function ctx(holder: UIMapHolder): AgentToolContext {
  const adapter = {
    getActiveWindow: async () => ({ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    getUiTree: async () => [{ name: 'Send', controlType: 'Button', bounds: { x: 10, y: 20, width: 40, height: 12 }, enabled: true }],
    getScreenSize: async () => ({ logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }),
    getFocusedElement: async () => null,
    screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
  } as unknown as PlatformAdapter;
  return { platform: adapter, task: 't', screen: { logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
}

describe('compile_ui tool', () => {
  it('is registered, perception, changesScreen=false', () => {
    const t = tool();
    expect(t).toBeTruthy();
    expect(t.changesScreen).toBe(false);
  });

  it('compiles, stores the map in the holder, returns a render with the snapshot id', async () => {
    const holder = new UIMapHolder();
    const res = await tool().execute({}, ctx(holder));
    expect(res.success).toBe(true);
    expect(holder.currentId()).toBe('obs_1');
    expect(res.text).toContain('obs_1');
    expect(res.text.toLowerCase()).toContain('send');
  });
});
