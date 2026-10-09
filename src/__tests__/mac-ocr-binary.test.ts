/**
 * macOS OCR runs from a compiled, cached binary instead of re-interpreting the
 * Swift script on every read. The cache logic is tested everywhere with a fake
 * `swiftc`; on a real Mac one test compiles the real script and runs Vision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const swiftc = vi.hoisted(() => ({ calls: [] as string[][], fail: false }));
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return {
    ...actual,
    // promisify(execFile) → resolves with the first value passed to the callback
    execFile: (cmd: string, args: string[], opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
      if (cmd !== 'swiftc') return actual.execFile(cmd, args, opts as never, cb as never);
      swiftc.calls.push(args);
      if (swiftc.fail) return cb(new Error('swiftc: command not found'));
      fs.writeFileSync(args[args.indexOf('-o') + 1], '#!/bin/sh\necho {}\n');   // the "compiled" output
      cb(null, '');
    },
  };
});

import {
  cachedMacOcrBinary, compileMacOcrBinary, macOcrBinaryPath, resetMacOcrBinaryState,
} from '../platform/mac-ocr-binary';

let dir: string;
let script: string;
beforeEach(() => {
  swiftc.calls.length = 0; swiftc.fail = false;
  resetMacOcrBinaryState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-macocr-'));
  script = path.join(dir, 'ocr-recognize.swift');
  fs.writeFileSync(script, '// v1\nprint("x")\n');
});

describe('mac OCR binary cache', () => {
  it('is content-addressed: same script → same path, edited script → new path', () => {
    const a = macOcrBinaryPath(script, dir);
    expect(macOcrBinaryPath(script, dir)).toBe(a);
    fs.writeFileSync(script, '// v2\nprint("y")\n');
    expect(macOcrBinaryPath(script, dir)).not.toBe(a);
  });

  it('nothing cached → null (the interpreted script is used meanwhile)', () => {
    expect(cachedMacOcrBinary(script, dir)).toBeNull();
  });

  it('compiles once, via a private temp file renamed into place', async () => {
    const bin = await compileMacOcrBinary(script, dir);
    expect(bin).toBe(macOcrBinaryPath(script, dir));
    expect(fs.existsSync(bin!)).toBe(true);
    expect(swiftc.calls).toHaveLength(1);
    const tmp = swiftc.calls[0][swiftc.calls[0].indexOf('-o') + 1];
    expect(tmp).toMatch(/\.tmp$/);
    expect(fs.existsSync(tmp)).toBe(false);                   // renamed, not left behind
    expect(cachedMacOcrBinary(script, dir)).toBe(bin);
    await compileMacOcrBinary(script, dir);                    // cached: no second compile
    expect(swiftc.calls).toHaveLength(1);
  });

  it('concurrent callers share one compile', async () => {
    const [a, b] = await Promise.all([compileMacOcrBinary(script, dir), compileMacOcrBinary(script, dir)]);
    expect(a).toBe(b);
    expect(swiftc.calls).toHaveLength(1);
  });

  it('a failed compile returns null, leaves no temp file, and is not retried', async () => {
    swiftc.fail = true;
    expect(await compileMacOcrBinary(script, dir)).toBeNull();
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    swiftc.fail = false;
    expect(await compileMacOcrBinary(script, dir)).toBeNull();
    expect(swiftc.calls).toHaveLength(1);
  });
});

describe.runIf(process.platform === 'darwin')('real Vision binary (macOS only)', () => {
  it('compiles the shipped script and returns the OCR JSON shape', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const real = path.resolve(__dirname, '../../scripts/mac/ocr-recognize.swift');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-macocr-real-'));
    const bin = await compileMacOcrBinary(real, out);
    expect(bin, 'swiftc must be able to build scripts/mac/ocr-recognize.swift').toBeTruthy();
    // A plain white PNG: no text, but a valid image — the binary must answer with the JSON shape.
    const sharp = (await import('sharp')).default;
    const png = path.join(out, 'blank.png');
    await sharp({ create: { width: 200, height: 80, channels: 3, background: '#ffffff' } }).png().toFile(png);
    const data = JSON.parse(execFileSync(bin!, [png], { encoding: 'utf8', timeout: 60_000 }).trim());
    expect(data.error).toBeUndefined();
    expect(Array.isArray(data.elements)).toBe(true);
    expect(typeof data.fullText).toBe('string');
  }, 300_000);
});
