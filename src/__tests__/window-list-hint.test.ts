/**
 * open_file and open_uri told agents "verify with list_windows", a tool on neither surface. They name the granular
 * window-list tool, get_windows, and a compact caller reads it as `window {"action":"list"}` (compact.ts toCompactNames).
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../platform/uri-handler', () => ({
  resolveSchemeHandlerExecutable: vi.fn(async () => null),
  isRegisteredUriScheme: vi.fn(async () => true),
  shellDispatchUriAndVerify: vi.fn(async () => ({ windowOpened: false })),
  launchHandlerAndVerify: vi.fn(),
}));

import { getExtraTools } from '../tools/extras';
import { getAllTools, getCompactSurface } from '../tools/registry';
import type { ToolContext } from '../tools/types';

const ctx = {
  ensureInitialized: async () => {},
  platform: { platform: 'win32', launchApp: vi.fn(async () => ({ title: 'Home - File Explorer', pid: 5 })), listWindows: vi.fn(async () => []) },
} as unknown as ToolContext;
const tool = (name: string) => getExtraTools().find(t => t.name === name)!;
const compound = (name: string) => getCompactSurface().find(t => t.name === name)!;

describe('the "verify the window" hint names a real tool on each surface', () => {
  it('the granular window-list tool is get_windows (and there is no list_windows)', () => {
    const names = getAllTools().map(t => t.name);
    expect(names).toContain('get_windows');
    expect(names).not.toContain('list_windows');
  });

  it('open_file, a folder that did not come up', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'clawd-hint-'));
    try {
      const granular = await tool('open_file').handler({ path: dir }, ctx);
      expect(granular.isError).toBe(true);
      expect(granular.text).toContain('Verify with get_windows.');
      const compact = await compound('window').handler({ action: 'open_file', path: dir }, ctx);
      expect(compact.text).toContain('Verify with window {"action":"list"}.');
      expect(compact.text).not.toMatch(/list_windows|get_windows/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('open_uri, dispatched through the shell with no new window', async () => {
    const granular = await tool('open_uri').handler({ uri: 'ms-settings:display' }, ctx);
    expect(granular.isError).toBe(true);
    expect(granular.text).toContain('verify with get_windows.');
    const compact = await compound('system').handler({ action: 'open_uri', uri: 'ms-settings:display' }, ctx);
    expect(compact.text).toContain('verify with window {"action":"list"}.');
    expect(compact.text).not.toMatch(/list_windows|get_windows/);
  });
});
