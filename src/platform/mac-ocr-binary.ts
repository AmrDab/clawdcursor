/**
 * macOS Swift helpers without recompiling on every run.
 *
 * `swift ocr-recognize.swift <image>` interprets the script each time: seconds
 * of compile before Vision even starts. Compile it once into a cached binary
 * (~/.clawdcursor/bin, keyed by the script's content and the CPU arch) and run
 * that instead. The first read, while the compile runs in the background, still
 * uses the interpreted script; if `swiftc` is missing or fails the interpreted
 * script stays the engine and the compile is not retried this session.
 *
 * The on-screen overlay (scripts/mac/overlay.swift) is cached the same way.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../paths';

const execFileAsync = promisify(execFile);
const COMPILE_TIMEOUT_MS = 180_000;
const DEFAULT_BIN_DIR = path.join(DATA_DIR, 'bin');

/** One compiled Swift helper: content-addressed path, cache lookup, one-shot background compile. */
function swiftBinary(prefix: string) {
  let compiling: Promise<string | null> | null = null;
  let compileFailed = false;

  /** Where the compiled binary for this script lives (content-addressed). */
  const binPath = (scriptPath: string, binDir = DEFAULT_BIN_DIR): string => {
    const key = crypto.createHash('sha1').update(fs.readFileSync(scriptPath)).update(os.arch()).digest('hex').slice(0, 12);
    return path.join(binDir, `${prefix}-${key}`);
  };

  /** The cached binary if it already exists and is executable, else null. Never compiles. */
  const cached = (scriptPath: string, binDir?: string): string | null => {
    try {
      const bin = binPath(scriptPath, binDir);
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  };

  /**
   * Start compiling in the background (once). Resolves to the binary path, or
   * null when it cannot be built. Safe to call on every use.
   */
  const compile = (scriptPath: string, binDir = DEFAULT_BIN_DIR): Promise<string | null> => {
    if (compileFailed) return Promise.resolve(null);
    const existing = cached(scriptPath, binDir);
    if (existing) return Promise.resolve(existing);
    if (compiling) return compiling;

    compiling = (async () => {
      // Build to a private temp name, then rename into place, so a reader never
      // executes a half-written binary and two processes cannot corrupt each other.
      const out = binPath(scriptPath, binDir);
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
        await execFileAsync('swiftc', ['-O', scriptPath, '-o', tmp], { timeout: COMPILE_TIMEOUT_MS });
        fs.chmodSync(tmp, 0o755);
        fs.renameSync(tmp, out);
        return out;
      } catch {
        compileFailed = true;
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        return null;
      } finally {
        compiling = null;
      }
    })();
    return compiling;
  };

  /** Test hook: forget this session's compile state. */
  const reset = (): void => {
    compiling = null;
    compileFailed = false;
  };

  return { binPath, cached, compile, reset };
}

const ocrBinary = swiftBinary('ocr-recognize');
export const macOcrBinaryPath = ocrBinary.binPath;
export const cachedMacOcrBinary = ocrBinary.cached;
export const compileMacOcrBinary = ocrBinary.compile;
export const resetMacOcrBinaryState = ocrBinary.reset;

/** The on-screen overlay (glow + pill), scripts/mac/overlay.swift. */
export const macOverlayBinary = swiftBinary('clawd-overlay');
