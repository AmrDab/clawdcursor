/**
 * HTTP /mcp with a REAL MCP SDK client (live, Ubuntu VM 2026-10-15): the SDK
 * client connected, then every request failed with "MCP transport error:
 * Already connected to a transport". startMcpHttp connected ONE McpServer to a
 * fresh transport per request, so the client's long-lived GET stream (or any
 * in-flight call) kept the server busy and every other request was refused.
 *
 * Contract pinned here: SDK clients get a session (their own server); one-shot
 * JSON-RPC posts without initialize (dashboard, curl, `clawdcursor task`) keep
 * working, concurrently, behind the same bearer gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import { startMcpHttp, type McpServerLike } from '../surface/mcp-server';

const TOKEN = 'test-token';

async function makeServer(): Promise<McpServerLike> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const s = new McpServer({ name: 'test', version: '1.0.0' });
  s.tool('echo', 'echo', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
  s.tool('slow', 'slow', { ms: z.number() }, async ({ ms }) => {
    await new Promise(r => setTimeout(r, ms));
    return { content: [{ type: 'text', text: `slept:${ms}` }] };
  });
  return s as unknown as McpServerLike;
}

let http: HttpServer | null = null;
let closeMcp: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closeMcp?.();
  await new Promise<void>(r => (http ? http.close(() => r()) : r()));
  http = null; closeMcp = null;
});

async function start(): Promise<{ url: URL; created: () => number }> {
  let created = 0;
  const app = express();
  app.use(express.json());
  app.use('/mcp', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  });
  const mcp = await startMcpHttp(await makeServer(), app, '/mcp', async () => { created++; return makeServer(); });
  closeMcp = mcp.close;
  http = await new Promise<HttpServer>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (http.address() as AddressInfo).port;
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), created: () => created };
}

async function sdkClient(url: URL) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'it', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const text = (r: any) => (r.content as Array<{ text: string }>).map(c => c.text).join('');

async function oneShot(url: URL, name: string, args: unknown, id = 1, token = TOKEN) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() as any : await res.text() };
}

describe('startMcpHttp with the MCP SDK client', () => {
  it('connect, list tools, call a tool twice, with the GET stream open', async () => {
    const { url } = await start();
    const { client, transport } = await sdkClient(url);
    expect(transport.sessionId).toBeTruthy();
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['echo', 'slow']);
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'a' } }))).toBe('echo:a');
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'b' } }))).toBe('echo:b');
    // The SDK opens its standalone GET stream after initialize; give it a beat.
    await new Promise(r => setTimeout(r, 200));
    // It is open: the session's one standalone stream is taken (409), and a
    // sessionless GET has no stream to offer (405).
    const get = (h: Record<string, string>) => fetch(url, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}`, ...h } });
    expect((await get({ 'mcp-session-id': transport.sessionId! })).status).toBe(409);
    expect((await get({})).status).toBe(405);
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'c' } }))).toBe('echo:c');
    await client.close();
  });

  it('concurrent calls on one session, and two clients at once', async () => {
    const { url } = await start();
    const a = await sdkClient(url);
    const b = await sdkClient(url);
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    const results = await Promise.all([
      a.client.callTool({ name: 'slow', arguments: { ms: 300 } }),
      a.client.callTool({ name: 'echo', arguments: { text: 'x' } }),
      b.client.callTool({ name: 'echo', arguments: { text: 'y' } }),
    ]);
    expect(results.map(text)).toEqual(['slept:300', 'echo:x', 'echo:y']);
    await a.client.close();
    await b.client.close();
  });
});

describe('startMcpHttp one-shot JSON-RPC posts (dashboard / curl / CLI)', () => {
  it('work without initialize, repeatedly, on the shared server', async () => {
    const { url, created } = await start();
    for (const t of ['1', '2']) {
      const r = await oneShot(url, 'echo', { text: t });
      expect(r.status).toBe(200);
      expect(r.body.result.content[0].text).toBe(`echo:${t}`);
    }
    expect(created()).toBe(0); // sequential one-shots reuse the one server
  });

  it('run concurrently (a long call does not block the next), alongside an SDK session', async () => {
    const { url } = await start();
    const { client } = await sdkClient(url);
    const [slow, quick, sdk] = await Promise.all([
      oneShot(url, 'slow', { ms: 400 }, 7),
      oneShot(url, 'echo', { text: 'q' }, 7),
      client.callTool({ name: 'echo', arguments: { text: 's' } }),
    ]);
    expect(slow.body.result.content[0].text).toBe('slept:400');
    expect(slow.body.id).toBe(7);
    expect(quick.body.result.content[0].text).toBe('echo:q');
    expect(text(sdk)).toBe('echo:s');
    await client.close();
  });

  it('keeps the bearer gate', async () => {
    const { url } = await start();
    const r = await oneShot(url, 'echo', { text: 'x' }, 1, 'wrong');
    expect(r.status).toBe(401);
  });

  it('an unknown session id is a 404 so the client re-initializes', async () => {
    const { url } = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'gone' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
