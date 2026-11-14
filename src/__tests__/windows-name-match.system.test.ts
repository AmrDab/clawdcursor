/**
 * Windows find/invoke matched an element whose name is INSIDE the request, however short: live (2026-10-20) a lone "C"
 * text run from a PDF tab matched "User code 0" and "MCP Registry". The reverse match now needs a real part of the
 * request (3+ chars and at least half its length); macOS and Linux only ever matched the forward way.
 */
import { describe, it, expect } from 'vitest';
import { runPs } from './helpers/ps-bridge-harness';

describe('ps-bridge name matching', () => {
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
    const out = runPs(['Test-NameMatch'], cases.map(([el, want]) => `Write-Output (Test-NameMatch '${el}' '${want}')`).join('\n'))
      .map(s => s.trim()).filter(Boolean);
    expect(out).toEqual(cases.map(c => (c[2] ? 'True' : 'False')));
  });
});
