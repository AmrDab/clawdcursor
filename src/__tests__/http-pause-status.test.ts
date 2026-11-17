/**
 * The dashboard's pause banner reads the pending pause from GET /resume.
 * It is Bearer-gated: the pause message is agent-written text about what the
 * user is doing, so it must never appear on the public /health.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { createUtilityServer } from '../surface/http-utility';
import { initServerToken } from '../surface/auth';
import { pauseGate, type PauseInfo } from '../core/pause-gate';

const PENDING: PauseInfo = { id: 7, message: 'Sign in to Glama', since: 1, choices: ['Work account', 'Personal account'] };

let token: string;
beforeAll(() => { token = initServerToken(); });
afterEach(() => { vi.restoreAllMocks(); });

const makeApp = () => createUtilityServer({ host: '127.0.0.1', onStop: () => {} });

describe('GET /resume — the pending pause for the dashboard', () => {
  it('with the token: reports the waiting pause, message and choices', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue(PENDING);
    const res = await request(makeApp()).get('/resume').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: true, pause: PENDING });
  });

  it('with the token and nothing paused: waiting false, pause null', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue(null);
    const res = await request(makeApp()).get('/resume').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: false, pause: null });
  });

  it('without the token: refused, and the message does not leak', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue(PENDING);
    const res = await request(makeApp()).get('/resume');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('Glama');
  });

  it('with a wrong token: refused', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue(PENDING);
    const res = await request(makeApp()).get('/resume').set('Authorization', 'Bearer not-the-token');
    expect(res.status).toBe(401);
  });

  it('/health stays public and carries no pause', async () => {
    vi.spyOn(pauseGate, 'current').mockReturnValue(PENDING);
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['status', 'version']);
    expect(JSON.stringify(res.body)).not.toContain('Glama');
  });

  it('the Resume and End buttons still answer through POST /resume (token required)', async () => {
    const answer = vi.spyOn(pauseGate, 'answer').mockReturnValue({ ok: true, outcome: 'resumed' });
    vi.spyOn(pauseGate, 'current').mockReturnValue(PENDING);
    const app = makeApp();

    const refused = await request(app).post('/resume').send({ answer: 'resume' });
    expect(refused.status).toBe(401);
    expect(answer).not.toHaveBeenCalled();

    const ok = await request(app).post('/resume').set('Authorization', `Bearer ${token}`).send({ answer: 'resume' });
    expect(ok.status).toBe(200);
    expect(answer).toHaveBeenCalledWith('resume', 'user', undefined);

    await request(app).post('/resume').set('Authorization', `Bearer ${token}`).send({ answer: 'end' });
    expect(answer).toHaveBeenLastCalledWith('end', 'user', undefined);
  });
});
