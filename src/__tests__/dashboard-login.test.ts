/**
 * Security scan (2026-11): GET / set the full-control token as a cookie for anyone who asked, so any local process or other
 * OS user could read it with `curl -si http://127.0.0.1:3847/`. The cookie is now set only for a one-time link that
 * `clawdcursor dashboard` asks the daemon for with the token (POST /dashboard-link): a random nonce, good once and for 60 s.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUtilityServer, describeRoutes } from '../surface/http-utility';
import { initServerToken, mintDashboardNonce, consumeDashboardNonce, DASHBOARD_LINK_TTL_MS, __resetDashboardLinksForTests } from '../surface/auth';

let server: Server;
let port: number;
let host: string;
let token: string;
beforeAll(async () => {
  token = initServerToken();
  server = await new Promise<Server>(r => { const s = createUtilityServer({ host: '127.0.0.1', onStop: () => {} }).listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
});
afterAll(() => { server.close(); vi.restoreAllMocks(); });
beforeEach(() => { __resetDashboardLinksForTests(); });

const get = (path: string) => request(server).get(path).set('Host', host);
/** A link the way `clawdcursor dashboard` gets one. */
async function link(): Promise<string> {
  const res = await request(server).post('/dashboard-link').set('Host', host).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  return url.pathname + url.search;
}
const cookieOf = (res: request.Response): string => String(res.headers['set-cookie'] ?? '');

describe('the nonce store', () => {
  it('a nonce is good once', () => {
    const k = mintDashboardNonce();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(consumeDashboardNonce(k)).toBe(true);
    expect(consumeDashboardNonce(k)).toBe(false);
  });

  it(`expires after ${DASHBOARD_LINK_TTL_MS / 1000} s`, () => {
    const t = 1_000_000;
    const k = mintDashboardNonce(t);
    expect(consumeDashboardNonce(k, t + DASHBOARD_LINK_TTL_MS)).toBe(false);
    const k2 = mintDashboardNonce(t);
    expect(consumeDashboardNonce(k2, t + DASHBOARD_LINK_TTL_MS - 1)).toBe(true);
  });

  it('refuses what it did not mint: another nonce, a prefix, the empty string, the token', () => {
    const k = mintDashboardNonce();
    for (const bad of [mintDashboardNonce().replace(/./, c => (c === '0' ? '1' : '0')), k.slice(0, 63), k + '0', '', token, k.toUpperCase()]) {
      expect(consumeDashboardNonce(bad), bad).toBe(false);
    }
    expect(consumeDashboardNonce(k)).toBe(true);
  });

  it('keeps a handful of unused links at most: the oldest go first', () => {
    const first = mintDashboardNonce();
    const rest = Array.from({ length: 16 }, () => mintDashboardNonce());
    expect(consumeDashboardNonce(first)).toBe(false);
    expect(consumeDashboardNonce(rest[rest.length - 1])).toBe(true);
  });
});

describe('POST /dashboard-link', () => {
  it('needs the token', async () => {
    const res = await request(server).post('/dashboard-link').set('Host', host);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('with the token: a link to this daemon, valid 60 s, not cached', async () => {
    const res = await request(server).post('/dashboard-link').set('Host', host).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?k=[0-9a-f]{64}$`));
    expect(res.body.expiresInMs).toBe(60_000);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is refused to a web page (cross-origin)', async () => {
    const res = await request(server).post('/dashboard-link').set('Host', host).set('Origin', 'http://evil.example')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /', () => {
  it('a one-time link: spends the nonce, sets the httpOnly SameSite=Strict cookie and redirects to / to drop the nonce', async () => {
    const res = await get(await link());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = cookieOf(res);
    expect(cookie).toContain(`clawdcursor_token=${token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('the same link a second time: no cookie, and the page says it was used', async () => {
    const path = await link();
    expect((await get(path)).status).toBe(302);
    const again = await get(path);
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(again.text).toContain('expired or was already used');
    expect(again.text).not.toContain(token);
  });

  it('an expired link: no cookie', async () => {
    const path = await link();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + DASHBOARD_LINK_TTL_MS + 1);
    try {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally { vi.mocked(Date.now).mockRestore(); }
  });

  it('a made-up, repeated or empty k: no cookie', async () => {
    await link();
    for (const q of ['/?k=' + '0'.repeat(64), '/?k=', '/?k', `/?k=${token}`, '/?k=a&k=b']) {
      const res = await get(q);
      expect(res.status, q).toBe(401);
      expect(res.headers['set-cookie'], q).toBeUndefined();
    }
  });

  it('with the cookie: the dashboard, which no other site may frame', async () => {
    const res = await get('/').set('Cookie', `clawdcursor_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Clawd Cursor Dashboard');
    expect(res.text).toContain("fetch('/logs'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the cookie from a link then opens the page and its token routes', async () => {
    const cookie = cookieOf(await get(await link())).split(';')[0];
    expect((await get('/').set('Cookie', cookie)).status).toBe(200);
    expect((await get('/resume').set('Cookie', cookie)).status).toBe(200);
  });

  it('a signed-in browser that opens a stale link is just sent to /', async () => {
    const res = await get('/?k=' + '0'.repeat(64)).set('Cookie', `clawdcursor_token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('neither: a page that names the command, sets no cookie, and cannot be framed either', async () => {
    for (const cookie of [undefined, 'clawdcursor_token=wrong', `clawdcursor_token=${token.slice(0, -1)}`]) {
      const req = get('/');
      const res = await (cookie ? req.set('Cookie', cookie) : req);
      expect(res.status, cookie).toBe(401);
      expect(res.headers['set-cookie'], cookie).toBeUndefined();
      expect(res.text).toContain('clawdcursor dashboard');
      expect(res.text).not.toContain(token);
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('the startup print says how the dashboard is opened', () => {
    const lines = describeRoutes();
    expect(lines.find(l => l.startsWith('GET    / '))).toMatch(/clawdcursor dashboard.*one-time link/);
    expect(lines.find(l => l.includes('/dashboard-link'))).toMatch(/auth, localhost only/);
  });
});
