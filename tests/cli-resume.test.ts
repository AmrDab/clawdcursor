/**
 * `clawdcursor resume [--end]` with no daemon. It answers only the daemon's pause: a stdio MCP server's has no port to
 * reach. On the Mac (2026-11-16) a stdio server's pause ended while `resume --end` printed "No running instance found on
 * port 3847" and exited 1, and that read as "it ended the pause but reported a failure". It had ended nothing: it now says
 * whose pause is on screen and that it cannot answer it, and still exits 1. Runs the built CLI with a private home.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'surface', 'cli.js');

beforeAll(() => {
  if (!fs.existsSync(CLI_PATH)) execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}, 120_000);

let home: string;
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A port nothing listens on: no daemon there. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

function resume(port: number, ...flags: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, 'resume', ...flags, '--port', String(port)], {
    cwd: home,
    // Without VITEST: under it, overlay-state.ts reads no overlay folder at all. Error reports stay off.
    env: { ...process.env, VITEST: undefined, CLAWD_TELEMETRY: '0', HOME: home, USERPROFILE: home },
    encoding: 'utf8', timeout: 60_000,
  });
}

describe('clawdcursor resume with no daemon', () => {
  it('a pause another clawdcursor process has on screen: says it cannot answer it, never "no running instance"', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resume-'));
    // This test process stands in for a stdio MCP server with its pause up (overlay-state.ts: one file per live process).
    const overlay = path.join(home, '.clawdcursor', 'overlay');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, `${process.pid}.json`), JSON.stringify({ pids: [], paused: true, at: Date.now() }));
    const port = await freePort();
    for (const flags of [['--end'], []]) {
      const r = resume(port, ...flags);
      expect(r.stdout).toContain(`No daemon on port ${port}, so nothing was answered. The pause on screen is clawdcursor process ${process.pid}'s`);
      expect(r.stdout).toContain('answer it on the card, Resume or End task.');
      expect(r.stdout).not.toContain('No running instance');
      expect(r.status).toBe(1);
    }
  }, 90_000);

  it('nothing paused and nothing running: still an error', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resume-'));
    const port = await freePort();
    const r = resume(port, '--end');
    expect(r.stdout).toContain(`No running instance found on port ${port}`);
    expect(r.status).toBe(1);
  }, 90_000);
});
