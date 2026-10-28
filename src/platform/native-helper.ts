/**
 * ClawdCursor Native Helper Integration (macOS only)
 * Communicates with the Swift helper via JSON-RPC over stdio
 * 
 * On non-macOS platforms, all methods are no-ops or return appropriate defaults.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { getPackageRoot } from '../paths';

const IS_MACOS = process.platform === 'darwin';
const HOST_PORT = parseInt(process.env.CLAWDCURSOR_HOST_PORT || '3848', 10);
const HOST_BASE_URL = `http://127.0.0.1:${HOST_PORT}`;


interface JsonRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  processPath?: string;
  bundleId?: string;
}

interface UIElement {
  role?: string;
  title?: string;
  value?: string;
  description?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  enabled: boolean;
  focused: boolean;
  children?: UIElement[];
}

interface WindowInfo {
  windowId: number;
  ownerPid: number;
  ownerName: string;
  windowName: string;
  bounds: { X: number; Y: number; Width: number; Height: number };
}

interface CapturedScreen {
  success: boolean;
  width: number;
  height: number;
  format: 'png';
  imageBase64: string;
}

export class NativeHelper {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readline: readline.Interface | null = null;
  private useHostIpc = IS_MACOS;

  /**
   * Check if native helper is available (macOS only)
   */
  isAvailable(): boolean {
    if (!IS_MACOS) return false;
    try {
      this.getHelperPath();
      return true;
    } catch {
      return false;
    }
  }

  private getHelperPath(binary = 'clawdcursor-helper'): string {
    if (!IS_MACOS) {
      throw new Error('Native helper is only available on macOS');
    }
    // Look for the helper in various locations
    const root = getPackageRoot();
    const locations = [
      // Development: native/ClawdCursor.app
      path.join(root, 'native', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
      // Installed via npm: node_modules/.clawdcursor/ClawdCursor.app
      path.join(root, 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
      // Global install
      path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        return loc;
      }
    }

    throw new Error(
      `ClawdCursor native helper not found. ${nativeBuildHint()}\n` +
      'Searched locations:\n' + locations.map(l => `  - ${l}`).join('\n')
    );
  }

  async start(): Promise<void> {
    if (!IS_MACOS) {
      throw new Error('Native helper is only available on macOS');
    }
    if (this.useHostIpc) {
      await ensureHostAppRunning();
      return;
    }
    if (this.process) return;

    const helperPath = this.getHelperPath();
    
    this.process = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.readline = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(`${response.error.message} (code ${response.error.code})`));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (could be debug output)
      }
    });

    this.process.stderr?.on('data', (data) => {
      const msg = data.toString();
      // Check for permission errors
      if (msg.includes('accessibility_denied') || msg.includes('screen_recording_denied')) {
        console.error(`\n⚠️  Permission Error:\n${msg}`);
      }
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.readline = null;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Helper process exited with code ${code}`));
        this.pendingRequests.delete(id);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.useHostIpc) return;
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.readline = null;
    }
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = { id, method, params };

    const timeoutMs = method === 'captureScreen' ? 90000 : 30000;

    if (this.useHostIpc) {
      await ensureHostAppRunning();
      const res = await fetch(`${HOST_BASE_URL}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clawdcursor-token': getOrCreateHostToken(),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Host IPC call failed (${res.status})`);
      }
      const rpc = await res.json() as JsonRpcResponse;
      if (rpc.error) {
        throw new Error(`${rpc.error.message} (code ${rpc.error.code})`);
      }
      return rpc.result as T;
    }

    if (!this.process) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      // Guard against process dying between start() and write()
      if (!this.process?.stdin) {
        reject(new Error('Helper process not available'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { 
        resolve: (value) => {
          clearTimeout(timeout);
          (resolve as (value: unknown) => void)(value);
        }, 
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  // MARK: - Public API

  async checkPermissions(): Promise<PermissionStatus> {
    return this.call<PermissionStatus>('checkPermissions');
  }

  async traverseAccessibilityTree(pid: number, options?: {
    maxDepth?: number;
    maxElements?: number;
  }): Promise<{ pid: number; elementCount: number; tree: UIElement }> {
    return this.call('traverseAccessibilityTree', { pid, ...options });
  }

  async click(x: number, y: number, options?: {
    button?: 'left' | 'right';
    clickCount?: number;
  }): Promise<{ success: boolean; x: number; y: number }> {
    return this.call('click', { x, y, ...options });
  }

  async moveMouse(x: number, y: number): Promise<{ success: boolean; x: number; y: number }> {
    return this.call('moveMouse', { x, y });
  }

  async dragMouse(startX: number, startY: number, endX: number, endY: number): Promise<{ success: boolean }> {
    return this.call('dragMouse', { startX, startY, endX, endY });
  }

  async type(text: string, options?: { delayMs?: number }): Promise<{ success: boolean; length: number }> {
    return this.call('type', { text, ...options });
  }

  async pressKey(key: string, modifiers?: string[]): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    return this.call('pressKey', { key, modifiers });
  }

  async openApp(name?: string, bundleId?: string): Promise<{ success: boolean; pid: number }> {
    return this.call('openApp', { name, bundleId });
  }

  async getWindowList(): Promise<{ windows: WindowInfo[] }> {
    return this.call('getWindowList');
  }

  async captureScreen(): Promise<CapturedScreen> {
    return this.call('captureScreen');
  }
}

// Singleton instance
let instance: NativeHelper | null = null;

export function getNativeHelper(): NativeHelper {
  if (!instance) {
    instance = new NativeHelper();
    // Cleanup on process exit
    process.on('exit', () => {
      instance?.stop();
    });
    process.on('SIGTERM', () => {
      instance?.stop();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      instance?.stop();
      process.exit(0);
    });
  }
  return instance;
}

// Functional permission probes — test what ClawdCursor can ACTUALLY do.
// The permission-check binary reports the app bundle's TCC grants, but these
// can differ from the terminal's grants. We probe using the same binaries
// that clawdcursor agent/doctor use, so status matches reality.
// (Screen Recording is screenRecordingGranted below, the capture gate's own check.)

async function probeAccessibility(): Promise<boolean> {
  // Must test actual WINDOW access — process enumeration works without assistive access,
  // but window/UI element queries require it. This matches what isShellAvailable() checks.
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-l', 'JavaScript', '-e',
      'var se = Application("System Events"); ' +
      'var p = se.processes.whose({frontmost: true})[0]; ' +
      'p.windows.length; true']);
    const timeout = setTimeout(() => { proc.kill(); resolve(false); }, 5000);
    proc.on('error', () => { clearTimeout(timeout); resolve(false); });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && stdout.trim().length > 0);
    });
  });
}

