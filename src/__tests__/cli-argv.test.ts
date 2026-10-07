/**
 * Reproduced 2026-10: Claude Desktop runs extensions via Electron's
 * utilityProcess.fork(cli.js, ['mcp', '--compact']). commander's Electron
 * auto-detection (packaged app → drop only argv[0]) kept the script path as the
 * command, so the .mcpb died with `error: unknown command '…\cli.js'`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { userArgs } from '../surface/argv';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-argv-'));
const script = path.join(dir, 'dist', 'surface', 'cli.js');
fs.mkdirSync(path.dirname(script), { recursive: true });
fs.writeFileSync(script, '');

describe('userArgs', () => {
  it('plain Node: node <script> mcp --compact', () => {
    expect(userArgs(['node', script, 'mcp', '--compact'], script, false)).toEqual(['mcp', '--compact']);
  });

  it('packaged Electron utility process: <app.exe> <script> mcp --compact (the .mcpb launch)', () => {
    expect(userArgs(['C:\\Apps\\Claude\\claude.exe', script, 'mcp', '--compact'], script, true)).toEqual(['mcp', '--compact']);
  });

  it('Electron with no script in argv: <app.exe> mcp', () => {
    expect(userArgs(['C:\\Apps\\Claude\\claude.exe', 'mcp'], script, true)).toEqual(['mcp']);
  });

  it('a wrapper that is not the script itself falls back to Node conventions', () => {
    expect(userArgs(['node', path.join(dir, 'other.js'), 'consent', '--accept'], script, false)).toEqual(['consent', '--accept']);
  });

  it.runIf(process.platform === 'win32')('matches the script path case-insensitively on Windows', () => {
    expect(userArgs(['node', script.toUpperCase(), 'mcp'], script, false)).toEqual(['mcp']);
  });

  it.runIf(process.platform !== 'win32')('a symlinked bin resolves to the script', () => {
    const link = path.join(dir, 'clawdcursor');
    fs.symlinkSync(script, link);
    expect(userArgs(['node', link, 'mcp'], script, true)).toEqual(['mcp']);
  });
});
