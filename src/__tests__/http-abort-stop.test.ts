/**
 * POST /stop — graceful shutdown waits for onStop (bounded) instead of a
 * flat 500ms race, and tolerates a drifted on-disk token.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createUtilityServer, initServerToken } from '../surface/http-utility';

describe('POST /stop — graceful shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs onStop and exits 0 after it settles', async () => {
    const token = initServerToken();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((..._args: unknown[]) => undefined) as never);
    const onStop = vi.fn(async () => {});
    const app = createUtilityServer({ onStop });

    // Fake timers BEFORE the request so the scheduled hard-kill timeouts
    // never fire for real after the spy is restored.
    vi.useFakeTimers();
    const res = await request(app)
      .post('/stop')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);

    // Let the grace race (onStop vs cap) settle.
    await vi.runAllTimersAsync();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('POST /stop — tolerates a drifted on-disk token (clawdcursor stop reliability)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('accepts the current on-disk token even when it drifted from the daemon in-memory token', async () => {
    const memoryToken = initServerToken();                 // SERVER_TOKEN = memoryToken; file = memoryToken
    const tokenPath = path.join(os.homedir(), '.clawdcursor', 'token');
    const driftedDiskToken = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, driftedDiskToken, 'utf-8'); // another daemon lifecycle rewrote the file
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((..._a: unknown[]) => undefined) as never);
    const app = createUtilityServer({ onStop: vi.fn(async () => {}) });

    vi.useFakeTimers();
    const res = await request(app).post('/stop').set('Authorization', `Bearer ${driftedDiskToken}`);
    expect(res.status).toBe(200);             // accepted via the on-disk token (shutdown endpoint)
    expect(res.body.stopped).toBe(true);
    await vi.runAllTimersAsync();
    expect(exitSpy).toHaveBeenCalledWith(0);

    fs.writeFileSync(tokenPath, memoryToken, 'utf-8');       // restore so a real daemon isn't confused
  });

  it('still rejects a wrong token on /stop (matches neither memory nor disk)', async () => {
    initServerToken();
    const app = createUtilityServer({ onStop: vi.fn() });
    const res = await request(app).post('/stop').set('Authorization', 'Bearer deadbeef-not-a-real-token');
    expect(res.status).toBe(401);
  });
});
