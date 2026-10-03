/**
 * The token-bearing dashboard must never be served off-loopback.
 *
 * The dashboard injects the bearer token — full desktop control — into the
 * page's JS. On a non-loopback bind the server used to log a warning and then
 * serve it ANYWAY, so anyone who could reach the port and load `/` got the
 * token. Remote binding is opt-in (--allow-remote), which makes that user the
 * one who most needs this not to happen.
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
