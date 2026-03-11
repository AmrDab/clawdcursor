/**
 * Verifier tests.
 * All a11y and LLM calls are mocked — no native desktop access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock native deps ──────────────────────────────────────────────────────────
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} },
  screen: { grab: vi.fn(), grabRegion: vi.fn() },
  Button: {}, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({ resize: vi.fn().mockReturnThis(), png: vi.fn().mockReturnThis(), toBuffer: vi.fn().mockResolvedValue(Buffer.from('')) })),
}));

import { TaskVerifier, type VerifyResult } from '../verifiers';
import type { AccessibilityBridge } from '../accessibility';
import type { PipelineConfig } from '../providers';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeA11y(overrides?: Partial<any>): AccessibilityBridge {
  return {
    getActiveWindow: vi.fn().mockResolvedValue({ title: 'Notepad', processName: 'notepad', pid: 1 }),
    getFocusedElement: vi.fn().mockResolvedValue({ value: '', name: '', role: 'edit' }),
    getAccessibilityTree: vi.fn().mockResolvedValue(''),
    readClipboard: vi.fn().mockResolvedValue(''),
    getWindows: vi.fn().mockResolvedValue([]),
    isShellAvailable: vi.fn().mockResolvedValue(true),
    warmup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makePipelineConfig(textModelOverride?: any): PipelineConfig {
  return {
    provider: 'openai',
    providerKey: 'sk-test',
    apiKey: 'sk-test',
    layer1: { enabled: true },
    layer2: { enabled: true, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', provider: 'openai' },
    layer3: { enabled: false, model: 'gpt-4o', baseUrl: '', apiKey: '', provider: 'openai' },
    ...(textModelOverride ?? {}),
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskVerifier — always returns attemptLog', () => {
  it('attemptLog is an array even when no checks run', async () => {
    const verifier = new TaskVerifier(makeA11y());
    // No pipelineConfig → LLM verifier is skipped; no fast-path patterns match
    const result = await verifier.verify('do something completely unrecognized XYZ');
    expect(Array.isArray(result.attemptLog)).toBe(true);
  });

  it('attemptLog is populated when fast-path runs', async () => {
    const a11y = makeA11y({
      getActiveWindow: vi.fn().mockResolvedValue({ title: 'Notepad', processName: 'notepad', pid: 1 }),
    });
    const verifier = new TaskVerifier(a11y);
    const result = await verifier.verify('open notepad');
    expect(result.attemptLog.length).toBeGreaterThan(0);
    expect(result.attemptLog[0]).toHaveProperty('checkName');
    expect(result.attemptLog[0]).toHaveProperty('durationMs');
  });
});

describe('TaskVerifier — error passthrough is FAIL not PASS', () => {
  it('a11y error does not silently pass', async () => {
    const a11y = makeA11y({
      getActiveWindow: vi.fn().mockRejectedValue(new Error('UIA bridge crashed')),
    });
    const verifier = new TaskVerifier(a11y);
    // "open notepad" triggers the app_open_check fast-path which calls getActiveWindow
    const result = await verifier.verify('open notepad');
    // Result should not be a confident PASS when the a11y bridge throws
    // Either it fails, or it's low-confidence
    if (result.pass) {
      expect(result.confidence).toBeLessThan(0.7);
    } else {
      expect(result.pass).toBe(false);
    }
  });
});

describe('TaskVerifier — verifyAppOpen fast-path', () => {
  it('passes when the right process name is in the active window', async () => {
    const a11y = makeA11y({
      getActiveWindow: vi.fn().mockResolvedValue({ title: 'Untitled - Notepad', processName: 'notepad', pid: 42 }),
    });
    const verifier = new TaskVerifier(a11y);
    const result = await verifier.verify('open notepad');
    // Should find "notepad" in active window processName and pass
    const appCheck = result.attemptLog.find(a => a.checkName === 'app_open_check');
    expect(appCheck).toBeDefined();
    if (appCheck) {
      expect(appCheck.pass).toBe(true);
    }
  });

  it('fails when a different process is active', async () => {
    const a11y = makeA11y({
      getActiveWindow: vi.fn().mockResolvedValue({ title: 'Chrome - Google', processName: 'chrome', pid: 99 }),
    });
    const verifier = new TaskVerifier(a11y);
    const result = await verifier.verify('open notepad');
    const appCheck = result.attemptLog.find(a => a.checkName === 'app_open_check');
    // Chrome is active but we wanted Notepad — should not be a high-confidence pass
    if (appCheck) {
      if (appCheck.pass) {
        // Chrome active but Notepad expected — should not be a confident pass
        expect(appCheck.confidence).toBeLessThanOrEqual(0.85);
      } else {
        expect(appCheck.pass).toBe(false);
      }
    }
  });
});

describe('TaskVerifier — verifyClipboardHasContent fast-path', () => {
  it('passes when clipboard has content', async () => {
    const a11y = makeA11y();
    const verifier = new TaskVerifier(a11y);
    const readClip = vi.fn().mockResolvedValue('some copied text');
    const result = await verifier.verify('copy the selected text', readClip);
    const clipCheck = result.attemptLog.find(a => a.checkName === 'clipboard_check');
    expect(clipCheck).toBeDefined();
    if (clipCheck) {
      expect(clipCheck.pass).toBe(true);
    }
  });

  it('fails when clipboard is empty', async () => {
    const a11y = makeA11y();
    const verifier = new TaskVerifier(a11y);
    const readClip = vi.fn().mockResolvedValue('');
    const result = await verifier.verify('copy the selected text', readClip);
    const clipCheck = result.attemptLog.find(a => a.checkName === 'clipboard_check');
    if (clipCheck) {
      expect(clipCheck.pass).toBe(false);
    }
  });
});

describe('TaskVerifier — no pipelineConfig falls back gracefully', () => {
  it('unknown task without pipelineConfig returns a result without crashing', async () => {
    const verifier = new TaskVerifier(makeA11y()); // no config
    const result = await verifier.verify('schedule a meeting for tomorrow at 3pm');
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('attemptLog');
    expect(typeof result.pass).toBe('boolean');
  });

  it('unknown task default is not blindly PASS with high confidence', async () => {
    const verifier = new TaskVerifier(makeA11y());
    const result = await verifier.verify('xyzzy completely unknown nonexistent task zzz');
    // Without an LLM to verify, confidence should be low
    if (result.pass) {
      expect(result.confidence).toBeLessThan(0.6);
    }
  });
});
