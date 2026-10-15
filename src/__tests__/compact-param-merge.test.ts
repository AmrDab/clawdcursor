/**
 * Every compound action's own parameters must validate against the merged
 * compound schema. Live blind test (Ubuntu 24.04): `accessibility find_field
 * {purpose:"file name"}` was rejected with 'expected one of "general"|
 * "find_text"|"act"' — compile_ui's `purpose` enum had swallowed find_field's
 * free-text `purpose` in the first-wins merge.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { getTool } from '../tools/registry';
import { getCompactTools, COMPOUND_ROUTE_INDEX } from '../tools/compact';
import type { ParameterDef } from '../tools/types';

/** A value the granular tool itself accepts for this param. */
function sampleFor(def: ParameterDef): unknown {
  if (def.enum?.length) return def.enum[def.enum.length - 1];
  if (def.type === 'number') return def.minimum ?? 1;
  if (def.type === 'boolean') return true;
  if (def.type === 'array') return [];
  return 'free text value';
}

/** Mirrors the MCP server's zod projection of a ParameterDef. */
function accepts(def: ParameterDef, v: unknown): boolean {
  if (def.enum) return typeof v === 'string' && def.enum.includes(v);
  if (def.type === 'number') return typeof v === 'number';
  if (def.type === 'boolean') return typeof v === 'boolean';
  if (def.type === 'array') return Array.isArray(v) || typeof v === 'string';
  return typeof v === 'string';
}

describe('compound schema merge', () => {
  const compounds = new Map(getCompactTools().map(t => [t.name, t]));

  for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
    it(`${compound}: every action's own params validate against the compound schema`, () => {
      const schema = compounds.get(compound)!.parameters;
      const broken: string[] = [];
      for (const route of routes) {
        const granular = getTool(route.delegate);
        if (!granular) continue;
        for (const [pname, pdef] of Object.entries(granular.parameters)) {
          const exposed = route.argRemap
            ? Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0] ?? pname
            : pname;
          const pub = schema[exposed];
          const v = sampleFor(pdef);
          if (!pub || !accepts(pub, v)) broken.push(`${route.action}.${exposed}=${JSON.stringify(v)}`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  it('find_field accepts a free-text purpose; compile_ui still lists its purposes', () => {
    const p = compounds.get('accessibility')!.parameters.purpose;
    expect(accepts(p, 'file name')).toBe(true);
    expect(p.description).toMatch(/general/);
  });
});
