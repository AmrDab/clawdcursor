/**
 * Tests never write to the owner's real home. Running http-abort-stop and pause-mcp used to call initServerToken() and
 * rewrite the real ~/.clawdcursor/token, which signed a running daemon's clients out. tests/vitest.setup.ts now points
 * HOME / USERPROFILE at a private temp directory before any module resolves a path; this fails if that stops holding.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR, TOKEN_PATH } from '../paths';
import { initServerToken } from '../surface/http-utility';

const realHome = process.env.CLAWD_TEST_REAL_HOME ?? '';
const under = (child: string, parent: string) => !path.relative(fs.realpathSync(parent), path.resolve(child)).startsWith('..');

describe('test runs stay out of the real home', () => {
  it('os.homedir() and the clawdcursor data directory are under the temp directory, not the real home', () => {
    expect(realHome).not.toBe('');
    expect(os.homedir()).not.toBe(realHome);
    expect(under(fs.realpathSync(os.homedir()), os.tmpdir())).toBe(true);
    expect(DATA_DIR).toBe(path.join(os.homedir(), '.clawdcursor'));
    expect(TOKEN_PATH.startsWith(os.homedir())).toBe(true);
  });

  it('initServerToken() writes the test home\'s token and leaves the real one as it was', () => {
    const realToken = path.join(realHome, '.clawdcursor', 'token');
    const before = fs.existsSync(realToken) ? fs.readFileSync(realToken, 'utf-8') : null;
    const token = initServerToken();
    expect(fs.readFileSync(TOKEN_PATH, 'utf-8')).toBe(token);
    const after = fs.existsSync(realToken) ? fs.readFileSync(realToken, 'utf-8') : null;
    expect(after).toBe(before);
  });
});
