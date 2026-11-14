/**
 * GHSA-9ppf-38v8-h97v: values reach PowerShell as data, never inside a script's source.
 * PowerShell ends a single-quoted string at ' and also at ‘ ’ ‚ ‛ (U+2018–U+201B), so doubling ' was not enough:
 * clipboard text holding ’;<code>;’ ran <code> when type_text pasted it, or when the user's clipboard was put back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { setWindowsClipboard } from '../platform/ps-input';
import { psOpts } from '../platform/ps-spawn';
import { LIVE } from './helpers/live';

const QUOTES = ["'", '‘', '’', '‚', '‛'];

// Writes the REAL clipboard (put back afterwards): CLAWD_LIVE_TESTS=1 only.
describe.runIf(process.platform === 'win32' && LIVE)('setWindowsClipboard (live)', () => {
  const marker = path.join(os.tmpdir(), `clawd-ghsa-${process.pid}`);
  const readClipboard = () => Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = "" }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))'],
    psOpts()).toString().trim(), 'base64').toString('utf8');
  let before = '';
  beforeAll(() => { before = readClipboard(); }); // not at collection: a skipped describe body still runs
  afterAll(async () => { await setWindowsClipboard(before, 5000).catch(() => {}); fs.rmSync(marker, { force: true }); });

  for (const q of QUOTES) {
    it(`text holding U+${q.codePointAt(0)!.toString(16).toUpperCase()} is copied as text and never runs`, async () => {
      const payload = `x${q};New-Item -ItemType File -Path '${marker}' | Out-Null;${q}`;
      await setWindowsClipboard(payload, 10_000);
      expect(fs.existsSync(marker)).toBe(false);
      expect(readClipboard().replace(/\r?\n$/, '')).toBe(payload);
    }, 20_000);
  }

  it('keeps newlines, non-ASCII and large text intact', async () => {
    const text = `line 1\r\nzwei — ✓ 日本語 😀\r\n${'y'.repeat(40_000)}`;
    await setWindowsClipboard(text, 10_000);
    expect(readClipboard().replace(/\r?\n$/, '')).toBe(text);
  }, 20_000);
});
