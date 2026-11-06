/**
 * A bad API key or exhausted credits at daemon start stops only the built-in agent.
 *
 * Audit 2026-11-05: on a 401 the daemon printed "Tools-only mode still works", then deleted the saved config and exited,
 * taking the MCP surface (which needs no key) down with it; a rotated key meant a full re-setup. runAgentMode has no unit
 * harness, so this is a source-level guard on the two branches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = readFileSync(join(__dirname, '..', 'surface', 'cli.ts'), 'utf8');
const start = cli.indexOf("if (err.name === 'LLMAuthError')");
const branches = cli.slice(start, cli.indexOf('} else {', cli.indexOf("err.name === 'LLMBillingError'")));

describe('daemon start — key or billing errors', () => {
  it('keep the saved config and keep serving', () => {
    expect(start).toBeGreaterThan(-1);
    expect(branches).toContain('LLMBillingError');
    expect(branches).not.toMatch(/unlinkSync|process\.exit|exitCode|return;/);
    expect(branches).toMatch(/MCP tools keep working/);
  });
});
