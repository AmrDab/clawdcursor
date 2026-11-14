/**
 * P1 verification integrity (2026-06-12). Closes the false-success holes in the
 * autonomous `done` gate: a mutating task could be marked complete with no
 * machine-checkable proof, or with proof that was ALREADY true before it acted
 * (a wallpaper task 'verified' via the on-screen clock while the wallpaper file
 * went untouched). Adds the `file_changed_since_start` assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAssertions,
  inMcpSession,
  wasTrueAtBaseline,
  hasDiscriminatingEvidence,
  type Assertion,
  type TaskBaseline,
} from '../core/verify/assertions';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

// ── file_changed_since_start (the proof a file was actually written) ──
describe('file_changed_since_start assertion', () => {
  // Use a private, randomly-named temp DIR (mkdtemp → 0700, unguessable suffix)
  // instead of a predictable `tmpdir/clawd-p1-<pid>.txt`. A fixed name in the
  // world-writable temp dir is a symlink/race window (CWE-377, CodeQL
  // js/insecure-temporary-file). Everything the suite touches lives inside it.
  let dir: string;
  let fp: string;
  let missing: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'clawd-p1-'));
    fp = join(dir, 'probe.txt');
    missing = join(dir, 'nope.xyz');
    await fs.writeFile(fp, 'hi');
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const deps = (taskStartedAt?: number) => ({ adapter: {} as any, taskStartedAt });

  it('passes when the file mtime is newer than task start', async () => {
    const r = await checkAssertions([{ type: 'file_changed_since_start', path: fp }], deps(Date.now() - 60_000));
    expect(r.ok).toBe(true);
  });

  it('FAILS when the file was last modified BEFORE task start (the wallpaper case)', async () => {
    const old = new Date(Date.now() - 7 * 86_400_000);
    await fs.utimes(fp, old, old);
    const r = await checkAssertions([{ type: 'file_changed_since_start', path: fp }], deps(Date.now()));
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/did not change this file/);
  });

  it('fails for a missing file', async () => {
    const r = await checkAssertions([{ type: 'file_changed_since_start', path: missing }], deps(Date.now()));
    expect(r.ok).toBe(false);
  });

  it('fails (safely) outside an MCP session with no start wired', async () => {
    const r = await checkAssertions([{ type: 'file_changed_since_start', path: fp }], deps(undefined));
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/no start time/);
  });

  it('inside an MCP session, measures from the session start', async () => {
    await fs.writeFile(fp, 'written now');
    const check = () => checkAssertions([{ type: 'file_changed_since_start', path: fp }], deps(undefined));
    expect((await inMcpSession(Date.now() - 60_000, check)).ok).toBe(true);
    const later = await inMcpSession(Date.now() + 60_000, check);
    expect(later.ok).toBe(false);
    expect(later.outcomes[0].detail).toMatch(/NOT modified since the session started/);
  });
});

// ── discriminating-evidence logic ──
describe('wasTrueAtBaseline / hasDiscriminatingEvidence', () => {
  const baseline: TaskBaseline = {
    startedAt: Date.now(),
    ocrText: 'the time is 8:41 pm and battery 80%',
    windowTitles: ['claude', 'untitled - notepad'],
    processNames: ['claude', 'notepad'],
    clipboard: 'old clipboard',
  };

  it('flags an ambient clock assertion as already-true (non-discriminating)', () => {
    expect(wasTrueAtBaseline({ type: 'ocr_contains', value: '8:41 PM' }, baseline)).toBe(true);
  });
  it('flags an already-open window / running app as already-true', () => {
    expect(wasTrueAtBaseline({ type: 'window_title_contains', value: 'Notepad' }, baseline)).toBe(true);
    expect(wasTrueAtBaseline({ type: 'app_running', name: 'notepad' }, baseline)).toBe(true);
  });
  it('treats new state as discriminating (false)', () => {
    expect(wasTrueAtBaseline({ type: 'window_title_contains', value: 'Calculator' }, baseline)).toBe(false);
    expect(wasTrueAtBaseline({ type: 'clipboard_contains', value: 'fresh text' }, baseline)).toBe(false);
    expect(wasTrueAtBaseline({ type: 'file_changed_since_start', path: '/x' }, baseline)).toBe(false);
  });
  it('trusts element/file checks it cannot judge from baseline (null)', () => {
    expect(wasTrueAtBaseline({ type: 'element_value_contains', name: 'To', value: 'a@b.com' }, baseline)).toBeNull();
    expect(wasTrueAtBaseline({ type: 'file_contains', path: '/x', value: 'y' }, baseline)).toBeNull();
  });

  it('hasDiscriminatingEvidence: false when every passing proof was already true', () => {
    const assertions: Assertion[] = [{ type: 'ocr_contains', value: '8:41 PM' }];
    const report = { ok: true, passed: 1, failed: 0, outcomes: [{ index: 0, summary: '', ok: true, detail: '' }] };
    expect(hasDiscriminatingEvidence(assertions, report, baseline)).toBe(false);
  });
  it('hasDiscriminatingEvidence: true when at least one passing proof is new', () => {
    const assertions: Assertion[] = [
      { type: 'app_running', name: 'notepad' },                 // already true
      { type: 'element_value_contains', name: 'Body', value: 'hello' }, // null → trusted/discriminating
    ];
    const report = { ok: true, passed: 2, failed: 0, outcomes: [
      { index: 0, summary: '', ok: true, detail: '' },
      { index: 1, summary: '', ok: true, detail: '' },
    ] };
    expect(hasDiscriminatingEvidence(assertions, report, baseline)).toBe(true);
  });
});

// ── the done gate, end to end ──
describe('done gate — mutating tasks must prove a real change', () => {
  const done = buildUnifiedTools().find(t => t.name === 'done')!;

  // Minimal adapter: clipboard + window list drive the assertions used here.
  function adapter(opts: { clipboard?: string; windows?: Array<{ title: string; processName: string }> }) {
    return {
      readClipboard: async () => opts.clipboard ?? '',
      listWindows: async () => (opts.windows ?? []).map(w => ({ ...w, processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false, handle: 1 })),
      findElements: async () => [],
      invokeElement: async () => ({ success: false }),
    } as any;
  }
  function ctx(over: Partial<AgentToolContext>): AgentToolContext {
    return {
      platform: adapter({}),
      task: 't', screen: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 },
      screenshotsCaptured: { n: 0 },
      taskStartedAt: Date.now(),
      taskBaseline: { startedAt: Date.now(), ocrText: '', windowTitles: ['claude'], processNames: ['claude'], clipboard: '' },
      ...over,
    } as AgentToolContext;
  }

  it('NEGATIVE: mutating task whose only proof was already true at baseline is rejected', async () => {
    // clipboard already held "abc" at baseline AND now → passes the check but is non-discriminating.
    const c = ctx({
      mutatedScreen: true,
      platform: adapter({ clipboard: 'abc' }),
      taskBaseline: { startedAt: Date.now(), ocrText: '', windowTitles: ['claude'], processNames: ['claude'], clipboard: 'abc' },
    });
    const r = await done.execute({ evidence: 'Done, clipboard shows abc.', assertions: [{ type: 'clipboard_contains', value: 'abc' }] }, c);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/ALREADY true before you acted/);
  });

  it('POSITIVE: mutating task with discriminating proof passes (clipboard changed)', async () => {
    const c = ctx({
      mutatedScreen: true,
      platform: adapter({ clipboard: 'fresh-typed-text' }),
      taskBaseline: { startedAt: Date.now(), ocrText: '', windowTitles: ['claude'], processNames: ['claude'], clipboard: '' },
    });
    const r = await done.execute({ evidence: 'Typed fresh-typed-text into the field.', assertions: [{ type: 'clipboard_contains', value: 'fresh-typed-text' }] }, c);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/VERIFIED/);
  });

  it('POSITIVE: mutating task proven by a newly-opened window passes', async () => {
    const c = ctx({
      mutatedScreen: true,
      platform: adapter({ windows: [{ title: 'Calculator', processName: 'ApplicationFrameHost' }] }),
      taskBaseline: { startedAt: Date.now(), ocrText: '', windowTitles: ['claude'], processNames: ['claude'], clipboard: '' },
    });
    const r = await done.execute({ evidence: 'Calculator is now open.', assertions: [{ type: 'window_title_contains', value: 'Calculator' }] }, c);
    expect(r.success).toBe(true);
  });

  it('POSITIVE: a read-only (non-mutating) task may still finish on prose alone', async () => {
    const r = await done.execute({ evidence: 'The status bar reads "Ready" and 42 rows are listed.' }, ctx({ mutatedScreen: false }));
    expect(r.success).toBe(true);
  });
});
