/**
 * `clawdcursor consent --accept` — the first command a new user runs —
 * printed "(node) [DEP0040] DeprecationWarning: The `punycode` module is
 * deprecated" from a transitive dependency. Run the built CLI and make sure
 * that one warning is gone (other warnings are left alone).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'surface', 'cli.js');

beforeAll(() => {
  if (!fs.existsSync(CLI_PATH)) execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}, 120_000);

describe('CLI output', () => {
  it('consent --accept prints no punycode deprecation', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-noise-'));
    try {
      const r = spawnSync(process.execPath, [CLI_PATH, 'consent', '--accept'], {
        cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 60_000,
      });
      expect(r.stdout).toContain('Consent accepted');
      expect(r.stderr).not.toMatch(/DEP0040|punycode/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
