/**
 * HTTP utility surface — the small set of plain-HTTP routes that survived
 * the v0.9 PR7 cutover when REST endpoints were collapsed into MCP tools.
 *
 * Surviving routes (they're operational endpoints, not tools):
 *   GET  /health   — readiness probe (no auth, returns JSON status)
 *   POST /stop     — graceful shutdown (Bearer auth, localhost only)
 *   GET  /         — single-page dashboard (mountDashboard wires this)
 *
 * Everything else moved to MCP tools and is exposed via the streamable
 * HTTP transport at /mcp. See src/mcp-server.ts.
 *
 * Auth — the daemon generates a 32-byte Bearer token on startup, persists
 * it to ~/.clawdcursor/token, and the same requireAuth() middleware here
 * gates /stop and /mcp. /health and / (dashboard) are public; the
 * dashboard's inline JS reads the token from a server-injected placeholder
 * and uses it for /mcp calls.
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { mountDashboard } from './dashboard';
import { VERSION } from './version';
import { DATA_DIR } from '../paths';
import { e } from './format';

const TOKEN_PATH = join(DATA_DIR, 'token');

/**
 * True when `host` resolves to the local loopback interface. The MCP surface
 * controls the desktop, so the daemon refuses to bind anywhere else unless the
 * operator passes `--allow-remote` (issue #113 — the bearer token must not be
 * the ONLY thing between the LAN and full desktop control by default).
 */
export function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;       // whole 127/8 block
  if (h === '::ffff:127.0.0.1') return true;            // IPv4-mapped loopback
  return false;
}

// ── Bearer token state ──────────────────────────────────────────────────
//
// The token is generated lazily — only when the daemon binds its port
// (see initServerToken). This prevents CLI commands like `stop`, `task`,
// or `consent` from overwriting the running server's token file when they
// import this module.
//
// v0.8.2 silent-401 fix: requireAuth accepts EITHER the in-memory
// SERVER_TOKEN or whatever's currently on disk. A second clawdcursor
// process that rotates the file won't silently 401 clients that read the
// new token from disk.

export let SERVER_TOKEN = '';

function generateToken(): string {
  const token = randomBytes(32).toString('hex');
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o600 });
  } catch (tokenErr) {
    console.warn(`${e('⚠', '[WARN]')} Could not write auth token file:`, (tokenErr as Error).message);
  }
  return token;
}

/** Initialize the auth token. Called once from the daemon's listen callback. */
export function initServerToken(): string {
  SERVER_TOKEN = generateToken();
  diskTokenCache = { token: SERVER_TOKEN, mtimeMs: Date.now(), nextCheckMs: 0 };
  return SERVER_TOKEN;
}

let diskTokenCache: { token: string; mtimeMs: number; nextCheckMs: number } | null = null;
const DISK_TOKEN_TTL_MS = 500;

function currentDiskToken(): string {
  const now = Date.now();
  try {
    if (diskTokenCache && now < diskTokenCache.nextCheckMs) {
      return diskTokenCache.token;
    }
    const stat = statSync(TOKEN_PATH);
    const mtimeMs = stat.mtimeMs;
    if (diskTokenCache && diskTokenCache.mtimeMs === mtimeMs) {
      diskTokenCache.nextCheckMs = now + DISK_TOKEN_TTL_MS;
      return diskTokenCache.token;
    }
    const token = readFileSync(TOKEN_PATH, 'utf-8').trim();
    diskTokenCache = { token, mtimeMs, nextCheckMs: now + DISK_TOKEN_TTL_MS };
    return token;
  } catch {
    return '';
  }
}

/** Constant-time token compare — no byte-level timing leak on localhost. */
function timingSafeTokenEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {

    require('crypto').timingSafeEqual(a, a);
    return false;
  }

  return require('crypto').timingSafeEqual(a, b);
}

let loggedTokenDrift = false;
function readCookieToken(req: express.Request): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'clawdcursor_token') return decodeURIComponent(rest.join('='));
  }
  return '';
}
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers['authorization'] || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cookieToken = readCookieToken(req);
  const received = headerToken || cookieToken;

  const memoryOk = timingSafeTokenEqual(received, SERVER_TOKEN);
  let diskOk = false;
  // /stop and /abort are localhost-only SHUTDOWN controls: accept the current
  // on-disk token for them even without CLAWD_ALLOW_DISK_TOKEN_DRIFT. The token
  // file is owner-only (0600) and these endpoints only stop the daemon (no data
  // or tool access), so tolerating a drifted disk token here makes
  // `clawdcursor stop` reliable across daemon restarts/churn WITHOUT weakening
  // the powerful /mcp tool surface, which stays strict (in-memory token only).
  const isShutdownEndpoint = req.path === '/stop' || req.path === '/abort';
  if (!memoryOk && (isShutdownEndpoint || process.env.CLAWD_ALLOW_DISK_TOKEN_DRIFT === '1')) {
    const diskToken = currentDiskToken();
    if (diskToken && diskToken !== SERVER_TOKEN) {
      if (!loggedTokenDrift && process.env.CLAWD_ALLOW_DISK_TOKEN_DRIFT === '1') {
        loggedTokenDrift = true;
        console.warn(
          `${e('⚠', '[WARN]')} Auth token file was rewritten by another process. ` +
          `Accepting either the original or the new token to avoid silent 401s. ` +
          `Run \`clawdcursor stop\` once and restart if you want a single canonical token.`,
        );
      }
      diskOk = timingSafeTokenEqual(received, diskToken);
    }
  }

  if (!memoryOk && !diskOk) {
    res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token> header. Token is at ~/.clawdcursor/token' });
    return;
  }
  next();
}

