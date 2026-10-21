/**
 * Windows find/invoke matched an element whose name is INSIDE the request, however short: live (2026-10-20) a lone "C"
 * text run from a PDF tab matched "User code 0" and "MCP Registry". The reverse match now needs a real part of the
 * request (3+ chars and at least half its length); macOS and Linux only ever matched the forward way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bridge = readFileSync(join(here, '..', '..', 'scripts', 'ps-bridge.ps1'), 'utf8');
const fn = bridge.slice(bridge.indexOf('function Test-NameMatch'), bridge.indexOf('function Cmd-FindElement'));

describe('ps-bridge name matching', () => {
  it('find and invoke both go through Test-NameMatch (no bare reverse Contains left)', () => {
    expect(fn).toContain('function Test-NameMatch');
    expect(bridge).not.toMatch(/\$nameLower\.Contains\(\$elName\)/);
    expect(bridge.match(/Test-NameMatch \$elName \$nameLower/g)?.length).toBe(2);
  });

  it.runIf(process.platform === 'win32')('the real function: single letters no longer match, real parts still do', () => {
    const cases: Array<[string, string, boolean]> = [
      ['c', 'user code 0', false],
      ['p', 'mcp registry', false],
      ['user code 0', 'user code 0', true],
      ['save as', 'save', true],              // element contains the request
      ['file name', 'file name:', true],      // a real part of the request
      ['name', 'file name', false],           // too small a part: the Save-as column header
      ['', 'x', false],
    ];
    const script = `${fn}\n` + cases.map(([el, want]) => `Write-Output (Test-NameMatch '${el}' '${want}')`).join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000 })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    expect(out).toEqual(cases.map(c => (c[2] ? 'True' : 'False')));
  });
});
