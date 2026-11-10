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

  // 1.6: clawdcursor refuses nothing by tier. The hints are what an MCP host reads to decide its own permission prompt,
  // so they must say what a tool can do: an input tool is destructive unless it declares that it cannot be.
  it('granular tools without their own annotations: a read is read-only, an input tool is destructive unless it opts out', () => {
    expect(toolAnnotations({ safetyTier: 0 })).toEqual({ readOnlyHint: true });
    expect(toolAnnotations({ safetyTier: 1 })).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations({ safetyTier: 1, destructive: false })).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations({})).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('only read (0) and input (1) tiers exist', () => {
    for (const t of getAllTools()) expect([0, 1], t.name).toContain(t.safetyTier);
  });

  it('the tools the removed gate held back, and every tool that clicks, types or presses keys, carry destructiveHint', () => {
    const destructive = getAllTools().filter(t => toolAnnotations(t).destructiveHint).map(t => t.name);
    for (const name of [
      'close_window', 'open_uri', 'open_file', 'write_clipboard', 'navigate_browser', 'cdp_evaluate', 'relaunch_with_cdp', 'submit_report',
      'mouse_click', 'mouse_double_click', 'mouse_right_click', 'mouse_drag', 'type_text', 'key_press', 'key_down', 'invoke_element',
      'set_field_value', 'smart_click', 'smart_type', 'a11y_toggle', 'a11y_select', 'cdp_click', 'cdp_type', 'cdp_select_option',
      'shortcuts_execute', 'undo_last', 'batch',
    ]) expect(destructive, name).toContain(name);
  });

  it('the input tools announced as non-destructive are exactly the ones that move, scroll, arrange or release', () => {
    const benign = getAllTools().filter(t => { const a = toolAnnotations(t); return a.readOnlyHint === false && a.destructiveHint === false; }).map(t => t.name).sort();
    expect(benign).toEqual([
      'a11y_collapse', 'a11y_expand', 'cdp_connect', 'cdp_scroll', 'cdp_switch_tab', 'copy_all_text',
      'focus_element', 'focus_window', 'key_up', 'maximize_window', 'minimize_window', 'minimize_window_to_taskbar', 'mouse_hover',
      'mouse_move_relative', 'mouse_scroll', 'mouse_scroll_horizontal', 'mouse_up', 'open_app', 'open_url', 'resize_window', 'restore_window',
      'resume_task', 'switch_tab_os',
    ]);
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
