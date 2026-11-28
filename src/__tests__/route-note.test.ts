/** A projected tool's result carries what the platform did to run it (a window given back, the rung used): taken once, per call. */
import { describe, it, expect, vi } from 'vitest';
import { buildCoreTools } from '../tools/core-tools';
import { toToolDefinition } from '../tools/core-tools';

const ctxWith = (notes: Array<string | null>) => ({
  ensureInitialized: async () => {},
  desktop: { getScreenSize: () => { throw new Error('none'); } },
  platform: {
    getActiveWindow: vi.fn(async () => null),
    findElements: vi.fn(async () => []),
    invokeElement: vi.fn(async () => ({ success: true, data: { toggleState: 'On' } })),
    takeRouteNote: vi.fn(() => notes.shift() ?? null),
  },
}) as any;

describe('route note on a projected tool result', () => {
  const def = toToolDefinition(buildCoreTools().find(t => t.name === 'a11y_toggle')!);

  it('is appended to the result text', async () => {
    const r = await def.handler({ name: 'Dark mode', processId: 42 }, ctxWith([null, 'gave your window back']));
    expect(r.text).toMatch(/\(gave your window back\)$/);
  });

  it('a note left by an earlier call is dropped before this one runs', async () => {
    const r = await def.handler({ name: 'Dark mode', processId: 42 }, ctxWith(['stale', null]));
    expect(r.text).not.toMatch(/stale|gave your window back/);
  });
});
