import { describe, expect, it } from 'vitest';
import { getCompactSurface, getTool } from '../tools/registry';
import { evaluateToolCall, gateEachLabel, selectorLabels } from '../tools/safety-gate';
import { evaluate } from '../core/safety';
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

// invoke_element acts on the ref when one is given, then `name`, then
// `automationId`. The gate took the first non-empty of target/name/text/label/
// title/selector, so a benign `name` beside a ref to "Send", or an
// `automationId: "Send"` alone, activated Send with no confirmation.
describe('the destructive-label rule sees every selector the handler may act on', () => {
  function holderWithSend(): { holder: UIMapHolder; id: string } {
    const holder = new UIMapHolder();
    const id = holder.nextId();
    holder.put({
      snapshot_id: id, platform: 'windows', active_app: 'olk', window_title: 'Mail',
      window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
      compiled_at: '0', sources_used: ['window', 'a11y'], anchors: {},
      elements: [{
        id: 'el_7', role: 'button', text: 'Send', normalized_text: 'send',
        bounds: [10, 10, 50, 20], confidence: 0.9, sources: ['a11y'],
        actionable: true, clickable: true, editable: false,
      } as UIMap['elements'][number]],
    }, Date.now());
    return { holder, id };
  }

  it('gates automationId', () => {
    const gated = evaluateToolCall(getTool('invoke_element')!, { automationId: 'Send' });
    expect(gated?.text).toContain('safety confirm');
  });

  it('gates the ref even when a benign name is also given', () => {
    const { holder, id } = holderWithSend();
    const gated = evaluateToolCall(getTool('invoke_element')!, { name: 'Reply', element_id: 'el_7', snapshot_id: id }, { uiMaps: holder });
    expect(gated?.text).toContain('safety confirm');
  });

  it('gates the same payloads through the accessibility compound', () => {
    const tool = getCompactSurface().find(t => t.name === 'accessibility')!;
    expect(evaluateToolCall(tool, { action: 'invoke', automationId: 'Send' })?.text).toContain('safety confirm');
    const { holder, id } = holderWithSend();
    expect(evaluateToolCall(tool, { action: 'invoke', name: 'Reply', element_id: 'el_7', snapshot_id: id }, { uiMaps: holder })?.text)
      .toContain('safety confirm');
  });

  it('evaluates each selector on its own, so the intent match for one does not approve another', () => {
    // The agent loop passes the user's task: "send the email" intent-matches Send, never Delete.
    const args = { name: 'Send', automationId: 'Delete' };
    const gate = (selectors: unknown[]) => gateEachLabel(selectorLabels(selectors), targetLabel =>
      evaluate({ tool: 'invoke_element', args, targetLabel, userTaskText: 'send the email' }));
    expect(gate([args.name, args.automationId]).decision).toBe('confirm');
    expect(gate([args.name]).decision).toBe('allow'); // the bypass itself still works
    expect(gate([]).decision).toBe('allow');          // no selector: one no-label evaluation
  });

  it('does not over-gate: benign selectors pass, and text typed into a named target is still content', () => {
    expect(evaluateToolCall(getTool('invoke_element')!, { name: 'Reply', automationId: 'ReplyButton' })).toBeNull();
    expect(evaluateToolCall(getTool('smart_type')!, { target: 'Message body', text: 'please send the report' })).toBeNull();
  });
});