// Quick permission check (doesn't need full helper running)
// On non-macOS platforms, returns permissions as granted (not applicable)
// Accessibility: functional probes of the terminal's actual capabilities,
// merged with the app bundle's permission-check for best accuracy.
// Screen Recording: the capture gate's own check (screenRecordingGranted), so
// doctor and status answer for the identity a capture runs as — never the
// host app's own entry, which captures do not use.
export async function checkPermissionsQuick(): Promise<PermissionStatus> {
  // On non-macOS platforms, permissions aren't needed in the same way
  if (!IS_MACOS) {
    return {
      accessibility: true,  // Not applicable on Windows/Linux
      screenRecording: true,
      processPath: process.execPath,
      bundleId: undefined,
    };
  }

  // Try native binary first (checks the app bundle's TCC grants)
  let binaryResult: PermissionStatus | null = null;

  if (await isHostRunning()) {
    try {
      const res = await fetch(`${HOST_BASE_URL}/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        binaryResult = await res.json() as PermissionStatus;
      }
    } catch { /* fall through */ }
  }

  if (!binaryResult) {
    const permissionCheckPath = findNativeHelperPath('permission-check');
    if (permissionCheckPath) {
      try {
        binaryResult = await new Promise<PermissionStatus>((resolve, reject) => {
          const proc = spawn(permissionCheckPath, []);
          let stdout = '';
          const timeout = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 10000);
          proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
          proc.stdout.on('data', (data) => { stdout += data; });
          proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) { reject(new Error('non-zero exit')); return; }
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('parse error')); }
          });
        });
      } catch { /* fall through to probes */ }
    }
  }

  // Functional probes — test what the terminal can ACTUALLY do.
  // If the binary says denied but the probe succeeds, the terminal has the permission.
  // If the binary says granted, trust it (no need to probe).
  const [screenRecording, probeAx] = await Promise.all([
    screenRecordingGranted(),
    (binaryResult?.accessibility) ? Promise.resolve(true) : probeAccessibility(),
  ]);

  return {
    accessibility: (binaryResult?.accessibility ?? false) || probeAx,
    screenRecording: screenRecording === true,
    processPath: binaryResult?.processPath ?? process.execPath,
    bundleId: binaryResult?.bundleId ?? undefined,
  };
}

// Request permissions with system popups (triggers macOS permission dialogs)
// Spawns permission-check with --prompt (Accessibility) and --request-screen-recording flags
export async function requestPermissions(): Promise<PermissionStatus> {
  if (!IS_MACOS) {
    return {
      accessibility: true,
      screenRecording: true,
      processPath: process.execPath,
      bundleId: undefined,
    };
  }

  const permissionCheckPath = findNativeHelperPath('permission-check');
  if (!permissionCheckPath) {
    throw new Error(`permission-check binary not found. ${nativeBuildHint()}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(permissionCheckPath, ['--prompt', '--request-screen-recording']);
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('permission-check timed out'));
    }, 30000);
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });

    proc.stdout.on('data', (data: Buffer) => { stdout += data; });
    proc.stderr.on('data', (data: Buffer) => { stderr += data; });

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`permission-check failed: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid permission-check output: ${stdout}`));
      }
    });
  });
}

