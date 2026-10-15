/**
 * `clawdcursor task "<text>"` against a `--compact` daemon failed with
 * "Tool submit_task not found" (live, Ubuntu VM 2026-10-15): the CLI always
 * called the granular submit_task, which the compact surface does not serve.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickTaskTool, resolveTaskTool } from '../surface/task-tool';

describe('pickTaskTool', () => {
  it('granular surface → submit_task {task}', () => {
    expect(pickTaskTool(['read_screen', 'submit_task', 'agent_status'])).toEqual({ name: 'submit_task', key: 'task' });
  });

  it('compact surface → task {instruction}', () => {
    expect(pickTaskTool(['computer', 'accessibility', 'window', 'system', 'browser', 'task', 'batch'])).toEqual({ name: 'task', key: 'instruction' });
  });

  it('unknown (tools/list failed) → submit_task, the historical default', () => {
    expect(pickTaskTool([])).toEqual({ name: 'submit_task', key: 'task' });
  });
});

describe('resolveTaskTool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads tools/list from the daemon', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: { tools: [{ name: 'task' }, { name: 'batch' }] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveTaskTool('http://127.0.0.1:3847/mcp', { Authorization: 'Bearer t' })).toEqual({ name: 'task', key: 'instruction' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).method).toBe('tools/list');
    expect(init.headers.Authorization).toBe('Bearer t');
  });

  it('falls back to submit_task when the daemon cannot be asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await resolveTaskTool('http://127.0.0.1:3847/mcp', {})).toEqual({ name: 'submit_task', key: 'task' });
  });
});
