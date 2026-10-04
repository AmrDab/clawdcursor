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

  it('invoke toggle reports the new state', () => {
    expect(out.toggle).toMatchObject({ success: true, toggleState: 'On' });
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

  it('invoke select uses the parent Selection interface', () => {
    expect(out.select.success).toBe(true);
    expect(out.select_idx).toEqual([1]);
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
});
