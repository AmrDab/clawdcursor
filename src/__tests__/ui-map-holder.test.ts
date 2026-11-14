import { describe, it, expect } from 'vitest';
import { UIMapHolder, TTL_MS, MAX_HELD, COST_RANK } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';

const mapWith = (id: string): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'Notepad', window_title: 'Untitled',
  window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
  compiled_at: '0', sources_used: ['window', 'a11y'], elements: [], anchors: {},
});

describe('UIMapHolder', () => {
  it('nextId mints monotonic obs_N ids', () => {
    const h = new UIMapHolder();
    expect(h.nextId()).toBe('obs_1');
    expect(h.nextId()).toBe('obs_2');
  });

  it('resolves the current map within TTL', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS - 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.snapshot_id).toBe(id);
  });

  it('rejects an expired map (past TTL) even if it is the latest', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS + 1);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown / evicted id', () => {
    const h = new UIMapHolder();
    expect(h.resolve('obs_999', 0)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a held-but-not-current id as stale', () => {
    const h = new UIMapHolder();
    const a = h.nextId(); h.put(mapWith(a), 0);
    const b = h.nextId(); h.put(mapWith(b), 0);
    expect(h.resolve(a, 0)).toEqual({ ok: false, reason: 'stale' });
    expect(h.resolve(b, 0).ok).toBe(true);
  });

  it('keeps at most MAX_HELD maps (oldest evicted -> unknown)', () => {
    const h = new UIMapHolder();
    const ids = Array.from({ length: MAX_HELD + 1 }, () => { const i = h.nextId(); h.put(mapWith(i), 0); return i; });
    expect(h.resolve(ids[0], 0)).toEqual({ ok: false, reason: 'unknown' }); // evicted
    expect(h.resolve(ids[ids.length - 1], 0).ok).toBe(true);
  });

  it('invalidate() makes the current map resolve as stale', () => {
    const h = new UIMapHolder();
    const id = h.nextId(); h.put(mapWith(id), 0);
    h.invalidate();
    expect(h.resolve(id, 0)).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('UIMapHolder — currentIfCost (cost-aware reuse)', () => {
  it('reuses a fresh current map compiled at >= requested cost', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'ocr_ok');
    expect(h.currentIfCost('ocr_ok', 1000)?.snapshot_id).toBe(id); // equal cost ok
    expect(h.currentIfCost('cheap', 1000)?.snapshot_id).toBe(id);  // higher-than-requested ok
  });

  it('refuses a cheaper-than-requested map (compile fresh)', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'cheap');
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull(); // cheap < ocr_ok
  });

  it('refuses a stale/expired/invalidated map', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'ocr_ok');
    expect(h.currentIfCost('ocr_ok', 1000 + TTL_MS + 1)).toBeNull(); // expired
    h.invalidate();
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull();             // invalidated
  });

  it('treats an unrecorded (undefined) cost as not satisfying an ocr_ok request', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);                 // legacy 2-arg put, no cost recorded
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull();
    expect(COST_RANK.cheap).toBeLessThan(COST_RANK.ocr_ok);
  });
});
