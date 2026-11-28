/**
 * The setup and doctor output tell users what to register with their editor. From 3.0 the six compound tools are the only
 * surface, so the printed command is the bare `clawdcursor mcp` (--compact is still accepted, and does nothing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('the register hints name the one command', () => {
  for (const file of ['src/surface/cli.ts', 'src/surface/doctor.ts']) {
    it(`${file}: every printed "clawdcursor mcp" is the bare command`, () => {
      const src = readFileSync(join(__dirname, '../..', file), 'utf8');
      const printed = src.match(/clawdcursor mcp\b[^'`\n]*/g) ?? [];
      expect(printed.length).toBeGreaterThan(0);
      for (const p of printed) expect(p).not.toMatch(/--compact|--granular/);
    });
  }
});
