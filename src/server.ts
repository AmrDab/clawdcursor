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
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { ClawdConfig } from './types';
import { Agent } from './agent';
import { mountDashboard } from './dashboard';
import { VERSION } from './version';

// Favorites persistence
const FAVORITES_PATH = join(process.cwd(), '.clawd-favorites.json');

function loadFavorites(): string[] {
  try {
    if (existsSync(FAVORITES_PATH)) {
      const data = readFileSync(FAVORITES_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('⚠ Failed to load favorites:', (e as Error).message);
  }
  return [];
}

function saveFavorites(favorites: string[]): void {
  try {
    writeFileSync(FAVORITES_PATH, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ Failed to save favorites:', (e as Error).message);
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

function addLog(level: LogEntry['level'], message: string): void {
  logBuffer.push({ timestamp: Date.now(), level, message });
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
  app: z.string().trim().optional(),
  navigate: z.string().trim().optional(),
  context: z.string().trim().optional(),
  contextHints: z.array(z.string()).optional(),
});

const confirmSchema = z.object({
  approved: z.boolean(),
});

export function createServer(agent: Agent, config: ClawdConfig): express.Express {
  // Hook console to capture logs
  hookConsole();

  const app = express();
  app.use(express.json());

  // Mount the web dashboard at GET /
  mountDashboard(app);

  // --- Favorites endpoints ---

  // Get all favorites
  app.get('/favorites', (_req, res) => {
    res.json(loadFavorites());
  });

  // Add a favorite
  app.post('/favorites', (req, res) => {
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
  app.delete('/favorites', (req, res) => {
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
  app.post('/task', async (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" in body' });
    }

    const { task, app, navigate, context, contextHints } = parsed.data;
    const state = agent.getState();
    if (state.status !== 'idle') {
      return res.status(409).json({
        error: 'Agent is busy',
        state,
      });
    }

    const isSkillMode = !!(app || navigate || context);
    console.log(`\n📨 New task received${isSkillMode ? ' (skill mode)' : ''}: ${task}`);

    // Execute async — respond immediately
    agent.executeTask(task, { app, navigate, context, contextHints }).then(result => {
      console.log(`\n📋 Task result:`, JSON.stringify(result, null, 2));
    }).catch(err => {
      console.error(`\n❌ Task execution failed:`, err);
    });

    res.json({ accepted: true, task, skillMode: isSkillMode });
  });

  // Get current status
  app.get('/status', (req, res) => {
    res.json(agent.getState());
  });

  // Approve or reject a pending confirmation
  app.post('/confirm', (req, res) => {
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
  app.post('/abort', (req, res) => {
    agent.abort();
    res.json({ aborted: true });
  });

  // Get recent log entries
  app.get('/logs', (req, res) => {
    res.json(logBuffer);
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // Graceful shutdown (localhost only)
  app.post('/stop', (req, res) => {
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
      console.log('\n👋 Shutting down (stop command received)...');
      agent.disconnect();
      // Force exit after short delay (covers Windows edge cases)
      setTimeout(() => process.exit(0), 500);
    });
    // Failsafe: force exit even if flush hangs
    setTimeout(() => process.exit(1), 3000);
  });

  return app;
}
