/**
 * The daemon's HTTP surface. Every route is in ROUTES below: its gates, what it is for, and (through it) the startup
 * print and the JSON 404's list. Everything an agent does goes through MCP at /mcp (mcp-server.ts); the other routes are
 * operational. Auth and the localhost checks live in auth.ts.
 */

import express from 'express';
import { dashboardPage } from './dashboard';
import { VERSION } from './version';
import { e } from './format';
import { pauseGate, type PauseAnswer } from '../core/pause-gate';
import { stopControl } from '../core/control';
import { isLoopbackHost, localOnly, requireLocalHostHeader, requireToken, serverToken } from './auth';
import { getLogBuffer } from './log-buffer';

type Method = 'GET' | 'POST' | 'DELETE';
type RouteKey = `${Method} ${string}`;

interface Route {
  method: Method;
  path: string;
  /** 'token': the daemon's bearer token (header or the dashboard's cookie); 'token-or-disk': or the one on disk (auth.ts). */
  auth: 'none' | 'token' | 'token-or-disk';
  /** Refused off this machine, naming the route as here. */
  localOnly?: string;
  summary: string;
}

/** Every route the daemon serves. Each also checks the Host header (auth.ts requireLocalHostHeader). */
export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/', auth: 'none', summary: 'Dashboard' },
  { method: 'GET', path: '/health', auth: 'none', summary: 'Readiness probe' },
  // The dashboard's log panel. Not through MCP: a poll there was a recorded call every 2 s, refused while stopped.
  { method: 'GET', path: '/logs', auth: 'token', localOnly: 'Logs', summary: 'Recent console lines' },
  // The pause message is agent-written text about what the user is doing: never on the public /health.
  { method: 'GET', path: '/resume', auth: 'token', localOnly: 'Resume', summary: 'The pause waiting for the user, if any' },
  { method: 'POST', path: '/resume', auth: 'token', localOnly: 'Resume', summary: 'Answer that pause: {answer: "resume" | "end" | "reply"}' },
  { method: 'POST', path: '/stop', auth: 'token-or-disk', localOnly: 'Stop', summary: 'Graceful shutdown' },
  { method: 'POST', path: '/mcp', auth: 'token', summary: 'MCP JSON-RPC: tools/list, tools/call' },
  { method: 'GET', path: '/mcp', auth: 'token', summary: 'MCP session SSE stream' },
  { method: 'DELETE', path: '/mcp', auth: 'token', summary: 'End an MCP session' },
];

/** One line per route for the daemon's startup print. */
export function describeRoutes(): string[] {
  return ROUTES.map(r => {
    const gates = r.auth === 'none' ? 'no auth' : `auth${r.localOnly ? ', localhost only' : ''}`;
    return `${r.method.padEnd(6)} ${r.path.padEnd(7)} — ${r.summary} (${gates})`;
  });
}

export interface UtilityServerOptions {
  /** Called when /stop is invoked, before the process exits (graceful shutdown). */
  onStop?: () => void | Promise<void>;
  /** Bind host. A non-loopback host disables the dashboard, which embeds the control token. */
  host?: string;
  /** The MCP transport's handler for POST / GET / DELETE /mcp (startMcpHttp). Without it /mcp is a 404. */
  mcp?: express.RequestHandler;
}

export function createUtilityServer(options: UtilityServerOptions): express.Express {
  const app = express();
  app.use(requireLocalHostHeader);
  app.use(express.json());

  // ── CORS ──
  // Block browser-origin requests to prevent SSRF / localhost-bypass
  // attacks. The dashboard at GET / is exempt (browser tab); all other
  // routes require either no Origin (curl/CLI) or an allowed localhost
  // origin.
  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    // The dashboard is served by this server: its origin carries the port the daemon really listens on (--port), not 3847.
    const port = req.socket.localPort;
    const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
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

  // A malformed JSON body is a 400, not Express's HTML error page.
  app.use((err: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON in request body' });
      return;
    }
    next(err);
  });

  // SECURITY: the dashboard hands the bearer token (full desktop control) to the page. On a non-loopback bind it used
  // to log a warning and serve it ANYWAY. The daemon binds loopback only (#293); this stays as a second line for any
  // other caller: the dashboard is simply not served off-loopback.
  const offLoopback = options.host !== undefined && !isLoopbackHost(options.host);
  if (offLoopback) {
    console.warn(`${e('⚠️', '[WARN]')} Dashboard disabled: bound to ${options.host}, and the dashboard embeds the control token. It is only served on localhost.`);
  }

  const handlers: Partial<Record<RouteKey, express.RequestHandler>> = {
    'GET /': offLoopback ? undefined : dashboardPage(serverToken),
    'GET /health': (_req, res) => { res.json({ status: 'ok', version: VERSION }); },
    'GET /logs': (_req, res) => { res.json(getLogBuffer()); },
    'GET /resume': (_req, res) => {
      const pause = pauseGate.current();
      res.json({ waiting: pause !== null, pause });
    },
    // Used by `clawdcursor resume` and the dashboard buttons (pause-gate.ts).
    'POST /resume': (req, res) => {
      const reply = typeof req.body?.reply === 'string' ? req.body.reply : undefined;
      const answer = (req.body?.answer ?? (reply !== undefined ? 'reply' : 'resume')) as string;
      if (!['resume', 'end', 'reply'].includes(answer)) {
        res.status(400).json({ error: 'answer must be "resume", "end" or "reply" (with a "reply" text)' });
        return;
      }
      const pause = pauseGate.current();
      const r = pauseGate.answer(answer as PauseAnswer, 'user', reply);
      if (!r.ok) { res.status(409).json({ error: r.error, pause }); return; }
      console.log(`\n${e('▶', '>')} Pause answered: ${r.outcome}`);
      res.json({ ok: true, outcome: r.outcome, was: pause?.message });
    },
    'POST /stop': (_req, res) => {
      // Like the pill and `clawdcursor stop`: the stop holds for every clawdcursor process until the user gives control back.
      stopControl('http');
      const body = JSON.stringify({ stopped: true, message: 'Clawd Cursor stopped' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body, () => {
        console.log(`\n${e('👋', '--')} Shutting down (stop command received)...`);
        // Give onStop a bounded grace window before exiting.
        const grace = Promise.resolve().then(() => options.onStop?.()).catch(() => {});
        const cap = new Promise<void>(resolve => setTimeout(resolve, 2500));
        void Promise.race([grace, cap]).then(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 6000); // hard-kill safety net
    },
    'POST /mcp': options.mcp,
    'GET /mcp': options.mcp,
    'DELETE /mcp': options.mcp,
  };

  for (const route of ROUTES) {
    const handler = handlers[`${route.method} ${route.path}`];
    if (!handler) continue;
    const gates: express.RequestHandler[] = [];
    if (route.auth !== 'none') gates.push(requireToken({ diskTokenOk: route.auth === 'token-or-disk' }));
    if (route.localOnly) gates.push(localOnly(route.localOnly));
    const verb = route.method === 'GET' ? 'get' : route.method === 'POST' ? 'post' : 'delete';
    app[verb](route.path, ...gates, handler);
  }

  // Every consumer of this surface is a program: Express's default HTML 404 page is noise to them (endpoint smoke
  // 2026-06-12).
  app.use((req, res) => {
    res.status(404).json({
      error: `No such endpoint: ${req.method} ${req.path}`,
      endpoints: ROUTES.map(r => `${r.method} ${r.path}`),
    });
  });

  return app;
}
