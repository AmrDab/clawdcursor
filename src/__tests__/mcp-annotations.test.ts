/**
 * MCP tool annotations (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint). Directories such as Glama
 * grade a server's tools on them: without any, every description had to carry the whole behavioural disclosure.
 */
import { describe, it, expect } from 'vitest';
import { getCompactSurface, getAllTools } from '../tools/registry';
import { toolAnnotations } from '../surface/mcp-server';

describe('MCP tool annotations', () => {
  it('every compact tool has a title and explicit hints', () => {
    const tools = getCompactSurface();
    expect(tools.map(t => t.name).sort()).toEqual(['accessibility', 'batch', 'browser', 'computer', 'system', 'window']);
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

  // 1.6 removed the policy gate, not the hints: hosts build their own approval UI on them, so every granular tool keeps
  // the value 1.5.27 published (tier 0 → read-only; the former tier 2/3 tools → destructive; the rest → neither).
  it('granular tools without their own annotations: a read is read-only, an input tool is destructive only when it says so', () => {
    expect(toolAnnotations({ safetyTier: 0 })).toEqual({ readOnlyHint: true });
    expect(toolAnnotations({ safetyTier: 1 })).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations({ safetyTier: 1, destructive: true })).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations({})).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it('only read (0) and input (1) tiers exist', () => {
    for (const t of getAllTools()) expect([0, 1], t.name).toContain(t.safetyTier);
  });

  it('destructiveHint is on exactly the tools that carried it in 1.5.27 (the former tier 2 and 3), plus batch', () => {
    const destructive = getAllTools().filter(t => toolAnnotations(t).destructiveHint).map(t => t.name).sort();
    expect(destructive).toEqual(['batch', 'cdp_evaluate', 'close_window', 'navigate_browser', 'open_file', 'open_uri', 'relaunch_with_cdp', 'submit_report', 'write_clipboard']);
  });

  it('ordinary input keeps destructiveHint:false, so a host does not start prompting on every click', () => {
    for (const name of ['mouse_click', 'mouse_scroll', 'type_text', 'key_press', 'key_down', 'invoke_element', 'set_field_value', 'smart_click', 'cdp_click', 'shortcuts_execute', 'focus_window', 'open_app']) {
      expect(toolAnnotations(getAllTools().find(t => t.name === name)!), name).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('no read-only tool sends input', () => {
    const readOnly = getAllTools().filter(t => toolAnnotations(t).readOnlyHint).map(t => t.name);
    for (const name of readOnly) expect(name, name).not.toMatch(/^(mouse_(click|double|right|middle|triple|drag|down)|type_text|key_(press|down)|invoke_element|close_window|open_(uri|file)|write_clipboard|cdp_(click|type|evaluate))/);
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
