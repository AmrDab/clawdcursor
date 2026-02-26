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
 */

import express from 'express';
import type { ClawdConfig } from './types';
import { Agent } from './agent';
import { mountDashboard } from './dashboard';

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
function hookConsole(): void {
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

export function createServer(agent: Agent, config: ClawdConfig): express.Express {
  // Hook console to capture logs
  hookConsole();

  const app = express();
  app.use(express.json());

  // Mount the web dashboard at GET /
  mountDashboard(app);

  // Submit a task
  app.post('/task', async (req, res) => {
    const { task } = req.body;
    if (!task) {
      return res.status(400).json({ error: 'Missing "task" in body' });
    }

    const state = agent.getState();
    if (state.status !== 'idle') {
      return res.status(409).json({
        error: 'Agent is busy',
        state,
      });
    }

    console.log(`\n📨 New task received: ${task}`);

    // Execute async — respond immediately
    agent.executeTask(task).then(result => {
      console.log(`\n📋 Task result:`, JSON.stringify(result, null, 2));
    }).catch(err => {
      console.error(`\n❌ Task execution failed:`, err);
    });

    res.json({ accepted: true, task });
  });

  // Get current status
  app.get('/status', (req, res) => {
    res.json(agent.getState());
  });

  // Approve or reject a pending confirmation
  app.post('/confirm', (req, res) => {
    const { approved } = req.body;
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Missing "approved" boolean in body' });
    }

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
    res.json({ status: 'ok', version: '0.5.1' });
  });

  // Graceful shutdown (localhost only)
  app.post('/stop', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Stop is only allowed from localhost' });
    }

    res.json({ stopped: true, message: 'Clawd Cursor stopped' });

    // Graceful shutdown after response is sent
    setTimeout(() => {
      console.log('\n👋 Shutting down (stop command received)...');
      agent.disconnect();
      process.exit(0);
    }, 100);
  });

  return app;
}
