/**
 * `clawdcursor status` says whether the daemon is running (Mac check, 2026-11-16: it did not). The CLI asks /health on the
 * port `stop` and `resume` use and passes what it found: status starts nothing. Not running is no failure: MCP over
 * stdio needs no daemon.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Not the real permission check: on a Mac it would run the native helper.
vi.mock('../platform/native-helper', () => ({ isMacOS: () => false, checkPermissionsQuick: vi.fn() }));

import { printStatusReport } from '../surface/readiness';

describe('clawdcursor status: the daemon', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('running: the port it answers on', async () => {
    await printStatusReport({ port: 4000, running: true });
    expect(out.filter(l => l.includes('Daemon:'))).toEqual([expect.stringContaining('Daemon: running on port 4000')]);
  });

  it('not running: one line saying so, and readiness does not depend on it', async () => {
    await printStatusReport({ port: 3847, running: false });
    const withDaemon = out.join('\n');
    expect(out.filter(l => l.includes('Daemon:'))).toEqual([expect.stringContaining('Daemon: not running')]);
    out = [];
    await printStatusReport({ port: 3847, running: true });
    const ready = (s: string) => s.split('\n').filter(l => /ready for desktop control/i.test(l));
    expect(ready(out.join('\n'))).toEqual(ready(withDaemon));
  });
});
