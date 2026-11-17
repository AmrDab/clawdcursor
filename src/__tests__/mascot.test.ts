/**
 * scripts/mascot.json is the one source of the clawdcursor mascot's pixel art. Every drawer embeds its rows as string
 * literals between MASCOT-BEGIN <frame> / MASCOT-END marker comments, and this test keeps them identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const scripts = join(__dirname, '..', '..', 'scripts');
const mascot = JSON.parse(readFileSync(join(scripts, 'mascot.json'), 'utf8')) as { open: string[]; blink: string[] };

/** The rows between `<c> MASCOT-BEGIN <frame>` and `<c> MASCOT-END`, or null if the markers are absent. */
function embedded(source: string, comment: string, frame: string): string[] | null {
  const begin = `${comment} MASCOT-BEGIN ${frame}`;
  const at = source.indexOf(begin);
  if (at < 0) return null;
  const body = source.slice(at + begin.length, source.indexOf(`${comment} MASCOT-END`, at));
  return [...body.matchAll(/(['"])([.KBE]+)\1/g)].map(m => m[2]);
}

describe('the mascot art is the same in every drawer', () => {
  for (const frame of ['open', 'blink'] as const) {
    for (const file of ['banner.ps1', 'window-outline.ps1']) {
      it(`${file} embeds the ${frame} frame`, () => {
        expect(embedded(readFileSync(join(scripts, file), 'utf8'), '#', frame)).toEqual(mascot[frame]);
      });
    }
    it(`mac/overlay.swift embeds the ${frame} frame (once it has the markers)`, () => {
      const swiftPath = join(scripts, 'mac', 'overlay.swift');
      const rows = existsSync(swiftPath) ? embedded(readFileSync(swiftPath, 'utf8'), '//', frame) : null;
      if (rows === null) return;   // the macOS drawer merges later
      expect(rows).toEqual(mascot[frame]);
    });
  }
});
