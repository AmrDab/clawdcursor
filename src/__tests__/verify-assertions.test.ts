/**
 * Assertion engine — harness-executed verification (no LLM judgment).
 *
 * Design: the model PROPOSES machine-checkable proofs; the harness EXECUTES
 * them against ground truth (UIA values, window list, clipboard, filesystem,
 * OCR text). This moves task verification from "model reads a screenshot and
 * judges" (which hallucinated a recipient in the 2026-06-06 live Outlook run)
 * to deterministic code.
 *
 * One engine, two mounts: the `verify` tool (internal loop + MCP projection)
 * and the `done(assertions)` completion gate.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformAdapter } from '../platform/types';
import {
  parseAssertions,
  checkAssertions,
  renderReport,
  MAX_ASSERTIONS,
  type Assertion,
} from '../core/verify/assertions';

// ── Minimal adapter stub — only the read primitives the engine uses ──────────

function makeAdapter(overrides: Partial<Record<string, unknown>> = {}): PlatformAdapter {
  return {
    listWindows: vi.fn(async () => [
      { processId: 100, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false },
      { processId: 200, processName: 'olk', title: 'Inbox - Test User - Outlook', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false },
    ]),
    findElements: vi.fn(async () => [{ name: 'To', controlType: 'Edit', bounds: { x: 1, y: 1, width: 10, height: 10 } }]),
    invokeElement: vi.fn(async () => ({ success: true, data: { value: 'user@example.com' } })),
    readClipboard: vi.fn(async () => 'hello clipboard'),
    ...overrides,
  } as unknown as PlatformAdapter;
}

const run = (assertions: Assertion[], adapter = makeAdapter(), ocrText?: () => Promise<string>) =>
  checkAssertions(assertions, { adapter, ocrText });

// ── parseAssertions ──────────────────────────────────────────────────────────

describe('parseAssertions', () => {
  it('accepts a valid mixed list', () => {
    const parsed = parseAssertions([
      { type: 'window_title_contains', value: 'Notepad' },
      { type: 'file_exists', path: 'C:/tmp/x.txt' },
    ]);
    expect('assertions' in parsed && parsed.assertions.length).toBe(2);
  });

  it('rejects a non-array', () => {
    const parsed = parseAssertions('window is open');
    expect('error' in parsed).toBe(true);
  });

  it('rejects an unknown type with the list of valid types', () => {
    const parsed = parseAssertions([{ type: 'pixels_look_right', value: 'x' }]);
    expect('error' in parsed && parsed.error).toContain('pixels_look_right');
  });

  it('rejects a missing required field', () => {
    const parsed = parseAssertions([{ type: 'element_value_contains', name: 'To' }]); // value missing
    expect('error' in parsed).toBe(true);
  });

  it('caps the list at MAX_ASSERTIONS', () => {
    const many = Array.from({ length: MAX_ASSERTIONS + 1 }, () => ({ type: 'clipboard_contains', value: 'x' }));
    const parsed = parseAssertions(many);
    expect('error' in parsed).toBe(true);
  });
});

// ── checkAssertions — one pass + one fail per type ───────────────────────────

describe('checkAssertions', () => {
  it('window_title_contains — matches any open window, case-insensitive', async () => {
    const r = await run([{ type: 'window_title_contains', value: 'outlook' }]);
    expect(r.ok).toBe(true);
    const f = await run([{ type: 'window_title_contains', value: 'Photoshop' }]);
    expect(f.ok).toBe(false);
    expect(f.outcomes[0].detail).toBeTruthy(); // says what WAS open
  });

  it('app_running — matches process name', async () => {
    expect((await run([{ type: 'app_running', name: 'olk' }])).ok).toBe(true);
    expect((await run([{ type: 'app_running', name: 'photoshop' }])).ok).toBe(false);
  });

  it('element_exists — via findElements', async () => {
    expect((await run([{ type: 'element_exists', name: 'To' }])).ok).toBe(true);
    const adapter = makeAdapter({ findElements: vi.fn(async () => []) });
    expect((await run([{ type: 'element_exists', name: 'To' }], adapter)).ok).toBe(false);
  });

  it('element_value_contains — via UIA get-value', async () => {
    const ok = await run([{ type: 'element_value_contains', name: 'To', value: 'user@example.com' }]);
    expect(ok.ok).toBe(true);
    const fail = await run([{ type: 'element_value_contains', name: 'To', value: 'someone@else.com' }]);
    expect(fail.ok).toBe(false);
    expect(fail.outcomes[0].detail).toContain('user@example.com'); // shows the ACTUAL value
  });

  it('clipboard_contains', async () => {
    expect((await run([{ type: 'clipboard_contains', value: 'hello' }])).ok).toBe(true);
    expect((await run([{ type: 'clipboard_contains', value: 'goodbye' }])).ok).toBe(false);
  });

  it('file_exists / file_contains — real filesystem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawd-verify-'));
    const file = join(dir, 'out.txt');
    writeFileSync(file, 'The Quick Brown Fox');
    try {
      expect((await run([{ type: 'file_exists', path: file }])).ok).toBe(true);
      expect((await run([{ type: 'file_exists', path: join(dir, 'missing.txt') }])).ok).toBe(false);
      expect((await run([{ type: 'file_contains', path: file, value: 'quick brown' }])).ok).toBe(true);
      expect((await run([{ type: 'file_contains', path: file, value: 'lazy dog' }])).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ocr_contains — uses the injected OCR reader; fails cleanly when not wired', async () => {
    const ok = await run([{ type: 'ocr_contains', value: 'message sent' }], makeAdapter(), async () => 'Status: Message sent ✓');
    expect(ok.ok).toBe(true);
    const noOcr = await run([{ type: 'ocr_contains', value: 'message sent' }]);
    expect(noOcr.ok).toBe(false);
    expect(noOcr.outcomes[0].detail.toLowerCase()).toContain('ocr');
  });

  it('an adapter throw fails that assertion with the error — never throws out', async () => {
    const adapter = makeAdapter({ listWindows: vi.fn(async () => { throw new Error('UIA dead'); }) });
    const r = await run([{ type: 'window_title_contains', value: 'x' }], adapter);
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toContain('UIA dead');
  });

  it('mixed list reports per-assertion outcomes and renders ✓/✗ lines', async () => {
    const r = await run([
      { type: 'window_title_contains', value: 'Notepad' },
      { type: 'clipboard_contains', value: 'nope' },
    ]);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.ok).toBe(false);
    const text = renderReport(r);
    expect(text).toContain('✓');
    expect(text).toContain('✗');
  });
});
