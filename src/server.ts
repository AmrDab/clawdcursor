/**
 * HTTP Server — REST API for controlling the agent.
 * 
 * Endpoints:
 *   GET  /           — Web dashboard
 *   POST /task       — submit a new task
 *   GET  /status     — get agent state
 *   POST /confirm    — approve/reject a pending action
 *   POST /abort      — abort current task
 *   GET  /screenshot — get current screen
 *   GET  /logs       — recent log entries as JSON
 *   GET  /health     — health check
 *   POST /stop       — graceful shutdown (localhost only)
 *   GET  /favorites  — list saved favorite commands
 *   POST /favorites  — add a command to favorites
 *   DELETE /favorites — remove a command from favorites
 *   POST /report     — submit an error report (opt-in)
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { ClawdConfig } from './types';
import { Agent } from './agent';
import { mountDashboard } from './dashboard';
import { VERSION } from './version';
import { DATA_DIR } from './paths';
import { e } from './format';

// Favorites persistence — stored in ~/.clawdcursor/ so it persists across cwd changes
const FAVORITES_PATH = join(DATA_DIR, '.clawdcursor-favorites.json');

// ── Bearer token auth ─────────────────────────────────────────────────────────
// Generated once at startup, persisted to ~/.clawdcursor/token so the
// dashboard and external callers can read it. Rotates on every fresh start.
const TOKEN_PATH = join(DATA_DIR, 'token');

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

// Token is generated lazily (only when createServer is first called, i.e. `start`).
// This prevents CLI commands like `stop`, `task`, `consent` from overwriting the
// running server's token file on import.
export let SERVER_TOKEN = '';

/** Initialize the auth token. Called once from createServer(). */
export function initServerToken(): string {
  SERVER_TOKEN = generateToken();
  return SERVER_TOKEN;
}

/** Middleware: require Authorization: Bearer <token> on mutating endpoints. */
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token !== SERVER_TOKEN) {
    res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token> header. Token is at ~/.clawdcursor/token' });
    return;
  }
  next();
}

