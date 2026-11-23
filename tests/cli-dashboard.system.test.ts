/**
 * `clawdcursor dashboard`: asks the running daemon for a one-time link with the token in ~/.clawdcursor/token and prints
 * it (--no-open here), and that link signs a browser in once. GET / no longer hands the token to anyone who asks (security
 * scan 2026-11). Runs the built CLI with a private home against a daemon's HTTP surface started in this process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { createUtilityServer } from '../src/surface/http-utility';
import { initServerToken } from '../src/surface/auth';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'surface', 'cli.js');

let server: Server;
let port: number;
let token: string;
let home: string;
beforeAll(async () => {
  if (!fs.existsSync(CLI_PATH)) execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  token = initServerToken();
  server = await new Promise<Server>(r => { const s = createUtilityServer({ host: '127.0.0.1', onStop: () => {} }).listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as net.AddressInfo).port;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dashboard-'));
  fs.mkdirSync(path.join(home, '.clawdcursor'), { recursive: true });
}, 120_000);
afterAll(() => { server?.close(); fs.rmSync(home, { recursive: true, force: true }); });

/** Async, not spawnSync: the daemon it talks to runs in this process. */
function dashboard(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI_PATH, 'dashboard', '--no-open', ...args], {
      cwd: home,
      env: { ...process.env, VITEST: undefined, CLAWD_TELEMETRY: '0', HOME: home, USERPROFILE: home },
      encoding: 'utf8', timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return p;
}

describe('clawdcursor dashboard', () => {
  it('prints a one-time link that sets the cookie once', async () => {
    fs.writeFileSync(path.join(home, '.clawdcursor', 'token'), token, { mode: 0o600 });
    const r = await dashboard('--port', String(port));
    expect(r.code, r.stderr).toBe(0);
    const url = r.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{64}/)?.[0];
    expect(url, r.stdout).toBeDefined();
    expect(r.stdout).toContain('valid 60 s');
    const { pathname, search } = new URL(url!);
    const first = await request(server).get(pathname + search).set('Host', `127.0.0.1:${port}`);
    expect(first.status).toBe(302);
    expect(String(first.headers['set-cookie'])).toContain(`clawdcursor_token=${token}`);
    const second = await request(server).get(pathname + search).set('Host', `127.0.0.1:${port}`);
    expect(second.status).toBe(401);
    expect(second.headers['set-cookie']).toBeUndefined();
  }, 90_000);

  it('without the daemon\'s token: an error, and no link', async () => {
    fs.writeFileSync(path.join(home, '.clawdcursor', 'token'), 'not-the-token', { mode: 0o600 });
    const r = await dashboard('--port', String(port));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unauthorized');
    expect(r.stdout).not.toMatch(/\?k=/);
  }, 90_000);

  it('no daemon: says how to start one', async () => {
    const free = await freePort();
    const r = await dashboard('--port', String(free));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`No running daemon on port ${free}`);
  }, 90_000);
});
