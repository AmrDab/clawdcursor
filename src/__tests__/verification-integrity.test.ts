/**
 * P1 verification integrity (2026-06-12): the `file_changed_since_start` assertion (a wallpaper task 'verified' via the
 * on-screen clock while the wallpaper file went untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAssertions, inMcpSession } from '../core/verify/assertions';

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

  const deps = { adapter: {} as any };
  // The start file_changed_since_start measures from: the MCP session's (inMcpSession), or none outside one.
  const changedSince = (path: string, start?: number) => {
    const run = () => checkAssertions([{ type: 'file_changed_since_start', path }], deps);
    return start === undefined ? run() : inMcpSession(start, run);
  };

  it('passes when the file mtime is newer than task start', async () => {
    const r = await changedSince(fp, Date.now() - 60_000);
    expect(r.ok).toBe(true);
  });

  it('FAILS when the file was last modified BEFORE task start (the wallpaper case)', async () => {
    const old = new Date(Date.now() - 7 * 86_400_000);
    await fs.utimes(fp, old, old);
    const r = await changedSince(fp, Date.now());
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/did not change this file/);
  });

  it('fails for a missing file', async () => {
    const r = await changedSince(missing, Date.now());
    expect(r.ok).toBe(false);
  });

  it('fails (safely) outside an MCP session with no start wired', async () => {
    const r = await changedSince(fp);
    expect(r.ok).toBe(false);
    expect(r.outcomes[0].detail).toMatch(/no start time/);
  });

  it('inside an MCP session, measures from the session start', async () => {
    await fs.writeFile(fp, 'written now');
    const check = () => checkAssertions([{ type: 'file_changed_since_start', path: fp }], deps);
    expect((await inMcpSession(Date.now() - 60_000, check)).ok).toBe(true);
    const later = await inMcpSession(Date.now() + 60_000, check);
    expect(later.ok).toBe(false);
    expect(later.outcomes[0].detail).toMatch(/NOT modified since the session started/);
  });
});

// ── discriminating-evidence logic ──
