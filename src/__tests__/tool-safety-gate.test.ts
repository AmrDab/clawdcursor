import { describe, expect, it } from 'vitest';
import { getCompactSurface, getTool } from '../tools/registry';
import { evaluateToolCall } from '../tools/safety-gate';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';

describe('direct tool safety gate', () => {
  it('allows read-only tools', () => {
    const tool = getTool('read_screen');
    expect(tool).toBeTruthy();
    expect(evaluateToolCall(tool!, {})).toBeNull();
  });

  it('HARD-blocks lock/force-quit key combos before handler execution', () => {
    const tool = getTool('key_press');
    const result = evaluateToolCall(tool!, { key: 'ctrl+alt+delete' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety block');
  });

  it('CONFIRMS (not hard-blocks) consequential combos like alt+f4 (v1.6.0)', () => {
    const tool = getTool('key_press');
    const result = evaluateToolCall(tool!, { key: 'alt+f4' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety confirm');
  });

  it('fails closed for confirm-tier direct REST/MCP actions', () => {
    const tool = getTool('close_window');
    const result = evaluateToolCall(tool!, {});
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety confirm');
  });

  it('maps compact actions to their granular safety tier', () => {
    const tool = getCompactSurface().find(t => t.name === 'browser');
    const result = evaluateToolCall(tool!, { action: 'evaluate', javascript: 'document.cookie' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('requires user confirmation');
  });

  it('resolves an el_NN ref to its label so the destructive-label rule fires on the MCP route', () => {
    // audit 2026-06-10, finding E: an MCP invoke_element({element_id,
    // snapshot_id}) carried no label, so a ref click on a "Send" button
    // bypassed CONFIRM_LABEL_PATTERNS entirely.
    const holder = new UIMapHolder();
    const id = holder.nextId();
    const map: UIMap = {
      snapshot_id: id, platform: 'windows', active_app: 'olk', window_title: 'Mail',
      window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
      compiled_at: '0', sources_used: ['window', 'a11y'], anchors: {},
      elements: [{
        id: 'el_7', role: 'button', text: 'Send', normalized_text: 'send',
        bounds: [10, 10, 50, 20], confidence: 0.9, sources: ['a11y'],
        actionable: true, clickable: true, editable: false,
      } as UIMap['elements'][number]],
    };
    holder.put(map, Date.now());
    const tool = getTool('invoke_element');
    expect(tool).toBeTruthy();
    const args = { element_id: 'el_7', snapshot_id: id };
    // WITHOUT the holder the gate sees no label → the Send rule cannot fire.
    expect(evaluateToolCall(tool!, args)).toBeNull();
    // WITH the holder the ref resolves to "Send" → confirm-tier elevation.
    const gated = evaluateToolCall(tool!, args, { uiMaps: holder });
    expect(gated?.isError).toBe(true);
    expect(gated?.text).toContain('safety confirm');
  });
});

// A compound action was tiered from the TOOL_TIER name table, not the tier its
// delegate declares. TOOL_TIER had open_file / navigate_browser at 'input' while
// both tools declare tier 2, so window/system {open_file} and browser/window
// {navigate} ran with no confirmation that the granular tools require.
describe('a compound action is gated like the granular tool it dispatches to', () => {
  const verdict = (r: ReturnType<typeof evaluateToolCall>) =>
    !r ? 'allow' : r.text.includes('safety confirm') ? 'confirm' : 'block';

  it.each([
    ['window', 'open_file'], ['system', 'open_file'], ['window', 'navigate'], ['browser', 'navigate'],
  ])('%s {action:"%s"} needs confirmation', (compound, action) => {
    const tool = getCompactSurface().find(t => t.name === compound)!;
    expect(verdict(evaluateToolCall(tool, { action }))).toBe('confirm');
  });

  it('every compound route matches its delegate', () => {
    const surface = getCompactSurface();
    const mismatches: string[] = [];
    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      const tool = surface.find(t => t.name === compound)!;
      for (const route of routes) {
        const delegate = getTool(route.delegate);
        if (!delegate) continue;
        const granular = verdict(evaluateToolCall(delegate, {}));
        const viaCompound = verdict(evaluateToolCall(tool, { action: route.action }));
        if (granular !== viaCompound) mismatches.push(`${compound}.${route.action} → ${route.delegate}: ${viaCompound} vs ${granular}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
