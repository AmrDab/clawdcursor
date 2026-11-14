/**
 * DNS rebinding (#426 review): a page on evil.example whose name is rebound to 127.0.0.1 is same-origin with the daemon
 * as far as the browser knows. It could GET / (the cookie with the token is set for it) and then GET /resume to read the
 * pause message. Every route now answers only to `Host: 127.0.0.1:<port>` or `localhost:<port>`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUtilityServer, ROUTES } from '../surface/http-utility';
import { initServerToken } from '../surface/auth';
import { pauseGate } from '../core/pause-gate';

let server: Server;
let port: number;
let token: string;
beforeAll(async () => {
  token = initServerToken();
  const mcp = vi.fn((_req, res) => { res.json({ reached: 'mcp' }); });
  server = await new Promise<Server>(r => { const s = createUtilityServer({ host: '127.0.0.1', onStop: () => {}, mcp }).listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); vi.restoreAllMocks(); });

const send = (method: string, path: string, host: string) => {
  const verb = method.toLowerCase() as 'get' | 'post' | 'delete';
  return request(server)[verb](path).set('Host', host).set('Authorization', `Bearer ${token}`);
};

describe('the Host header', () => {
  it('a rebound name is refused on every route, before auth or the handler runs', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    for (const r of ROUTES) {
      const res = await send(r.method, r.path, `evil.example:${port}`);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.error).toMatch(/^Host not allowed/);
    }
    expect(exit).not.toHaveBeenCalled();   // POST /stop never ran
  });

  it('the rebinding attack: no token cookie from /, no pause message from /resume', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue({ id: 1, message: 'Sign in to the bank', since: 1 });
    const page = await request(server).get('/').set('Host', `evil.example:${port}`);
    expect(page.status).toBe(403);
    expect(page.headers['set-cookie']).toBeUndefined();
    const pause = await request(server).get('/resume').set('Host', `evil.example:${port}`).set('Cookie', `clawdcursor_token=${token}`);
    expect(pause.status).toBe(403);
    expect(JSON.stringify(pause.body)).not.toContain('bank');
  });

  it('a local name on another port is refused too', async () => {
    expect((await send('GET', '/health', '127.0.0.1:1')).status).toBe(403);
    expect((await send('GET', '/health', 'localhost')).status).toBe(403);
  });

  it('127.0.0.1:<port> and localhost:<port> are served as before', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      expect((await send('GET', '/health', host)).status, host).toBe(200);
      expect((await send('POST', '/mcp', host)).body).toEqual({ reached: 'mcp' });
    }
    const page = await send('GET', '/', `localhost:${port}`);
    expect(page.status).toBe(200);
    expect(String(page.headers['set-cookie'])).toContain('clawdcursor_token=');
  });
});

describe('the route table', () => {
  it('gates each route as before: /mcp, /resume and /stop need the token; / and /health do not', async () => {
    const host = `127.0.0.1:${port}`;
    for (const r of ROUTES) {
      const res = await request(server)[r.method.toLowerCase() as 'get' | 'post' | 'delete'](r.path).set('Host', host);
      expect(res.status === 401, `${r.method} ${r.path}`).toBe(r.auth !== 'none');
    }
  });

  it('an unknown route is a JSON 404 listing every route', async () => {
    const res = await request(server).get('/nope').set('Host', `127.0.0.1:${port}`);
    expect(res.status).toBe(404);
    expect(res.body.endpoints).toEqual(ROUTES.map(r => `${r.method} ${r.path}`));
  });
});
