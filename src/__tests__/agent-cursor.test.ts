/**
 * scripts/agent-cursor.json is the one source of the ghost cursor's pixel art: a retro arrow with no eyes, so the agent's
 * pointer never looks like the user's. Each drawer embeds its rows as string literals between AGENT-CURSOR-BEGIN /
 * AGENT-CURSOR-END marker comments, and this test keeps them identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = join(__dirname, '..', '..', 'scripts');
const art = JSON.parse(readFileSync(join(scripts, 'agent-cursor.json'), 'utf8')) as { legend: Record<string, string | null>; rows: string[] };

/** The rows between `<c> AGENT-CURSOR-BEGIN` and `<c> AGENT-CURSOR-END`, or null if the markers are absent. */
function embedded(source: string, comment: string): string[] | null {
  const begin = `${comment} AGENT-CURSOR-BEGIN`;
  const at = source.indexOf(begin);
  if (at < 0) return null;
  const body = source.slice(at + begin.length, source.indexOf(`${comment} AGENT-CURSOR-END`, at));
  return [...body.matchAll(/(['"])([.KB]+)\1/g)].map(m => m[2]);
}

describe('the agent cursor', () => {
  it('is a rim and a body only: no eyes, one frame', () => {
    expect(Object.keys(art.legend).sort()).toEqual(['.', 'B', 'K']);
    expect(art.rows.join('')).toMatch(/^[.KB]+$/);
    expect(art.rows.every(r => r.length === art.rows[0].length)).toBe(true);
    expect(art.rows[0][0]).toBe('K');   // the tip, the hotspot, is the top-left cell
  });

  it('window-outline.ps1 (Windows ghost) embeds the same grid', () => {
    expect(embedded(readFileSync(join(scripts, 'window-outline.ps1'), 'utf8'), '#')).toEqual(art.rows);
  });

  it('mac/overlay.swift (macOS ghost) embeds the same grid', () => {
    expect(embedded(readFileSync(join(scripts, 'mac', 'overlay.swift'), 'utf8'), '//')).toEqual(art.rows);
  });
});
