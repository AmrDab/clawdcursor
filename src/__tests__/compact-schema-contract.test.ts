/**
 * The compact surface publishes ONE schema per compound tool, merged from the parameters of every action's delegate. When
 * two delegates gave the same parameter different types, one silently won: live macOS run — `computer drag_path` was
 * published with `path` as an array while its delegate only took a JSON string, so every well-formed call failed. And a
 * parameter a delegate takes must be published, or the MCP layer strips it before it arrives (`expect` on `window`).
 */
import { describe, it, expect } from 'vitest';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact';

describe('compact schema ↔ delegate contract', () => {
  it('no parameter is declared with two different types by the delegates of one compound', () => {
    const byName = new Map(getAllTools().map(t => [t.name, t]));
    const conflicts: string[] = [];
    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      const seen = new Map<string, { type: string; from: string }>();
      for (const route of routes) {
        const g = byName.get(route.delegate);
        if (!g) continue;
        for (const [pname, pdef] of Object.entries(g.parameters)) {
          const published = route.argRemap ? (Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0] ?? pname) : pname;
          const prev = seen.get(published);
          if (prev && prev.type !== pdef.type) conflicts.push(`${compound}.${published}: ${prev.type} (${prev.from}) vs ${pdef.type} (${route.delegate})`);
          if (!prev) seen.set(published, { type: pdef.type, from: route.delegate });
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('every compound publishes `expect`, so it reaches the dispatcher instead of being stripped by the MCP layer', () => {
    for (const c of getCompactSurface()) {
      if (c.name === 'batch' || c.name === 'task') continue;
      expect(Object.keys(c.parameters), c.name).toContain('expect');
    }
  });
});
