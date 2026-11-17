/**
 * Who may talk to the daemon: the bearer token (the daemon writes it, clients read it), the loopback checks and the
 * Host-header check.
 *
 * The daemon generates a 32-byte token when it binds its port and saves it to ~/.clawdcursor/token (owner-only). Callers
 * send it as `Authorization: Bearer <token>`; the dashboard gets it as an httpOnly cookie when it loads `/`.
 */
import type express from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { DATA_DIR, TOKEN_PATH } from '../paths';
import { e } from './format';

/**
 * True when `host` resolves to the local loopback interface. The MCP surface
 * controls the desktop, so the daemon binds 127.0.0.1 only (#113, #293 — the
 * bearer token must not be the ONLY thing between the LAN and full desktop
 * control).
 */
export function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;       // whole 127/8 block
  if (h === '::ffff:127.0.0.1') return true;            // IPv4-mapped loopback
  return false;
}

// ── Client side: `stop`, `resume`, `uninstall` ─────────────────────────

/** The token the running daemon saved, or '' when there is none. */
export function readToken(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── Server side ─────────────────────────────────────────────────────────
//
// The token is generated lazily — only when the daemon binds its port
// (see initServerToken). This prevents CLI commands like `stop` or
// `consent` from overwriting the running server's token file when they
// import this module.

let SERVER_TOKEN = '';

/** The daemon's token, '' before initServerToken. */
export function serverToken(): string {
  return SERVER_TOKEN;
}

/** Initialize the auth token. Called once from the daemon's listen callback. */
export function initServerToken(): string {
  SERVER_TOKEN = randomBytes(32).toString('hex');
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, SERVER_TOKEN, { encoding: 'utf-8', mode: 0o600 });
  } catch (tokenErr) {
    console.warn(`${e('⚠', '[WARN]')} Could not write auth token file:`, (tokenErr as Error).message);
  }
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
    const mtimeMs = statSync(TOKEN_PATH).mtimeMs;
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
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function readCookieToken(req: express.Request): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'clawdcursor_token') return decodeURIComponent(rest.join('='));
  }
  return '';
}

let loggedTokenDrift = false;

/**
 * The token gate. The daemon's in-memory token always passes. `diskTokenOk` (the /stop route) also accepts the token
 * now on disk: /stop is a localhost-only SHUTDOWN control with no data or tool access, and the file is owner-only, so a
 * drifted disk token there makes `clawdcursor stop` reliable across daemon restarts WITHOUT weakening /mcp, which stays
 * strict. CLAWD_ALLOW_DISK_TOKEN_DRIFT=1 accepts the disk token on every gated route (v0.8.2 silent-401 fix: a second
 * process that rotated the file).
 */
export function requireToken(opts: { diskTokenOk: boolean }): express.RequestHandler {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const received = headerToken || readCookieToken(req);

    const memoryOk = timingSafeTokenEqual(received, SERVER_TOKEN);
    let diskOk = false;
    const drift = process.env.CLAWD_ALLOW_DISK_TOKEN_DRIFT === '1';
    if (!memoryOk && (opts.diskTokenOk || drift)) {
      const diskToken = currentDiskToken();
      if (diskToken && diskToken !== SERVER_TOKEN) {
        if (!loggedTokenDrift && drift) {
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
  };
}

/** Only a caller on this machine: `${what} is only allowed from localhost` otherwise. */
export function localOnly(what: string): express.RequestHandler {
  return (req, res, next) => {
    if (!isLoopbackHost(req.ip || req.socket.remoteAddress || '')) {
      res.status(403).json({ error: `${what} is only allowed from localhost` });
      return;
    }
    next();
  };
}

/**
 * The Host header must name this server as a local client does: `127.0.0.1:<port>` or `localhost:<port>`. A page whose
 * DNS name was rebound to 127.0.0.1 sends its own name (`evil.example:3847`), so it cannot read the dashboard or, through
 * it, same-origin routes such as GET /resume (the pause message) — the hole the #426 review found.
 */
export function requireLocalHostHeader(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const port = req.socket.localPort;
  const host = (req.headers.host ?? '').toLowerCase();
  // A client leaves the port out when it is the scheme's default (80).
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ['127.0.0.1', 'localhost'] : [])];
  if (!allowed.includes(host)) {
    res.status(403).json({ error: `Host not allowed: use http://127.0.0.1:${port} or http://localhost:${port}` });
    return;
  }
  next();
}
