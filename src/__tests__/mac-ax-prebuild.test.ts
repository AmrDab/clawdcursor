/**
 * #240: `grant`, `doctor` and the install build the accessibility helper ahead of the first call. That build can never fail
 * its caller: whatever goes wrong, prebuildMacAxHelper resolves and the lazy build on first use stays the fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bin = vi.hoisted(() => ({ cached: null as string | null, compile: vi.fn(), tools: true }));
vi.mock('../platform/mac-swift-binary', () => ({
  macAxBinary: { cached: () => bin.cached, compile: bin.compile },
}));
vi.mock('child_process', () => ({
  execFile: (cmd: string, _a: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) =>
    cb(cmd === 'xcode-select' && !bin.tools ? new Error('no tools') : null, { stdout: '/Library/Developer/CommandLineTools', stderr: '' }),
}));

// The Command Line Tools probe is cached per module load: each test loads the module afresh.
const prebuildMacAxHelper = async () => (await import('../platform/mac-ax')).prebuildMacAxHelper();

beforeEach(() => { vi.resetModules(); bin.cached = null; bin.tools = true; bin.compile.mockReset(); process.env.CLAWD_NO_MAC_AX = '0'; });

describe('prebuildMacAxHelper', () => {
  it('already built: ready, no compile', async () => {
    bin.cached = '/bin/ax-helper-x';
    expect(await prebuildMacAxHelper()).toBe('ready');
    expect(bin.compile).not.toHaveBeenCalled();
  });
  it('compiles when it is not built', async () => {
    bin.compile.mockResolvedValue('/bin/ax-helper-x');
    expect(await prebuildMacAxHelper()).toBe('built');
  });
  it('a failed compile resolves, it does not throw', async () => {
    bin.compile.mockRejectedValue(new Error('swiftc exploded'));
    expect(await prebuildMacAxHelper()).toBe('unavailable');
    bin.compile.mockResolvedValue(null);
    expect(await prebuildMacAxHelper()).toBe('unavailable');
  });
  it('no Command Line Tools: nothing is compiled (swiftc would pop an install dialog)', async () => {
    bin.tools = false;
    expect(await prebuildMacAxHelper()).toBe('unavailable');
    expect(bin.compile).not.toHaveBeenCalled();
  });
  it('CLAWD_NO_MAC_AX=1 builds nothing', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    expect(await prebuildMacAxHelper()).toBe('unavailable');
    expect(bin.compile).not.toHaveBeenCalled();
  });
});
