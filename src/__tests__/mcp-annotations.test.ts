/**
 * MCP tool annotations (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint). Directories such as Glama
 * grade a server's tools on them: without any, every description had to carry the whole behavioural disclosure.
 */
import { describe, it, expect } from 'vitest';
import { getCompactSurface } from '../tools/registry';
import { toolAnnotations } from '../surface/mcp-server';

describe('MCP tool annotations', () => {
  it('every compact tool has a title and explicit hints', () => {
    const tools = getCompactSurface();
    expect(tools.map(t => t.name).sort()).toEqual(['accessibility', 'batch', 'browser', 'computer', 'system', 'task', 'window']);
    for (const t of tools) {
      const a = toolAnnotations(t);
      expect(a.title, t.name).toBeTruthy();
      expect(typeof a.readOnlyHint, t.name).toBe('boolean');
      expect(typeof a.destructiveHint, t.name).toBe('boolean');
    }
  });

  it('the compact tools can all change something, so none claims to be read-only', () => {
    for (const t of getCompactSurface()) expect(toolAnnotations(t).readOnlyHint, t.name).toBe(false);
  });

  it('granular tools without their own annotations are derived from the safety tier', () => {
    expect(toolAnnotations({ safetyTier: 0 })).toEqual({ readOnlyHint: true });
    expect(toolAnnotations({ safetyTier: 1 })).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations({ safetyTier: 2 })).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations({})).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it('window and system describe every action they advertise (Glama marked both C for a bare action list)', () => {
    for (const name of ['window', 'system']) {
      const t = getCompactSurface().find(x => x.name === name)!;
      const actions = (t.parameters.action as { enum: string[] }).enum;
      for (const a of actions) expect(t.description, `${name} ${a}`).toContain(`\`${a}\``);
      expect(t.description).not.toMatch(/Pick an action:/);
    }
  });
});
