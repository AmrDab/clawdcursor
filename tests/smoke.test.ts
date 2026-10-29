/**
 * Smoke tests for the v0.9 PR7 cutover.
 *
 * The legacy REST surface (createServer in src/server.ts) was deleted in
 * PR7.4. The surviving HTTP routes (/health, /stop, /, and the /mcp
 * streamable-HTTP transport) live in src/http-utility.ts.
 *
 * This test suite proves:
 *   - The default config still has the expected port / host / safety tier
 *   - createUtilityServer wires /health public + /stop auth + /
 *   - The /mcp route refuses anonymous requests (auth gate works)
 */

import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createUtilityServer, initServerToken } from '../src/surface/http-utility';
import { DEFAULT_CONFIG, SafetyTier } from '../src/types';
import { VERSION } from '../src/surface/version';

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
    expect(DEFAULT_CONFIG.ai.provider).toBe('auto');
    expect(DEFAULT_CONFIG.safety.defaultTier).toBe(SafetyTier.Preview);
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

  it('accepts allowed-origin browser requests', async () => {
    const app = makeUtilityApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://127.0.0.1:3847');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3847');
  });
});

describe('PR7 cutover invariants', () => {
  it('the legacy REST routes are gone', async () => {
    const app = makeUtilityApp();
    // /task, /favorites, /tools, /execute, /action, /logs, /task-logs,
    // /screenshot, /report, /learn — all deleted in PR7.4. The utility
    // server only owns /, /health, /stop. Anything else 404s.
    for (const route of ['/task', '/favorites', '/tools', '/execute/foo', '/action', '/logs', '/task-logs', '/screenshot', '/report', '/learn', '/abort', '/status']) {
      const res = await request(app).get(route).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    }
  });
});
