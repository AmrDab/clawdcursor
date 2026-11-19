/**
 * `window list` / list_windows named every open window by title, so an unrelated document's name (with private text in it)
 * reached the model. Now: apps only, with a count; a title only for windows the agent opened or worked in. The tool takes no
 * filter parameter today, so there is no "on request" listing to test.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/control', async () => {
  const actual = await vi.importActual<typeof import('../core/control')>('../core/control');
  return { ...actual, isAgentWindow: (q: { processId?: number }) => q.processId === 300 };
});

import { buildUnifiedTools } from '../tools/projected/tools';

const win = (processName: string, processId: number, title: string) =>
  ({ processName, processId, title, handle: processId * 10, bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false });
const SECRET = 'passwords-2026 sk-live-ABC123';

describe('list_windows', () => {
  it('hides other apps\' titles, keeps the agent\'s own, and counts an app\'s windows', async () => {
    const windows = [
      win('winword', 100, `${SECRET}.docx - Word`),
      win('chrome', 200, 'Inbox - Mail'), win('chrome', 200, 'Bank statement'),
      win('notepad', 300, 'scratch.txt'),
    ];
    const r = await buildUnifiedTools().find(t => t.name === 'list_windows')!.execute({}, {
      platform: { platform: 'win32', listWindows: async () => windows, getActiveWindow: async () => windows[0] }, mcpSurface: true,
    } as never);
    expect(r.text).not.toContain('sk-live');
    expect(r.text).not.toContain('Inbox');
    expect(r.text).not.toContain('Bank statement');
    expect(r.text).toContain('["winword"]');
    expect(r.text).toContain('pid=100');
    expect(r.text).toMatch(/\["chrome"\] pid=200 \(2 windows\)/);
    expect(r.text).toContain('scratch.txt');
  });
});
