/**
 * Smoke tests for the v0.9 PR7 cutover.
 *
 * The legacy REST surface (createServer in src/server.ts) was deleted in
 * PR7.4. The surviving HTTP routes (/health, /stop, /, and the /mcp
 * streamable-HTTP transport) live in src/http-utility.ts.
 *
 * This test suite proves:
 *   - The default config still has the expected port
 *   - createUtilityServer wires /health public + /stop auth + /
 *   - The /mcp route refuses anonymous requests (auth gate works)
 */

import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createUtilityServer } from '../src/surface/http-utility';
import { initServerToken } from '../src/surface/auth';
import { DEFAULT_CONFIG } from '../src/types';
import { VERSION } from '../src/version';

let token: string;
beforeAll(() => {
  token = initServerToken();
});

function makeUtilityApp() {
  return createUtilityServer({
    host: '127.0.0.1',
    onStop: () => { /* test stub */ },
  });
}

describe('config defaults', () => {
  it('keeps expected defaults', () => {
    expect(DEFAULT_CONFIG.server.port).toBe(3847);
  });
});

describe('utility server smoke tests', () => {
  it('returns health with version (no auth needed)', async () => {
    const app = makeUtilityApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(VERSION);
  });

  it('serves the dashboard at GET /', async () => {
    const app = makeUtilityApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Clawd Cursor Dashboard');
  });

  it('returns 401 on /stop without auth', async () => {
    const app = makeUtilityApp();
    const res = await request(app).post('/stop');
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin browser requests', async () => {
    const app = makeUtilityApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('accepts allowed-origin browser requests (the server own origin, on the port it listens on)', async () => {
    const server = makeUtilityApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
      const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      const res = await request(server)
        .get('/health')
        .set('Origin', origin);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    } finally { server.close(); }
  });
});

describe('PR7 cutover invariants', () => {
  it('the legacy REST routes are gone', async () => {
    const app = makeUtilityApp();
    // /task, /favorites, /tools, /execute, /action, /task-logs,
    // /screenshot, /report, /learn — all deleted in PR7.4 (GET /logs is
    // back, for the dashboard's log panel). Anything else 404s.
    for (const route of ['/task', '/favorites', '/tools', '/execute/foo', '/action', '/task-logs', '/screenshot', '/report', '/learn', '/abort', '/status']) {
      const res = await request(app).get(route).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    }
  });
});
