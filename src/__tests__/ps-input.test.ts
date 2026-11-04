/**
 * GHSA-9ppf-38v8-h97v: values reach PowerShell as data, never inside a script's source.
 * PowerShell ends a single-quoted string at ' and also at ‘ ’ ‚ ‛ (U+2018–U+201B), so doubling ' was not enough:
 * clipboard text holding ’;<code>;’ ran <code> when type_text pasted it, or when the user's clipboard was put back.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { setWindowsClipboard } from '../platform/ps-input';

const SRC = path.join(__dirname, '..');
const QUOTES = ["'", '‘', '’', '‚', '‛'];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('no PowerShell source is built by quoting a value', () => {
  it('nothing doubles apostrophes to embed a value in a script', () => {
    const offenders = sources(SRC).filter(f => fs.readFileSync(f, 'utf8').includes(`replace(/'/g, "''")`));
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('setWindowsClipboard (live)', () => {
  const marker = path.join(os.tmpdir(), `clawd-ghsa-${process.pid}`);
  const readClipboard = () => Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = "" }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))'],
  ).toString().trim(), 'base64').toString('utf8');
  const before = readClipboard();
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
