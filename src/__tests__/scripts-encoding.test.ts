/**
 * Every bridge script must be plain UTF-8 with LF endings. scripts/mac/
 * find-element.jxa was committed as UTF-16LE + CRLF (unlike every other .jxa),
 * which osascript / git text handling treat as binary.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { getPackageRoot } from '../paths';

const EXT = /\.(jxa|ps1|py|sh|swift)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

describe('scripts/** encoding', () => {
  const files = walk(join(getPackageRoot(), 'scripts'));

  it('finds the bridge scripts', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s is valid UTF-8 without a UTF-16 BOM and uses LF endings', (file) => {
    const buf = readFileSync(file);
    const bom16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    expect(bom16, 'UTF-16 BOM').toBe(false);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf), 'valid UTF-8').not.toThrow();
    expect(buf.includes('\r\n'), 'CRLF line endings').toBe(false);
  });
});
