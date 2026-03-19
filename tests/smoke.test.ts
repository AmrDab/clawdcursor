import { describe, expect, it, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer, initServerToken } from '../src/server';
import { DEFAULT_CONFIG, SafetyTier } from '../src/types';
import { SafetyLayer } from '../src/safety';
import { VERSION } from '../src/version';

// Initialize auth token for tests
let token: string;
beforeAll(() => {
  token = initServerToken();
});

/** Helper: attach auth header to a supertest request */
function withAuth(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${token}`);
}

function makeAgent(overrides: Partial<any> = {}) {
  const safety = new SafetyLayer(DEFAULT_CONFIG);
  const agent = {
    getState: () => ({ status: 'idle', stepsCompleted: 0, stepsTotal: 0 }),
    executeTask: vi.fn().mockResolvedValue({ success: true }),
    getSafety: () => safety,
    abort: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  } as any;

  return { agent, safety };
}

describe('config defaults', () => {
  it('keeps expected defaults', () => {
    expect(DEFAULT_CONFIG.server.port).toBe(3847);
    expect(DEFAULT_CONFIG.server.host).toBe('127.0.0.1');
    expect(DEFAULT_CONFIG.ai.provider).toBe('auto');
    expect(DEFAULT_CONFIG.safety.defaultTier).toBe(SafetyTier.Preview);
  });
});

describe('server smoke tests', () => {
  it('returns health with version (no auth needed)', async () => {
    const { agent } = makeAgent();
    const app = createServer(agent, DEFAULT_CONFIG);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(VERSION);
  });

  it('returns status without auth (public endpoint)', async () => {
    const { agent } = makeAgent();
    const app = createServer(agent, DEFAULT_CONFIG);
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
  });

  it('returns 401 on protected GET endpoints without auth', async () => {
    const { agent } = makeAgent();
    const app = createServer(agent, DEFAULT_CONFIG);

    const protectedGets = ['/favorites', '/task-logs', '/task-logs/current', '/logs'];
    for (const endpoint of protectedGets) {
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(401);
    }
  });

  it('returns 409 when busy on /task', async () => {
    const { agent } = makeAgent({
      getState: () => ({ status: 'acting', stepsCompleted: 1, stepsTotal: 2 }),
    });
    const app = createServer(agent, DEFAULT_CONFIG);
    const res = await withAuth(request(app).post('/task')).send({ task: 'do something' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Agent is busy');
  });

  it('confirms pending action', async () => {
    const { agent, safety } = makeAgent();
    const confirmPromise = safety.requestConfirmation(
      { kind: 'click', x: 10, y: 10 },
      'send message'
    );

    const app = createServer(agent, DEFAULT_CONFIG);
    const res = await withAuth(request(app).post('/confirm')).send({ approved: true });
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
    await expect(confirmPromise).resolves.toBe(true);
  });

  it('returns 404 when no pending confirmation', async () => {
    const { agent } = makeAgent();
    const app = createServer(agent, DEFAULT_CONFIG);
    const res = await withAuth(request(app).post('/confirm')).send({ approved: true });
    expect(res.status).toBe(404);
  });
});