// ── Log buffer (server-side console capture for the dashboard) ─────────

interface LogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];
const MAX_LOG_MSG_LEN = 500;

function addLog(level: LogEntry['level'], message: string): void {
  const truncated = message.length > MAX_LOG_MSG_LEN
    ? message.slice(0, MAX_LOG_MSG_LEN) + '…'
    : message;
  logBuffer.push({ timestamp: Date.now(), level, message: truncated });
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }
}

let consoleHooked = false;
function hookConsole(): void {
  if (consoleHooked) return;
  consoleHooked = true;

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const lower = msg.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('❌')) {
      addLog('error', msg);
    } else if (lower.includes('✅') || lower.includes('success') || lower.includes('completed')) {
      addLog('success', msg);
    } else if (lower.includes('⚠') || lower.includes('warn')) {
      addLog('warn', msg);
    } else {
      addLog('info', msg);
    }
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    addLog('error', msg);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    addLog('warn', msg);
  };
}

/** Read-only snapshot accessor for the captured log buffer. */
export function getServerLogBuffer(): LogEntry[] {
  return logBuffer.slice();
}

// ── Express app factory ─────────────────────────────────────────────────

export interface UtilityServerOptions {
  /** Called when /stop is invoked (graceful shutdown). */
  onStop: () => void | Promise<void>;
  /**
   * Called when /abort is invoked (and first on /stop): abort the in-flight
   * agent task WITHOUT shutting the daemon down. Optional — a tools-only
   * daemon has no agent to abort.
   */
  onAbort?: () => void;
  /** Bind host. A non-loopback host disables the dashboard, which embeds the control token. */
  host?: string;
}

/**
 * Build the surviving plain-HTTP surface: /, /health, /stop. The MCP
 * transport at /mcp must be mounted by the caller (it shares the auth
 * gate exported above).
 */
export function createUtilityServer(options: UtilityServerOptions): express.Express {
  hookConsole();

  const app = express();
  app.use(express.json());

  // ── CORS ──
  // Block browser-origin requests to prevent SSRF / localhost-bypass
  // attacks. The dashboard at GET / is exempt (browser tab); all other
  // routes require either no Origin (curl/CLI) or an allowed localhost
  // origin.
  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    const allowedOrigins = [
      'http://localhost:3847',
      'http://127.0.0.1:3847',
    ];
    if (origin) {
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
        res.setHeader('Vary', 'Origin');
      } else {
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        res.status(403).json({ error: 'Cross-origin requests not allowed' });
        return;
      }
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Handle malformed JSON gracefully.
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
    next(err);
  });

  // Mount the dashboard at GET /. SECURITY: the bearer token is injected into
  // the page's JS, and that token is full desktop control. On a non-loopback
  // bind this used to log a warning and then serve it ANYWAY — so anyone who
  // could reach the port and load `/` got the token. Remote binding is opt-in
  // (--allow-remote), which makes that user the one who most needs this not to
  // happen. The dashboard is now simply not mounted off-loopback; remote API
  // clients authenticate with the bearer token directly and never need it.
  if (options.host && !isLoopbackHost(options.host)) {
    console.warn(`${e('⚠️', '[WARN]')} Dashboard disabled: bound to ${options.host}, and the dashboard embeds the control token. It is only served on localhost.`);
  } else {
    mountDashboard(app, () => SERVER_TOKEN);
  }

  // GET /health — public readiness probe.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // POST /abort — Bearer-gated, localhost-only: abort the in-flight agent
  // task WITHOUT shutting the daemon down. Restored route: the legacy REST
  // surface (src/server.ts) had it, v0.9 PR7.4 deleted it with the rest of
  // REST — but `clawdcursor stop` still calls /abort first, so stop became
  // a hard kill that never let the agent acknowledge ("aborted by user").
  app.post('/abort', requireAuth, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Abort is only allowed from localhost' });
    }
    console.log(`\n${e('⏹', '--')} Abort requested — stopping the in-flight task...`);
    try { options.onAbort?.(); } catch { /* non-fatal */ }
    res.json({ aborted: true });
  });

  // POST /stop — Bearer-gated, localhost-only graceful shutdown.
  app.post('/stop', requireAuth, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Stop is only allowed from localhost' });
    }

    const body = JSON.stringify({ stopped: true, message: 'Clawd Cursor stopped' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body, () => {
      console.log(`\n${e('👋', '--')} Shutting down (stop command received)...`);
      // Abort the in-flight agent task FIRST so the loop can settle and
      // print its "aborted by user" acknowledgment, then give onStop a
      // bounded grace window before exiting. Previously this exited a flat
      // 500ms after the response — a hard kill mid-turn with no output.
      try { options.onAbort?.(); } catch { /* non-fatal */ }
      const grace = Promise.resolve().then(() => options.onStop()).catch(() => {});
      const cap = new Promise<void>(resolve => setTimeout(resolve, 2500));
      void Promise.race([grace, cap]).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 6000); // hard-kill safety net
  });

  return app;
}

/**
 * JSON 404 fallthrough — every consumer of this surface is a program;
 * Express's default HTML error page is noise to them (endpoint smoke
 * 2026-06-12). MUST be mounted LAST, after every real route — the daemon
 * registers /mcp on the app AFTER createUtilityServer returns, so this
 * cannot live inside it (middleware runs in registration order and would
 * swallow /mcp).
 */
export function mountJson404(app: express.Express): void {
  app.use((req, res) => {
    res.status(404).json({
      error: `No such endpoint: ${req.method} ${req.path}`,
      endpoints: ['GET /', 'GET /health', 'POST /mcp', 'GET /mcp', 'POST /abort', 'POST /stop'],
    });
  });
}
