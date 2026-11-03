import { describe, it, expect } from 'vitest';
import { resolveRef, REF_MIN_CONFIDENCE } from '../core/sense/ui-map-resolve';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id'>): UIElement => ({
  role: 'button', text: 'Send', normalized_text: 'send', bounds: [10, 20, 40, 12],
  confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true, ...over });

const mapWith = (els: UIElement[], id = 'obs_1'): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'notepad', process_id: '9',
  window_title: 'Untitled - Notepad', window_bounds: [0, 0, 800, 600],
  coordinate_space: 'screen', scale_factor: 1, compiled_at: '0',
  sources_used: ['window', 'a11y'], elements: els, anchors: {} });

const active = { processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } };

function holderWith(map: UIMap): UIMapHolder {
  const h = new UIMapHolder();
  while (h.nextId() !== map.snapshot_id) { /* advance counter to match the map id */ }
  h.put(map, 0);
  return h;
}

describe('invoke_element ref path — activation cascade', () => {
  it('cascades click -> select for a ListItem referenced by el_NN', async () => {
    const map = mapWith([el({ id: 'el_0', role: 'listitem', normalized_text: 'cool blue', text: 'Cool blue' })]);
    // Use a fresh timestamp so the snapshot is within TTL (tool uses Date.now() internally).
    const holder = new UIMapHolder();
    while (holder.nextId() !== map.snapshot_id) { /* advance counter */ }
    holder.put(map, Date.now());
    const attempts: string[] = [];
    const platform = {
      getActiveWindow: async () => active,
      invokeElement: async (q: any) => { attempts.push(q.action); return { success: q.action === 'select' }; },
    } as any;
    const ctx = { platform, task: 't', screen: { logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
    const invoke = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
    const res = await invoke.execute({ element_id: 'el_0', snapshot_id: 'obs_1' }, ctx);
    expect(res.success).toBe(true);
    expect(attempts).toEqual(['click', 'select']); // cascaded past the failing click
  });
});

describe('resolveRef', () => {
  it('rejects when only one of the two params is present', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: undefined }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/together/i);
  });

  it('rejects a stale snapshot (no dispatch plan)', () => {
    const h = holderWith(mapWith([el({ id: 'el_0' })]));
    h.invalidate();
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h, 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stale/i);
  });

  it('rejects element_id not in the snapshot', () => {
    const r = resolveRef({ element_id: 'el_99', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in snapshot/i);
  });

  it('rejects a low-confidence element', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0', confidence: REF_MIN_CONFIDENCE - 0.01 })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confidence/i);
  });

  it('rejects click on a non-actionable element / fill on a non-editable element', () => {
    const h = holderWith(mapWith([el({ id: 'el_0', actionable: false })]));
    expect(resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h, 0, 'click', active).ok).toBe(false);
    const h2 = holderWith(mapWith([el({ id: 'el_0', role: 'input', editable: false })]));
    expect(resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h2, 0, 'fill', active).ok).toBe(false);
  });

  it('plans an a11y dispatch when the name is unique', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ via: 'name', name: 'send' });
  });

  it('plans a bounds dispatch for a duplicate name (and passes window/bounds guards)', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [100, 200, 40, 12] })]; // two "send"
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', active);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ via: 'bounds', bounds: [100, 200, 40, 12] });
  });

  it('rejects bounds dispatch when the active window no longer matches the map window', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [100, 200, 40, 12] })];
    const otherWin = { processId: 5, processName: 'calc', title: 'Calculator', bounds: { x: 0, y: 0, width: 400, height: 400 } };
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', otherWin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/window/i);
  });

  it('flags a bounds dispatch whose element is outside the window rect as offView (scrolled out of view), not as refused', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [5000, 5000, 40, 12] })]; // below the fold
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', active);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ via: 'bounds', bounds: [5000, 5000, 40, 12], offView: true });
  });

  it('does not flag an element fully inside the window', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [100, 200, 40, 12] })];
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', active);
    expect(r.ok && r.via === 'bounds' && r.offView).toBeFalsy();
  });
});
