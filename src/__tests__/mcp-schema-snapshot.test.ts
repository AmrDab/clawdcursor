/**
 * MCP schema-snapshot gate.
 *
 * Protects what an agent receives from the real server — initialize (instructions, capabilities) and tools/list
 * (names, descriptions with their cost prefix, input schemas, annotations) for the compact and the granular surface —
 * from accidental drift. Any PR that changes it fails this test until the snapshot is updated intentionally with:
 *   npm run test:mcp-schema-snapshot:update
 */

import { describe, it, expect } from 'vitest';
import { currentSnapshot, readStoredSnapshot } from '../schema/snapshot';

describe('MCP schema snapshot', () => {
  it('matches the committed schema.snapshot.json', async () => {
    const stored = readStoredSnapshot();
    expect(
      stored,
      'schema.snapshot.json missing. Generate with: npm run test:mcp-schema-snapshot:update',
    ).not.toBeNull();
    expect(await currentSnapshot()).toEqual(stored);
  }, 60_000);
});
