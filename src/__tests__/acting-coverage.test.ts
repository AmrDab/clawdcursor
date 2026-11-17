/**
 * Every compact route action either acts (result-codes.ts ACTING: it gets an outcome line and empties the OCR cache,
 * call-guards.ts) or is listed here as not acting. A new action that is in neither fails this test, so it can not
 * silently go without its outcome line and its cache flush.
 */
import { describe, it, expect } from 'vitest';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact-routes';
import { isActingAction, isUnverifiableAction } from '../core/result-codes';

/** Reads, waits and calls that return a value: they change nothing on screen. */
const NOT_ACTING: Record<string, string[]> = {
  computer: ['hover', 'move', 'mouse_move', 'move_relative', 'wait', 'screenshot', 'screenshot_region', 'zoom'],
  accessibility: ['read_tree', 'find', 'get_element', 'focused', 'get_value', 'state', 'list_children', 'wait_for',
    'compile_ui', 'find_button', 'find_field', 'smart_read'],
  window: ['list', 'active', 'list_displays', 'screen_size'],
  system: ['clipboard_read', 'copy_all_text', 'report', 'telemetry_optout', 'system_time', 'ocr', 'shortcuts_list',
    'pause_for_user', 'detect_webview', 'build_uri'],
  // connect can launch a browser window: call-guards.ts empties the OCR cache for it by name, without an outcome line.
  browser: ['connect', 'page_context', 'read_text', 'evaluate', 'wait_for', 'list_tabs'],
};

const routes = Object.entries(COMPOUND_ROUTE_INDEX).flatMap(([compound, rs]) => rs.map(r => ({ compound, action: r.action })));

describe('acting actions cover the compact route table', () => {
  it('every route action is acting or listed as not acting, never both', () => {
    const unlisted = routes.filter(r => isActingAction(r.compound, r.action) === (NOT_ACTING[r.compound] ?? []).includes(r.action));
    expect(unlisted.map(r => `${r.compound}:${r.action}`)).toEqual([]);
  });

  it('the not-acting list names only real route actions', () => {
    const real = new Set(routes.map(r => `${r.compound}:${r.action}`));
    const stale = Object.entries(NOT_ACTING).flatMap(([c, as]) => as.map(a => `${c}:${a}`)).filter(k => !real.has(k));
    expect(stale).toEqual([]);
  });

  it('an unverifiable action is an acting one', () => {
    const odd = routes.filter(r => isUnverifiableAction(r.compound, r.action) && !isActingAction(r.compound, r.action));
    expect(odd.map(r => `${r.compound}:${r.action}`)).toEqual([]);
  });
});
