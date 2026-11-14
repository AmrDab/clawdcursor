/** mac-ax's real process runner, run with node as the child (any OS). */
import { describe, it, expect } from 'vitest';

describe('defaultExec — the real process runner', () => {
  it('returns output far larger than node\'s 1 MB default buffer (a big window\'s tree is megabytes of JSON)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const { stdout } = await defaultExec(process.execPath, ['-e', 'process.stdout.write("x".repeat(3_000_000))'], { timeoutMs: 20_000 });
    expect(stdout.length).toBe(3_000_000);
  });

  it('kills a stuck process at the timeout and rejects the way execFile does (killed)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const err = await defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 }).then(() => null, e => e);
    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });

  // Review finding 9: the helper reads what the caller typed from stdin.
  it('writes `input` to the process\'s stdin and closes it (a reader that waits for EOF is not left hanging)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const { stdout } = await defaultExec(process.execPath, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d))'],
      { timeoutMs: 10_000, input: '{"value":"héllo — wörld 🙂"}' });
    expect(stdout).toBe('{"value":"héllo — wörld 🙂"}');
  });

  it('a process that exits without reading its stdin is not an error of ours (EPIPE is swallowed)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const { stdout } = await defaultExec(process.execPath, ['-e', 'process.stdout.write("done")'], { timeoutMs: 10_000, input: 'x'.repeat(8_000_000) });
    expect(stdout).toBe('done');
  });

  it('without `input` nothing is written', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const { stdout } = await defaultExec(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 });
    expect(stdout).toBe('ok');
  });
});
