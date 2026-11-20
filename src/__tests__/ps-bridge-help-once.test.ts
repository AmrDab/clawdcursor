/**
 * #410: the Windows bridge reads a node's HelpText once and compares it with the name it already read: every UIA property
 * read is a cross-process call, and read_tree / find make them per node.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ps = readFileSync(join(__dirname, '..', '..', 'scripts', 'ps-bridge.ps1'), 'utf-8');

describe('ps-bridge HelpText reads', () => {
  it('each HelpText is read once, and compared with the stored name rather than a second live Name read', () => {
    const lines = ps.split('\n').filter(l => l.includes('HelpText') && !l.trim().startsWith('#'));
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l.match(/\.HelpText/g)).toHaveLength(1);
      expect(l).not.toMatch(/-ne \$(?:cur|c)\.Name/);
    }
  });
});
