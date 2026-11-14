/**
 * Windows find/invoke matched an element whose name is INSIDE the request, however short: live (2026-10-20) a lone "C"
 * text run from a PDF tab matched "User code 0" and "MCP Registry". The reverse match now needs a real part of the
 * request (3+ chars and at least half its length); macOS and Linux only ever matched the forward way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

});
