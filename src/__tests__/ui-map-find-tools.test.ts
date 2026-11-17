import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { AgentToolContext } from '../tools/projected/types';
import type { PlatformAdapter } from '../platform/types';

const tool = (name: string) => buildUnifiedTools().find(t => t.name === name)!;

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

describe('find_action_button / find_input_field tools', () => {
  it('both tools are registered, perception, changesScreen=false', () => {
    expect(tool('find_action_button').changesScreen).toBe(false);
    expect(tool('find_input_field').changesScreen).toBe(false);
  });

  it('find_action_button compiles, stores a current map, returns OK JSON resolvable by the ref path', async () => {
    const holder = new UIMapHolder();
    const res = await tool('find_action_button').execute({ intent: 'submit' }, ctx(holder)); // a11y "Send" button
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe('ok');
    expect(parsed.snapshot_id).toBe(holder.currentId());                       // current
    expect(holder.resolve(parsed.snapshot_id, Date.now()).ok).toBe(true);     // ref-resolvable (find->act chain)
    expect(parsed.best.label).toBe('send');
  });

  it('returns none JSON when nothing matches', async () => {
    const holder = new UIMapHolder();
    const res = await tool('find_action_button').execute({ intent: 'delete' }, ctx(holder)); // no delete button
    expect(JSON.parse(res.text).status).toBe('none');
  });
});
