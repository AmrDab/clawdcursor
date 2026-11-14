/**
 * The dashboard reads its log panel from GET /logs. It used to call the logs_recent MCP tool every 2 s: each poll was a
 * recorded session call (so `clawdcursor report` picked the dashboard as the latest session), polls were refused and
 * logged while stopped, and on a --compact daemon the panel was simply unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dashboardPage } from '../surface/dashboard';
import { createUtilityServer } from '../surface/http-utility';
import { initServerToken } from '../surface/auth';
import { captureConsole } from '../surface/log-buffer';
import { listSessions } from '../surface/session-log';
import { stopControl, resumeControl, __setControlDirForTests } from '../core/control';

describe('GET /logs', () => {
  let token: string;
  beforeAll(() => { token = initServerToken(); captureConsole(); });
  afterAll(() => { resumeControl('test'); __setControlDirForTests(null); });
  const app = () => createUtilityServer({ host: '127.0.0.1', onStop: () => {} });

  it('with the token: the captured console lines', async () => {
    console.log('dashboard-surface: a line for the panel');
    const res = await request(app()).get('/logs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((l: { message: string }) => l.message)).toContain('dashboard-surface: a line for the panel');
    expect(res.body[0]).toEqual(expect.objectContaining({ timestamp: expect.any(Number), level: expect.any(String) }));
  });

  it('without the token: 401', async () => {
    expect((await request(app()).get('/logs')).status).toBe(401);
  });

  it('works while stopped and records no session call', async () => {
    __setControlDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-dash-ctl-')));
    stopControl('test');
    const before = listSessions().length;
    const res = await request(app()).get('/logs').set('Cookie', `clawdcursor_token=${token}`);
    expect(res.status).toBe(200);
    expect(listSessions().length).toBe(before);
  });
});

describe('dashboard page', () => {
  function page(): string {
    let html = '';
    const res = { cookie() {}, type() { return { send: (s: string) => { html = s; } }; } };
    dashboardPage()({} as never, res as never, () => {});
    return html;
  }

  it('reads its logs from GET /logs and calls no MCP tool', () => {
    const html = page();
    expect(html).toMatch(/fetch\('\/logs', \{ headers: authHeaders\(\) \}\)/);
    expect(html).not.toContain('/mcp');
    expect(html).not.toContain('tools/');
    // The pause banner still answers through POST /resume.
    expect(html).toContain("fetch('/resume'");
  });

  it('shows the pause banner from the authenticated GET /resume, not from /health', () => {
    const html = page();
    expect(html).toMatch(/fetch\('\/resume', \{ headers: authHeaders\(\) \}\)/);
    expect(html).toContain('Resume');
    expect(html).toContain('End task');
  });

  it('has no Tasks or Scheduled tab, task form or favorites left', () => {
    const html = page();
    for (const gone of ['panelTask', 'panelScheduled', 'sendTask', 'taskInput', 'switchTab', 'Scheduled', 'favorites_', 'submit_task']) {
      expect(html).not.toContain(gone);
    }
  });

  it('the embedded script parses', () => {
    const script = page().split('<script>')[1].split('</script>')[0];
    expect(() => new Function(script)).not.toThrow();
  });
});
