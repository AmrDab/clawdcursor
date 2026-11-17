/**
 * The daemon (`clawdcursor agent`) starts like the stdio server: it reports earlier servers that died without a clean
 * exit (before, only a later stdio start did) and its logs_recent reads the captured console. Loopback only, with a stub
 * tool context: nothing touches the desktop.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';

vi.mock('../surface/tool-context', async () => {
  const { getLogBuffer } = await import('../surface/log-buffer');
  return {
    createToolContext: async (o: { disableVision: boolean }) => ({
      desktop: {}, a11y: {}, cdp: undefined, platform: undefined, getLogBuffer, disableVision: o.disableVision,
      getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1, ensureInitialized: async () => {},
    }),
  };
});

import { serveMcp } from '../surface/serve';
import { releasePidFile } from '../surface/pidfile';
import { TOKEN_PATH } from '../paths';

const servers: http.Server[] = [];
const listen = http.Server.prototype.listen;
vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
  servers.push(this);
  return (listen as (...a: unknown[]) => http.Server).apply(this, args);
});
const signalsBefore = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };

afterAll(() => {
  for (const s of servers) s.close();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    for (const l of process.listeners(sig)) if (!signalsBefore[sig].includes(l)) process.off(sig, l);
  }
  releasePidFile('start');
});

const freePort = () => new Promise<number>(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('the daemon startup', () => {
  it('reports a server that died without a clean exit, and serves logs_recent from the captured console', async () => {
    const dead = 2147483002;
    fs.mkdirSync(process.env.CLAWDCURSOR_SESSION_DIR!, { recursive: true });
    const file = path.join(process.env.CLAWDCURSOR_SESSION_DIR!, `session-2026-01-01T00-00-00-000Z-${dead}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', started: 'x', pid: dead }) + '\n' + JSON.stringify({ t: 'y', tool: 'window', ok: true }) + '\n');

    const port = await freePort();
    await serveMcp({ transport: 'http', compact: false, banner: false, port, accept: true });
    await until(() => fs.readFileSync(file, 'utf8').includes('detectedAtNextStart'));

    const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    console.log('serve-daemon: a line for the log panel');
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'logs_recent', arguments: {} } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0].text).toContain('serve-daemon: a line for the log panel');
  });
});
