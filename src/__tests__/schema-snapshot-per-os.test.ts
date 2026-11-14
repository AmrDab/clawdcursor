/**
 * The schema snapshot captures each OS's tool list on that OS: a description that depends on process.platform shows up
 * under perOs, not as the first OS's text for all three. And a field only some OS returns is kept.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../tools/orchestration', async () => {
  const actual = await vi.importActual<typeof import('../tools/orchestration')>('../tools/orchestration');
  return {
    ...actual,
    getOrchestrationTools: () => actual.getOrchestrationTools().map(t =>
      (t.name === 'wait' ? { ...t, description: `${t.description} (built on ${process.platform})` } : t)),
  };
});

import { currentSnapshot, mergeByOs } from '../schema/snapshot';

describe('schema snapshot, per OS', () => {
  it('a tool description that differs by OS is captured on each OS', async () => {
    const { surfaces } = JSON.parse(await currentSnapshot()) as {
      surfaces: { granular: { tools?: unknown; perOs: Record<string, Record<string, Array<{ name: string; description: string }>>> } };
    };
    const tools = surfaces.granular.perOs.tools;
    expect(surfaces.granular.tools).toBeUndefined();
    for (const os of ['darwin', 'linux', 'win32']) {
      expect(tools[os].find(t => t.name === 'wait')!.description).toMatch(new RegExp(`\\(built on ${os}\\)$`));
    }
  }, 60_000);

  it('a field only some OS returns is kept, under perOs', () => {
    const merged = mergeByOs({ win32: { a: 1 }, linux: { a: 1 }, darwin: { a: 1, macOnly: true } });
    expect(merged).toEqual({ a: 1, perOs: { macOnly: { darwin: true, linux: undefined, win32: undefined } } });
  });
});
