/**
 * Compact is the default surface for `mcp` and `agent`; the granular surface is opt-in with --granular or
 * CLAWD_MCP_GRANULAR=1 (deprecated). --compact / CLAWD_MCP_COMPACT=1 stay accepted and ask for the default.
 */
import { describe, it, expect } from 'vitest';
import { pickCompact, GRANULAR_DEPRECATION } from '../surface/serve';

describe('pickCompact', () => {
  it('serves the compound tools with no flag and no variable', () => {
    expect(pickCompact({}, {})).toBe(true);
  });

  it('still accepts --compact and CLAWD_MCP_COMPACT=1, which ask for the default', () => {
    expect(pickCompact({ compact: true }, {})).toBe(true);
    expect(pickCompact({}, { CLAWD_MCP_COMPACT: '1' })).toBe(true);
  });

  it('serves the granular surface only on --granular or CLAWD_MCP_GRANULAR=1', () => {
    expect(pickCompact({ granular: true }, {})).toBe(false);
    expect(pickCompact({}, { CLAWD_MCP_GRANULAR: '1' })).toBe(false);
    expect(pickCompact({}, { CLAWD_MCP_GRANULAR: '0' })).toBe(true);
  });

  it('--granular wins over --compact', () => {
    expect(pickCompact({ compact: true, granular: true }, {})).toBe(false);
  });

  it('the deprecation line names the way back', () => {
    expect(GRANULAR_DEPRECATION).toMatch(/deprecated/);
    expect(GRANULAR_DEPRECATION).toMatch(/--granular/);
  });
});
