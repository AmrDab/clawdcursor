/**
 * The token-bearing dashboard must never be served off-loopback.
 *
 * The dashboard injects the bearer token — full desktop control — into the
 * page's JS. On a non-loopback bind the server used to log a warning and then
 * serve it ANYWAY, so anyone who could reach the port and load `/` got the
 * token. The daemon now binds loopback only (#293); this guard is the second
 * line for any other caller of createUtilityServer.
 *
 * Deliberately never calls initServerToken(): that would rewrite the real
 * token file and break a running daemon.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createUtilityServer } from '../surface/http-utility';

const build = (host?: string) => createUtilityServer({ onStop: () => {}, host });

describe('dashboard is loopback-only', () => {
  it.each(['0.0.0.0', '192.168.1.20', '::', 'example.com'])(
    'is NOT served when bound to %s', async (host) => {
      const res = await request(build(host)).get('/');
      expect(res.status).toBe(404);
    },
  );

  it.each([undefined, '127.0.0.1', 'localhost', '::1', '127.0.0.2', 'LOCALHOST'])(
    'is served when bound to %s', async (host) => {
      const res = await request(build(host)).get('/');
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/html/);
    },
  );

  it('/health stays available off-loopback (it carries no secret)', async () => {
    const res = await request(build('0.0.0.0')).get('/health');
    expect(res.status).toBe(200);
  });
});

// Audit 2026-11-13: the origin allowlist was fixed to :3847, so on --port the dashboard's own POSTs (Resume/End, the kill
// switch, its log reads over /mcp) got 403. The allowed origin is now the port the server really listens on.
describe('the dashboard\'s own requests work on any port', () => {
  const listen = () => new Promise<import('node:http').Server>(r => { const s = build().listen(0, '127.0.0.1', () => r(s)); });

  it('accepts its own origin on a non-default port and refuses :3847 and foreign origins there', async () => {
    const server = await listen();
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      expect(port).not.toBe(3847);
      for (const host of ['127.0.0.1', 'localhost']) {
        const res = await request(server).get('/health').set('Origin', `http://${host}:${port}`);
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(`http://${host}:${port}`);
      }
      // A POST from the page passes the origin check and reaches the auth gate (no token here: 401, not 403).
      const post = await request(server).post('/stop').set('Origin', `http://127.0.0.1:${port}`);
      expect(post.status).toBe(401);
      for (const origin of ['http://127.0.0.1:3847', 'http://evil.example']) {
        expect((await request(server).post('/stop').set('Origin', origin)).status).toBe(403);
      }
    } finally { server.close(); }
  });
});