function loadFavorites(): string[] {
  try {
    if (existsSync(FAVORITES_PATH)) {
      const data = readFileSync(FAVORITES_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (favErr) {
    console.warn(`${e('⚠', '[WARN]')} Failed to load favorites:`, (favErr as Error).message);
  }
  return [];
}

function saveFavorites(favorites: string[]): void {
  try {
    writeFileSync(FAVORITES_PATH, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (saveErr) {
    console.error(`${e('❌', '[ERR]')} Failed to save favorites:`, (saveErr as Error).message);
  }
}

// In-memory log buffer
interface LogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];

const MAX_LOG_MSG_LEN = 500;

function addLog(level: LogEntry['level'], message: string): void {
  // Truncate oversized messages (e.g. full LLM responses) to keep the buffer lean
  const truncated = message.length > MAX_LOG_MSG_LEN
    ? message.slice(0, MAX_LOG_MSG_LEN) + '\u2026'
    : message;
  logBuffer.push({ timestamp: Date.now(), level, message: truncated });
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }
}

/**
 * Intercept console methods to capture logs into the buffer.
 * Preserves original behavior.
 */
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
    // Classify message
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

const taskSchema = z.object({
  task: z.string().trim().min(1).max(2000),
});

const confirmSchema = z.object({
  approved: z.boolean(),
});

export function createServer(agent: Agent, config: ClawdConfig): express.Express {
  // NOTE: initServerToken() is NOT called here — it's called from the listen
  // callback in index.ts AFTER the port binds successfully. This prevents
  // overwriting a valid token when start fails (e.g. EADDRINUSE).

  // Hook console to capture logs
  hookConsole();

  const app = express();
  app.use(express.json());

  // ── CORS: block browser-origin requests to prevent SSRF/localhost-bypass attacks ──
  // The dashboard at GET / is exempt (browser tab). All API routes require:
  //   1. Non-browser origin (no Origin header), OR same origin, OR explicit allowlist
  //   2. Bearer token (on mutating endpoints)
  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    // Allow: no origin (curl, CLI, direct), or localhost origins
    const allowedOrigins = [
      'http://localhost:3847',
      'http://127.0.0.1:3847',
    ];
    if (origin) {
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');
      } else {
        // Cross-origin browser request — block it
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        res.status(403).json({ error: 'Cross-origin requests not allowed' });
        return;
      }
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Handle malformed JSON gracefully (e.g. control characters from terminal)
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
    next(err);
  });

  // Mount the web dashboard at GET /
  mountDashboard(app);

  // --- Favorites endpoints ---

  // Get all favorites
  app.get('/favorites', requireAuth, (_req, res) => {
    res.json(loadFavorites());
  });

  // Add a favorite
  app.post('/favorites', requireAuth, (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" string in body' });
    }
    const favorites = loadFavorites();
    const trimmed = parsed.data.task;
    if (!favorites.includes(trimmed)) {
      favorites.push(trimmed);
      saveFavorites(favorites);
    }
    res.json({ ok: true, favorites });
  });

  // Remove a favorite
  app.delete('/favorites', requireAuth, (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" string in body' });
    }
    const favorites = loadFavorites();
    const trimmed = parsed.data.task;
    const idx = favorites.indexOf(trimmed);
    if (idx === -1) {
      return res.status(404).json({ error: 'Favorite not found' });
    }
    favorites.splice(idx, 1);
    saveFavorites(favorites);
    res.json({ ok: true, favorites });
  });

  // Submit a task
  app.post('/task', requireAuth, async (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" in body' });
    }

    const { task } = parsed.data;
    const state = agent.getState();
    if (state.status !== 'idle') {
      return res.status(409).json({
        error: 'Agent is busy',
        state,
      });
    }

    console.log(`\n${e('📨', '>')} New task received: ${task}`);

    // Execute async — respond immediately
    agent.executeTask(task).then(result => {
      console.log(`\n${e('📋', '>')} Task result:`, JSON.stringify(result, null, 2));
    }).catch(err => {
      console.error(`\n${e('❌', '[ERR]')} Task execution failed:`, err);
    });

    res.json({ accepted: true, task });
  });

  // Get current status
  app.get('/status', (req, res) => {
    res.json(agent.getState());
  });

  // Task logs — structured JSONL logs for every task
  app.get('/task-logs', requireAuth, (_req, res) => {
    try {
      const logger = (agent as any).logger;
      if (!logger) return res.json([]);
      res.json(logger.getRecentSummaries(50));
    } catch { res.json([]); }
  });

  app.get('/task-logs/current', requireAuth, (_req, res) => {
    try {
      const logger = (agent as any).logger;
      const logPath = logger?.getCurrentLogPath();
      if (!logPath || !require('fs').existsSync(logPath)) {
        return res.status(404).json({ error: 'No current log' });
      }
      const content = require('fs').readFileSync(logPath, 'utf-8');
      const entries = content.trim().split('\n').map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.json(entries);
    } catch { res.status(500).json({ error: 'Failed to read log' }); }
  });

  // Approve or reject a pending confirmation
  app.post('/confirm', requireAuth, (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "approved" boolean in body' });
    }

    const { approved } = parsed.data;
    const safety = agent.getSafety();
    if (!safety.hasPendingConfirmation()) {
      return res.status(404).json({ error: 'No pending confirmation' });
    }

    const pending = safety.getPendingAction();
    safety.respondToConfirmation(approved);

    res.json({
      confirmed: approved,
      action: pending?.description,
    });
  });

  // Abort current task
  app.post('/abort', requireAuth, (req, res) => {
    agent.abort();
    res.json({ aborted: true });
  });

  // Get recent log entries
  app.get('/logs', requireAuth, (req, res) => {
    res.json(logBuffer);
  });

  // Screenshot — returns PNG image of current screen
  app.get('/screenshot', requireAuth, async (_req, res) => {
    try {
      const desktop = agent.getDesktop();
      const frame = await desktop.captureForLLM();
      res.set('Content-Type', 'image/png');
      res.set('X-Scale-Factor', String(frame.scaleFactor));
      res.set('X-Screen-Width', String(frame.llmWidth));
      res.set('X-Screen-Height', String(frame.llmHeight));
      res.send(frame.buffer);
    } catch (err) {
      res.status(500).json({ error: `Screenshot failed: ${(err as Error).message}` });
    }
  });

  // Direct action execution — lets an external brain (e.g. Claude Code) drive the agent
  // Coordinates are in LLM-space (1280px wide) — auto-scaled to real screen
  app.post('/action', requireAuth, async (req, res) => {
    try {
      const { action, x, y, text, key, button, scrollDelta } = req.body;
      if (!action) return res.status(400).json({ error: 'Missing "action" field' });

      const desktop = agent.getDesktop();
      const screen = desktop.getScreenSize();
      const LLM_WIDTH = 1280;
      const scale = screen.width > LLM_WIDTH ? screen.width / LLM_WIDTH : 1;

      const realX = x != null ? Math.round(Number(x) * scale) : 0;
      const realY = y != null ? Math.round(Number(y) * scale) : 0;

      switch (action) {
        case 'click':
          if (x == null || y == null) return res.status(400).json({ error: 'click requires x, y' });
          await desktop.executeMouseAction({ kind: button === 'right' ? 'right_click' : 'click', x: realX, y: realY });
          res.json({ ok: true, action: 'click', x, y, realX, realY });
          break;
        case 'double_click':
          if (x == null || y == null) return res.status(400).json({ error: 'double_click requires x, y' });
          await desktop.executeMouseAction({ kind: 'double_click', x: realX, y: realY });
          res.json({ ok: true, action: 'double_click', x, y, realX, realY });
          break;
        case 'type':
          if (!text) return res.status(400).json({ error: 'type requires text' });
          await desktop.executeKeyboardAction({ kind: 'type', text });
          res.json({ ok: true, action: 'type', length: text.length });
          break;
        case 'key':
          if (!key) return res.status(400).json({ error: 'key requires key' });
          await desktop.executeKeyboardAction({ kind: 'key_press', key });
          res.json({ ok: true, action: 'key', key });
          break;
        case 'scroll':
          if (x == null || y == null) return res.status(400).json({ error: 'scroll requires x, y' });
          await desktop.executeMouseAction({ kind: 'scroll', x: realX, y: realY, scrollDelta: Number(scrollDelta || 3) });
          res.json({ ok: true, action: 'scroll', x, y, realX, realY, scrollDelta: scrollDelta || 3 });
          break;
        case 'move':
          if (x == null || y == null) return res.status(400).json({ error: 'move requires x, y' });
          await desktop.executeMouseAction({ kind: 'move', x: realX, y: realY });
          res.json({ ok: true, action: 'move', x, y, realX, realY });
          break;
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
      }
    } catch (err) {
      res.status(500).json({ error: `Action failed: ${(err as Error).message}` });
    }
  });

  // Error report — opt-in submission of redacted task logs
  app.post('/report', requireAuth, async (req, res) => {
    try {
      const { apiSubmitReport } = await import('./report');
      const { userNote, logIndex } = req.body || {};
      const result = await apiSubmitReport({
        userNote: typeof userNote === 'string' ? userNote : undefined,
        logIndex: typeof logIndex === 'number' ? logIndex : undefined,
      });
      if (result.success) {
        res.json({ success: true, reportId: result.reportId, preview: result.preview });
      } else {
        res.status(result.error === 'No task logs found' ? 404 : 502).json({
          success: false,
          error: result.error,
          reportId: result.reportId,
          preview: result.preview,
        });
      }
    } catch (err) {
      res.status(500).json({ error: `Report failed: ${(err as Error).message}` });
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // Graceful shutdown (localhost only)
  app.post('/stop', requireAuth, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Stop is only allowed from localhost' });
    }

    // Send response, then exit after it's flushed
    const body = JSON.stringify({ stopped: true, message: 'Clawd Cursor stopped' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body, () => {
      // Response fully flushed — now shut down
      console.log(`\n${e('👋', '--')} Shutting down (stop command received)...`);
      agent.disconnect();
      // Force exit after short delay (covers Windows edge cases)
      setTimeout(() => process.exit(0), 500);
    });
    // Failsafe: force exit even if flush hangs
    setTimeout(() => process.exit(1), 3000);
  });

  return app;
}
