/**
 * scripts/linux/ocr-recognize.py + atspi-bridge.py logic tests.
 *
 * Runs the fixture driver (src/__tests__/fixtures/linux-scripts-driver.py)
 * under whatever Python 3 is on PATH. The driver installs a fake
 * `gi.repository.Atspi` so the bridge imports without AT-SPI, feeds both
 * scripts hand-built input and prints one JSON blob. Skipped (not failed)
 * when no Python 3 interpreter is available.
 *
 * Live bugs covered (Ubuntu 24.04 MCP run):
 *   L1 tesseract 5 emits float confidences ("81.879456"); int() raised and
 *      the whole OCR call failed.
 *   L8 `--cmd invoke` did not exist.
 *   L9 empty / partial AT-SPI state sets were reported as disabled; all-zero
 *      SCREEN extents were published as-is.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, 'fixtures', 'linux-scripts-driver.py');
const SCRIPTS = join(here, '..', '..', 'scripts', 'linux');

function findPython(): string | null {
  for (const cand of ['python3', 'python']) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0 && /^Python 3\./.test(out.trim())) return cand;
  }
  return null;
}

const PY = findPython();

describe.skipIf(PY === null)('scripts/linux python helpers', () => {
  let out: any;
  it('driver runs', () => {
    const r = spawnSync(PY!, [DRIVER, SCRIPTS], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    out = JSON.parse(r.stdout);
  });

  // ── L1 ──
  it('OCR TSV parser accepts tesseract 5 float confidences', () => {
    const ocr = out.ocr;
    expect(ocr.error).toBeUndefined();
    expect(ocr.elements.map((e: any) => e.text)).toEqual(['Hello', 'World', 'Test']);
    expect(ocr.elements[0]).toMatchObject({ x: 10, y: 20, width: 50, height: 15, confidence: 0.82, line: 1 });
    expect(ocr.elements[1].confidence).toBe(0.96);
    expect(ocr.elements[2].confidence).toBe(0);
    expect(ocr.fullText).toBe('Hello World\nTest');
  });

  // Live (Ubuntu 24.04 VM): default page segmentation found NO text on a 1080p
  // desktop; sparse mode on a 2x upscale read every label.
  it('OCR uses sparse-text mode and maps upscaled boxes back to screen pixels', () => {
    expect(out.ocr_psm).toBe('11');
    expect(out.ocr_scaled.elements[0]).toMatchObject({ x: 5, y: 10, width: 25, height: 8 });
    expect(out.ocr_sparse.fullText).toBe('Submit\nCancel');
  });

  // Live (xcalc): sparse mode numbered every word line 1, so smart_click
  // joined "@" from one row with "sin" from the row above ("@ sin").
  it('OCR line = visual row, not tesseract\'s per-block line_num', () => {
    const r = out.ocr_rows;
    expect(r.sin).toBe(r.tan);
    expect(r['@']).not.toBe(r.sin);
    expect(r.Save).toBe(r.As);
    expect(r.Save).toBeGreaterThan(r['@']);
  });

  // ── L7 (bridge side) ──
  it('find with --process-id searches only that application', () => {
    expect(out.find_scoped.elements.map((e: any) => e.processId)).toEqual([4242]);
    expect(out.find_other.elements.map((e: any) => e.processId)).toEqual([5555]);
  });

  // ── L9 ──
  it('state mapping: empty state set → enabled unknown; SENSITIVE alone → enabled', () => {
    expect(out.empty_state.enabled).toBeNull();
    expect(out.empty_state.offscreen).toBe(false);
    expect(out.sensitive_only.enabled).toBe(true);
    expect(out.seven.enabled).toBe(true);
  });

  // #356: an unnamed drawing surface is sent with its role and bounds (Windows and macOS keep only a large one).
  it('an unnamed canvas comes back as a role-only node with its bounds', () => {
    expect(out.canvas).toMatchObject({ name: '', controlType: 'canvas', bounds: { x: 0, y: 100, width: 1000, height: 700 } });
  });

  // #359: the AT-SPI description is the tooltip; it is sent only when it says more than the name.
  it('the accessible description comes back as help, unless it repeats the name or is empty', () => {
    expect(out.help).toEqual(['Make text bold', null, null]);
  });

  it('all-zero SCREEN extents fall back to WINDOW extents and say so', () => {
    expect(out.rel.bounds).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(out.rel.coordType).toBe('window');
    expect(out.seven.coordType).toBeUndefined();
    // Never disable libatspi's cache: with Cache.NONE every property read is a
    // D-Bus round trip and `find` on a real GTK3 app ran past 30 s (VM, 2026-10).
    expect(out.cache_mask).toBeNull();
  });

  // ── L8 ──
  it('invoke click prefers the "click" action and returns bounds', () => {
    expect(out.click.success).toBe(true);
    expect(out.click.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(out.click_done).toEqual(['click']);
  });

  // Eval 2026-11-05: Chrome's form controls sat below the old 12-level cap — read_tree omitted them and said nothing.
  it('the tree reaches controls 30 levels deep, and a walk the depth cap cuts says so', () => {
    expect(out.deep_found).toBe(true);
    expect(out.deep_cut).toBe(false);
    expect(out.too_deep_cut).toBe(true);
  });

  // Review of 1.5.27: searches shared the tree's 800-node output cap, so a file manager with 1,000 files missed, silently.
  it('a search has its own, larger visit budget than the tree output cap', () => {
    expect(out.search_over_tree_cap).toBe(true);
    expect(out.wide_found).toBe(true);
    expect(out.wide_found_cut).toBe(false);
    expect(out.wide_find_small).toEqual(['Needle']);
  });

  it('a search stops after MAX_SEARCH_NODES nodes visited (a deep page must not cost thousands of calls), and says it was cut', () => {
    expect(out.wide_capped).toBe(true);
    expect(out.wide_capped_cut).toBe('element budget');
    expect(out.wide_invoke).toMatchObject({ success: false, partial: true, error: expect.stringMatching(/^search cut \(element budget\)/), reason: 'element budget' });
    expect(out.wide_find).toMatchObject({ elements: [], partial: true });
    expect(out.wide_focused).toMatchObject({ element: null, partial: true });
  });

  // Review of #331: find built a dict (about ten AT-SPI calls) for every node it walked, and nothing stopped a slow tree.
  it('find builds element dicts only for hits; a role-only find searches and reports a cut', () => {
    expect(out.find_names).toEqual(['Needle']);
    expect(out.find_dict_calls).toBe(1);
    expect(out.role_find).toMatchObject({ elements: [], partial: true, reason: 'element budget' });
  });

  it('every search ends as "time limit" when the tree is slow, instead of running into the caller timeout', () => {
    const [missed, cut] = out.slow_target;
    expect(missed).toBe(true);
    expect(cut).toBe('time limit');
    expect(out.slow_find).toMatchObject({ elements: [], partial: true, reason: 'time limit' });
    expect(out.slow_invoke).toMatchObject({ success: false, partial: true, reason: 'time limit', error: expect.stringMatching(/^search cut \(time limit\)/) });
    expect(out.slow_scroll).toMatchObject({ success: false, partial: true, reason: 'time limit' });
    expect(out.slow_focused).toMatchObject({ element: null, partial: true, reason: 'time limit' });
  });

  // Review of #331, round 2: the work after the walk had no cap, and normalized multi-word roles never matched.
  it('the hit list is capped, and the deadline holds while describing hits; both say partial', () => {
    expect(out.hit_cap.n).toBeLessThanOrEqual(out.hit_cap.max);
    expect(out.hit_cap).toMatchObject({ partial: true, reason: 'result limit' });
    expect(out.dict_deadline.n).toBeGreaterThan(0);
    expect(out.dict_deadline.n).toBeLessThan(30);
    expect(out.dict_deadline).toMatchObject({ partial: true, reason: 'time limit' });
  });

  it('a normalized multi-word role (ToolTip, InfoBar) matches its spaced AT-SPI role', () => {
    expect(out.role_squeeze).toEqual([true, true, false]);
    expect(out.tooltip_find).toEqual(['Hint']);
    expect(out.infobar_find).toEqual(['Warn']);
  });

  it('a search cut before an exact match refuses to act on a weaker one; an uncut search still takes it', () => {
    expect(out.weak_cut).toMatchObject({ success: false, partial: true, error: expect.stringMatching(/before an exact match.*use the element's exact name/) });
    expect(out.weak_uncut).toBe(true);
  });

  // #386: one rule for which element a name means, as on Windows and macOS.
  it('a substring match is listed, never pressed; a prefix one is pressed and named in the reply (#376)', () => {
    expect(out.rule_substring).toMatchObject({ success: false, reason: 'ambiguous', inexact: true, candidates: [{ name: "What's New", controlType: 'link' }] });
    expect(out.rule_prefix).toMatchObject({ success: true, target: { name: 'Request tasks', controlType: 'push button', match: 'prefix' } });
    // A value read is no press: it still reads the field whose label contains the name.
    expect(out.rule_value_substring).toMatchObject({ success: true, value: 'x' });
  });

  it('the page\'s modal dialog beats the page behind it; a control beats its label', () => {
    expect(out.rule_modal).toMatchObject({ success: true, target: { name: 'Request', match: 'exact' } });
    expect(out.rule_modal_pressed_in_dialog).toBe(true);
    expect(out.rule_label).toMatchObject({ success: true, target: { controlType: 'push button' } });
  });

  it('two equal matches: ambiguous, each with its container; within picks one (#382)', () => {
    expect(out.rule_two).toMatchObject({ success: false, reason: 'ambiguous', candidates: [{ name: 'Close', container: { name: 'Page', controlType: 'document web' } }, { name: 'Close' }] });
    expect(out.rule_two.inexact).toBeUndefined();
    // within names the page: the page's own Close is pressed, not the dialog's inside it.
    expect(out.rule_within).toMatchObject({ success: true });
    expect(out.rule_within_pressed).toEqual([['press'], []]);
  });

  it('a prefix counts only up to a word boundary: "Newsletter" for "New" is listed, not pressed', () => {
    expect(out.rule_word_prefix).toMatchObject({ success: false, reason: 'ambiguous', inexact: true });
  });

  it('the search stops at the first exact on-screen match for a read, and within a small allowance for a press', () => {
    expect(out.early_read).toEqual([true, 0]);
    const [found, visited, allowance] = out.early_press;
    expect(found).toBe(true);
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThanOrEqual(allowance);
  });

  it('the tree marks what a document holds as inDocument, not the app\'s own controls (#383)', () => {
    expect(out.in_document).toEqual(['win', 'New', 'Start', "What's New*"]);
  });

  // Review of #331: the scroll walk has no early exit, so a window over the budget is always cut; an EXACT match still scrolls.
  it('scroll-into-view after a budget cut proceeds with an exact match and refuses a substring-only one', () => {
    expect(out.scroll_after_cut.error ?? '').not.toMatch(/search cut/);
    expect(out.scroll_weak_cut).toMatchObject({ success: false, partial: true, error: expect.stringMatching(/before an exact match was seen; use the element's exact name/) });
    expect(out.scroll_uncut.error ?? '').not.toMatch(/search cut/);
  });

  it('a search the depth cap cut names the depth limit', () => {
    expect(out.deep_target).toEqual([true, 'depth limit']);
  });

  it('scroll-into-view says the search was cut instead of "not found"', () => {
    expect(out.wide_scroll).toMatchObject({ success: false, partial: true, error: expect.stringMatching(/^search cut/) });
  });

  it('invoke toggle reports the new state', () => {
    expect(out.toggle).toMatchObject({ success: true, toggleState: 'On' });
  });

  // Audit 2026-11-05: the tick was read from SELECTED (a ticked Chrome checkbox read selected:false, no `checked`), and
  // toggle / expand fell through to clicking whatever was named — `select` on a Save button pressed Save.
  it('a tickbox reports checked; an expander reports expanded', () => {
    expect(out.agree_after).toMatchObject({ checked: true });
    expect(out.seven).not.toHaveProperty('checked');
    expect(out.expand).toMatchObject({ success: true });
  });

  it('toggle and expand refuse a plain button and never press it', () => {
    expect(out.toggle_button).toMatchObject({ success: false, error: expect.stringMatching(/not a checkbox/) });
    expect(out.expand_button).toMatchObject({ success: false, error: expect.stringMatching(/cannot expand/) });
    expect(out.button_pressed_again).toBe(false);
  });

  it('invoke toggle waits for a state set that updates late, and says when it never changed', () => {
    expect(out.toggle).toMatchObject({ toggleChanged: true });
    expect(out.toggle_late).toMatchObject({ success: true, toggleState: 'On', toggleChanged: true });
    expect(out.toggle_stuck).toMatchObject({ success: true, toggleState: 'Off', toggleChanged: false });
  });

  it('invoke focus grabs focus via Component', () => {
    expect(out.focus.success).toBe(true);
    expect(out.focus_state).toBe(true);
  });

  it('invoke set-value uses EditableText; get-value reads Text', () => {
    expect(out.set_value.success).toBe(true);
    expect(out.set_value_text).toBe('Ada');
    expect(out.get_value).toMatchObject({ success: true, value: '42' });
  });

  it('get-value says whether the value was read: an empty entry is "" and readable, never its name', () => {
    expect(out.get_value).toMatchObject({ success: true, value: '42', readable: true });
    expect(out.get_value_blank).toMatchObject({ success: true, value: '', readable: true });
    // a password entry's Text is bullets: withheld, not readable, not "empty"
    expect(out.get_value_secret).toMatchObject({ success: true, value: '', readable: false, secure: true });
    // an element with no value: a miss, not its name
    expect(out.get_value_no_value).toMatchObject({ success: false, readable: false });
    expect(out.get_value_no_value.value).toBeUndefined();
  });

  it('a password entry never gives its value to a tree, find or text read (as UIA IsPassword / AXSecureTextField)', () => {
    expect(out.secret_node).toMatchObject({ name: 'Secret', controlType: 'password text', value: null });
    expect(out.secret_pin_node.value).toBeNull();          // nor through a Value interface
    expect(out.secret_find).toHaveLength(1);
    expect(out.secret_find[0].value).toBeNull();
    expect(out.secret_tree).toHaveLength(1);
    expect(out.secret_tree[0].value).toBeNull();
    expect(out.secret_read_text).toBeNull();
    expect(out.secret_full_text).toBe('');
    expect(out.secret_anywhere).toBe(false);
  });

  it('a spin button (a number box) reads and takes its number through Value', () => {
    expect(out.get_value_spin).toMatchObject({ success: true, value: '100.0', readable: true });
    expect(out.set_value_spin).toMatchObject({ success: true, method: 'Value' });
    expect(out.get_value_spin_after).toMatchObject({ success: true, value: '30.0', readable: true });
  });

  it('invoke select uses the parent Selection interface', () => {
    expect(out.select.success).toBe(true);
    expect(out.select_idx).toEqual([1]);
    expect(out.select.selected).toBe(true);   // read back after the select (#396)
  });

  it('invoke expand drives the expand action', () => {
    expect(out.expand.success).toBe(true);
  });

  it('invoke without an Action interface fails but still returns bounds', () => {
    expect(out.no_action.success).toBe(false);
    expect(out.no_action.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('invoke on a missing element fails with a clear error', () => {
    expect(out.missing.success).toBe(false);
    expect(String(out.missing.error)).toMatch(/not found/i);
  });

  // ── Blind-mode batch (Ubuntu 24.04 live blind test) ──
  it('B1 invoke picks the visible Save in the active dialog, not a hidden 0x0 duplicate', () => {
    expect(out.save).toMatchObject({ success: true, bounds: { x: 500, y: 600, width: 80, height: 30 } });
    expect(out.save_done).toEqual({ dialog: ['click'], toolbar: [], menu: [] });
  });

  it('B1 invoke on an element that is only hidden fails and does nothing', () => {
    expect(out.hidden_only.success).toBe(false);
    expect(out.hidden_only.notVisible).toBe(true);
    expect(String(out.hidden_only.error)).toMatch(/not visible/i);
    expect(out.hidden_only.bounds).toBeUndefined();
    expect(out.hidden_only_done).toEqual([]);
  });

  it('invoke / find look only in the ACTIVE window: an element of the inactive one is not found, not touched', () => {
    expect(out.other_window.success).toBe(false);
    expect(String(out.other_window.error)).toMatch(/not found/i);
    expect(out.other_window_done).toEqual([]);
  });

  it('the tree, the no-name find and invoke all cover the same windows: the active one and its open popups', () => {
    expect(out.scope_names).toEqual(['Save As', 'File', '']); // the GTK3 "window" popup is in, the closed menu and the main window are not
    expect(out.scope_tree).not.toContain('Print');
    expect(out.scope_names_none_active).toEqual(['notes.txt - Editor', 'File', 'Edit', '', 'Save As']);
  });

  it('a miss carries a machine-readable reason and the other-window count as fields, with no name or title in its sentence', () => {
    expect(out.miss_note).toMatchObject({ success: false, reason: 'not_found', otherWindows: 1, error: 'element not found' });
    // only showing normal windows are counted: not the open menu, the hidden menu or the GTK3 popup window
    expect(out.other_count).toBe(1);
  });

  it('a hostile element name never reaches the reply\'s sentences (it used to be interpolated, unquoted)', () => {
    expect(out.hostile_miss.reason).toBe('not_found');
    expect(JSON.stringify(out.hostile_miss)).not.toMatch(/screen is locked|timed out|Invoke failed/);
  });

  it('B2 text values come from the Text interface (PyGObject get_text shadowing)', () => {
    expect(out.text_view.value).toBe('hello world');
    expect(out.get_value).toMatchObject({ success: true, value: '42' });
    // A label's text equals its name — not repeated as a value.
    expect(out.label_value).toBeNull();
  });

  it('B4 focused is scoped to the app and its active window', () => {
    expect(out.focused_editor).toMatchObject({ name: 'Name', value: 'notes.txt', processId: 7777 });
    // calc has no focused widget; mousepad's stale FOCUSED must not leak in.
    expect(out.focused_calc).toBeNull();
  });

  it('B5 a window with no pid is scoped by its title, never by guessing another app', () => {
    expect(out.by_title).toEqual([4242]);
    expect(out.by_unknown_title).toEqual([]);
    // Same title as another app's window, which owns a pid: never that app.
    expect(out.by_colliding_title).toEqual([]);
    expect(out.invoke_colliding.success).toBe(false);
  });

  it('B7 tree: on-screen first (active dialog leading), hidden after, nameless rows dropped', () => {
    const names = out.tree.map((t: [string, string]) => `${t[1]}:${t[0]}`);
    expect(names).toEqual([
      'file chooser:Save As', 'text:Name', 'push button:Save',
      // hidden: the 0x0 application node and the dialog's hidden item; the inactive main window is not read at all
      'application:editor', 'menu item:Preview',
    ]);
  });

  it('B7 GTK4 SCREEN extents of 0,0 fall back to WINDOW extents', () => {
    expect(out.gtk4.bounds).toEqual({ x: 16, y: 349, width: 64, height: 44 });
    expect(out.gtk4.coordType).toBe('window');
  });

  // The value set_value writes (a password included) used to ride on argv, readable in /proc/<pid>/cmdline.
  it('--args-stdin: name / value / within / window title come from stdin and reach the command', () => {
    expect(out.args_stdin).toEqual({
      name: '--Password--', action: 'set-value', value: 'hunter2 é', within: 'Log in', window_title: 'Sign in',
    });
  });
});
