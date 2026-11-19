/**
 * The setup and doctor output tell users what to register with their editor. Every packaged entry passes --compact (the
 * 90-tool granular surface is not the one to register), so the printed command does too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('the register hints name the compact surface', () => {
  for (const file of ['src/surface/cli.ts', 'src/surface/doctor.ts']) {
    it(`${file}: every printed "clawdcursor mcp" carries --compact`, () => {
      const src = readFileSync(join(__dirname, '../..', file), 'utf8');
      const printed = src.match(/clawdcursor mcp\b[^'`\n]*/g) ?? [];
      expect(printed.length).toBeGreaterThan(0);
      for (const p of printed) expect(p).toMatch(/^clawdcursor mcp --compact\b/);
    });
  }
});
