/**
 * The last console lines of this server, for the `logs_recent` tool and the dashboard's log panel (GET /logs).
 * Both transports capture: on stdio the console already writes to stderr when captureConsole runs.
 */

export interface LogEntry {
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
/** Copy every console.log / warn / error line into the buffer (once per process), still writing it where it went. */
export function captureConsole(): void {
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

/** A copy of the captured lines, oldest first. */
export function getLogBuffer(): LogEntry[] {
  return logBuffer.slice();
}
