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
        if (!g) { conflicts.push(`${compound}.${route.action}: delegate ${route.delegate} is not registered`); continue; }
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

  // Issue #273: the merged schema marks every field optional, so `find_button` with `target` (a real field of
  // smart_click) passed the MCP layer and failed at runtime for the missing `intent`. Each action's required fields
  // must be published, under the compound's names, in the `action` description that callers read.
  it('every action\'s required fields are published and named in the `action` description', () => {
    const byName = new Map(getAllTools().map(t => [t.name, t]));
    const compounds = new Map(getCompactSurface().map(t => [t.name, t]));
    const problems: string[] = [];
    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      const params = compounds.get(compound)?.parameters ?? {};
      const text = /Required: (.*)\.$/.exec(params.action?.description ?? '')?.[1] ?? '';
      const listed = new Map<string, string[]>();
      for (const entry of text.split('; ')) {
        const [actions, fields = ''] = entry.split(': ');
        for (const a of actions.split('/')) listed.set(a, fields.split(', '));
      }
      for (const route of routes) {
        const g = byName.get(route.delegate);
        if (!g) { problems.push(`${compound}.${route.action}: delegate ${route.delegate} is not registered`); continue; }
        for (const [pname, pdef] of Object.entries(g.parameters)) {
          if (pdef.required !== true) continue;
          const published = route.argRemap ? (Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0] ?? pname) : pname;
          if (!(published in params)) problems.push(`${compound}.${route.action}: required ${published} is not a published parameter`);
          if (!listed.get(route.action)?.includes(published)) problems.push(`${compound}.${route.action}: required ${published} is not named in the action description`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every compound publishes `expect`, so it reaches the dispatcher instead of being stripped by the MCP layer', () => {
    for (const c of getCompactSurface()) {
      if (c.name === 'batch' || c.name === 'task') continue;
      expect(Object.keys(c.parameters), c.name).toContain('expect');
    }
  });
});

// Audit 2026-11-05: invoke_element's own `action` enum (click|set-value|get-value…) was merged into the accessibility
// compound's, so the schema advertised `accessibility {action:"click"}`, and the call failed with "that action lives on
// the computer compound" — steering the agent to pixel clicks.
describe('compact actions are real', () => {
  it('every action a compound publishes has a route', () => {
    const missing: string[] = [];
    for (const c of getCompactSurface()) {
      const routes = COMPOUND_ROUTE_INDEX[c.name];
      if (!routes) continue;
      for (const a of (c.parameters.action?.enum ?? []) as string[]) {
        if (!routes.some(r => r.action === a)) missing.push(`${c.name}.${a}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('`accessibility click` points to invoke, not to pixel clicks', async () => {
    const acc = getCompactSurface().find(t => t.name === 'accessibility')!;
    const r = await acc.handler({ action: 'click', name: 'OK' }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/use action "invoke"/);
    expect(r.text).not.toMatch(/computer/);
  });
});