/** Where a helper binary is installed, or null when it was never built (#244: no Xcode Command Line Tools). */
function findNativeHelperPath(binary: string): string | null {
  const root = getPackageRoot();
  const locations = [
    path.join(root, 'native', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    path.join(root, 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
  ];
  return locations.find(loc => fs.existsSync(loc)) ?? null;
}

/** How to get the helpers built. The package's postinstall builds them when the Xcode Command Line Tools are present. */
export function nativeBuildHint(): string {
  return 'Install the Xcode Command Line Tools (xcode-select --install), then build the helpers: ' +
    `node "${path.join(getPackageRoot(), 'scripts', 'postinstall-native.js')}"`;
}

function getNativeHelperPath(binary: string): string {
  const found = findNativeHelperPath(binary);
  if (!found) throw new Error(`ClawdCursor app binary not found: ${binary}`);
  return found;
}

export async function isHostRunning(): Promise<boolean> {
  if (!IS_MACOS) return false;
  try {
    const res = await fetch(`${HOST_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureHostAppRunning(): Promise<void> {
  if (!IS_MACOS) return;
  if (await isHostRunning()) return;

  const appExecutable = getNativeHelperPath('ClawdCursorHost');
  const appPath = path.resolve(appExecutable, '..', '..', '..');
  await new Promise<void>((resolve, reject) => {
    const opener = spawn('open', ['-a', appPath], { stdio: 'ignore' });
    opener.on('error', reject);
    opener.on('close', () => resolve());
  });

  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (await isHostRunning()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('ClawdCursor host app did not start in time');
}

export async function stopHostApp(): Promise<void> {
  if (!IS_MACOS) return;
  await new Promise<void>((resolve) => {
    const proc = spawn('osascript', ['-e', 'tell application id "com.clawdcursor.app" to quit'], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (!(await isHostRunning())) return;
    await new Promise(r => setTimeout(r, 200));
  }
  // stale process recovery
  await new Promise<void>((resolve) => {
    const proc = spawn('pkill', ['-f', 'ClawdCursorHost'], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

function getOrCreateHostToken(): string {
  const dir = path.join(os.homedir(), '.clawdcursor');
  const tokenPath = path.join(dir, 'host-token');
  fs.mkdirSync(dir, { recursive: true });
  // Cryptographically-random token (Math.random is not secure for auth), written
  // with an exclusive create ('wx') so a concurrent caller can't clobber/race the
  // file between a check and write — if it already exists, read the existing one.
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
    throw err;
  }
}

// TCC keys the grant to the app a process was launched from; with none above it (launchd, ssh), to each binary itself.
const SCREEN_RECORDING_DENIED = 'Screen Recording permission denied — in System Settings → Privacy & Security → Screen Recording, ' +
  'enable the app running clawdcursor (terminal or MCP host); if no app started it (launchd, ssh), enable node and screenshot-helper';

/**
 * Screen Recording is not granted. macOS does not fail a capture without it — it returns the wallpaper and menu bar only,
 * which looks like a real screenshot (#276) — so this is an error that no capture path may fall back from.
 */
export class ScreenRecordingDeniedError extends Error {
  constructor() { super(SCREEN_RECORDING_DENIED); this.name = 'ScreenRecordingDeniedError'; }
}

/** Set once Screen Recording is confirmed. A denial is never cached: the next capture asks again. */
let screenRecordingConfirmed = false;

/**
 * Whether this process may record the screen: true, false (denied) or null (the check did not answer). The one question
 * the capture gate and doctor/status ask. It is asked of a child process, which macOS judges as the same identity as a
 * capture here (the app running clawdcursor), not as ClawdCursor.app:
 * - the screenshot helper's CGPreflightScreenCaptureAccess, which runs before it reads its arguments (exit 2: denied);
 * - no helper built (#244): a `screencapture -x` test grab, which macOS fails without the grant.
 *
 * A grant is cached for the life of the process, so captures do not each spawn a check. Revoking it does not leave a
 * stale grant in use: macOS quits or blocks the app it is revoked from, and the helper still checks inside every capture.
 */
export async function screenRecordingGranted(): Promise<boolean | null> {
  if (!IS_MACOS || screenRecordingConfirmed) return true;
  const helperPath = findNativeHelperPath('screenshot-helper');
  const granted = await (helperPath ? helperPreflight(helperPath) : screencaptureProbe());
  if (granted) screenRecordingConfirmed = true;
  return granted;
}

function helperPreflight(helperPath: string): Promise<boolean | null> {
  return new Promise(resolve => {
    const proc = spawn(helperPath, ['--preflight']);
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 5000);
    // Any exit but 2 passed the preflight (a helper older than --preflight exits 1 on the usage check after it).
    proc.on('close', c => { clearTimeout(timer); resolve(c === null ? null : c !== 2); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** A test grab: without the grant `screencapture` fails ("could not create image from display"), unlike a nut-js grab. */
function screencaptureProbe(): Promise<boolean | null> {
  const tmp = path.join(os.tmpdir(), `.clawdcursor-probe-${crypto.randomUUID()}.png`);
  return new Promise(resolve => {
    const done = (granted: boolean | null) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
      resolve(granted);
    };
    const proc = spawn('screencapture', ['-x', '-t', 'png', tmp]);
    const timer = setTimeout(() => { proc.kill(); done(null); }, 5000);
    proc.on('error', () => done(null));   // could not run: no answer, not a denial
    proc.on('close', code => {
      let wrote = false;
      try { wrote = fs.statSync(tmp).size > 100; } catch { /* nothing written */ }
      done(code === 0 && wrote);
    });
  });
}

/** Throws ScreenRecordingDeniedError unless Screen Recording is granted (screenRecordingGranted). Not macOS: returns. */
export async function assertScreenRecordingGranted(): Promise<void> {
  const granted = await screenRecordingGranted();
  if (granted === false) throw new ScreenRecordingDeniedError();
  if (granted === null) console.warn('⚠️  Screen Recording check did not answer — capturing without it; a missing grant would show as a wallpaper-only image');
}

/**
 * Capture the screen using the standalone screenshot-helper binary.
 * This avoids the ReplayKit CPU spin bug (19% idle CPU after capture in-process)
 * by running capture in an isolated subprocess that exits immediately.
 *
 * Returns { path, width, height } on success.
 */
export async function captureScreenViaHelper(outputPath?: string): Promise<{ path: string; width: number; height: number }> {
  if (!IS_MACOS) {
    throw new Error('screenshot-helper is only available on macOS');
  }

  const helperPath = getNativeHelperPath('screenshot-helper');
  // Unpredictable name (not Date.now()) so a co-tenant can't pre-create/symlink
  // the path the helper writes to, and rapid captures can't collide (CWE-377).
  const tmpPath = outputPath || path.join(os.tmpdir(), `.clawdcursor-cap-${crypto.randomUUID()}.png`);

  return new Promise((resolve, reject) => {
    const proc = spawn(helperPath, ['--fullscreen', tmpPath]);
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('screenshot-helper timed out after 15s'));
    }, 15000);

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 2) {
        reject(new ScreenRecordingDeniedError());
        return;
      }
      if (code !== 0) {
        reject(new Error(`screenshot-helper failed (exit ${code}): ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          resolve({ path: result.path, width: result.width, height: result.height });
        } else {
          reject(new Error(`screenshot-helper returned failure: ${stdout}`));
        }
      } catch {
        reject(new Error(`Invalid screenshot-helper output: ${stdout}`));
      }
    });
  });
}

/**
 * Check if we're running on macOS
 */
export function isMacOS(): boolean {
  return IS_MACOS;
}
