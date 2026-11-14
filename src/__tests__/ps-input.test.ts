/**
 * GHSA-9ppf-38v8-h97v: values reach PowerShell as data, never inside a script's source.
 * PowerShell ends a single-quoted string at ' and also at ‘ ’ ‚ ‛ (U+2018–U+201B), so doubling ' was not enough:
 * clipboard text holding ’;<code>;’ ran <code> when type_text pasted it, or when the user's clipboard was put back.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('no PowerShell source is built by quoting a value', () => {
  it('nothing doubles apostrophes to embed a value in a script', () => {
    const offenders = sources(SRC).filter(f => fs.readFileSync(f, 'utf8').includes(`replace(/'/g, "''")`));
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([]);
  });
});
