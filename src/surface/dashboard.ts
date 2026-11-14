/**
 * Dashboard — Single-page web dashboard for Clawd Cursor.
 * 
 * Exports the GET / handler (the daemon's route table mounts it).
 * All HTML, CSS, and JS are inline — no external files or frameworks.
 */

import type { RequestHandler } from 'express';
import { VERSION } from './version';
import { dashboardToolCall } from './dashboard-tools';

/** GET /: the page, and the daemon's token as an httpOnly cookie its requests carry. */
export function dashboardPage(getToken?: () => string): RequestHandler {
  return (_req, res) => {
    const token = getToken?.() ?? '';
    if (token) {
      res.cookie('clawdcursor_token', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
      });
    }
    res.type('html').send(DASHBOARD_HTML);
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🐾 Clawd Cursor Dashboard</title>
<style>
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --bg-card: #1c2128;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #6e7681;
    --accent: #58a6ff;
    --accent-hover: #79c0ff;
    --green: #3fb950;
    --green-dim: #238636;
    --yellow: #d29922;
    --yellow-dim: #9e6a03;
    --red: #f85149;
    --red-dim: #da3633;
    --red-bg: #490202;
    --font-mono: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --radius: 8px;
    --shadow: 0 2px 8px rgba(0,0,0,0.3);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* Header */
  .header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-title {
    font-size: 1.25rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .header-spacer { flex: 1; }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 20px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }

  .status-dot.idle { background: var(--red); }
  .status-dot.confirming { background: var(--yellow); animation: pulse 2s ease-in-out infinite; }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.3); }
  }

  .conn-indicator {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
  }
  .conn-dot.disconnected { background: var(--red); }

  .version-tag {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
  }

  .kill-btn {
    background: var(--red-dim);
    color: #fff;
    border: 1px solid var(--red);
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .kill-btn:hover { background: var(--red); }

  /* Main content */
  .main {
    flex: 1;
    padding: 20px;
    max-width: 1000px;
    margin: 0 auto;
    width: 100%;
  }

  /* Confirm banner */
  .confirm-banner {
    display: none;
    background: rgba(210, 153, 34, 0.12);
    border: 1px solid var(--yellow-dim);
    border-radius: var(--radius);
    padding: 16px 20px;
    margin-bottom: 20px;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .confirm-banner.visible { display: flex; }
  .confirm-banner .msg { flex: 1; color: var(--yellow); font-weight: 500; }

  .approve-btn, .reject-btn {
    padding: 8px 20px;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid;
    font-size: 0.88rem;
    font-family: var(--font-sans);
  }
  .approve-btn { background: var(--green-dim); border-color: var(--green); color: #fff; }
  .approve-btn:hover { background: var(--green); }
  .reject-btn { background: var(--red-dim); border-color: var(--red); color: #fff; }
  .reject-btn:hover { background: var(--red); }

  /* Logs */
  .log-area {
    background: #010409;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    line-height: 1.6;
    height: calc(100vh - 200px);
    min-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .log-entry { margin-bottom: 2px; }
  .log-ts { color: var(--text-muted); }
  .log-info { color: var(--text-secondary); }
  .log-success { color: var(--green); }
  .log-error { color: var(--red); }
  .log-warn { color: var(--yellow); }

  .empty-state {
    text-align: center;
    color: var(--text-muted);
    padding: 60px 20px;
    font-size: 1rem;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .header { padding: 10px 14px; gap: 10px; }
    .header-title { font-size: 1rem; }
    .main { padding: 14px; }
    .log-area { height: calc(100vh - 220px); min-height: 300px; }
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-title">🐾 Clawd Cursor Dashboard</div>
  <div class="header-spacer"></div>
  <div class="conn-indicator">
    <span class="conn-dot" id="connDot"></span>
    <span id="connText">Connected</span>
  </div>
  <div class="status-badge">
    <span class="status-dot idle" id="statusDot"></span>
    <span id="statusText">Idle</span>
  </div>
  <span class="version-tag" id="versionTag">v${VERSION}</span>
  <button class="kill-btn" onclick="killSwitch()">⛔ Kill</button>
</div>

<!-- Main -->
<div class="main">

  <!-- Pause banner: shown while a pause for the user is waiting -->
  <div class="confirm-banner" id="confirmBanner">
    <span class="msg" id="confirmMsg"></span>
    <button class="approve-btn" id="approveBtn" onclick="confirmAction(true)">▶ Resume</button>
    <button class="reject-btn" id="rejectBtn" onclick="confirmAction(false)">⏹ End task</button>
  </div>

  <!-- Logs -->
  <div class="log-area" id="logArea">
    <div class="empty-state" id="emptyLogs">Waiting for logs...</div>
  </div>

</div>

<script>
(function() {
  function authHeaders(extra) {
    var h = {};
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
  }

  // ── MCP-over-HTTP helper (v0.9 PR7.3) ────────────────────────────
  // The daemon mounts a streamable-HTTP MCP transport at /mcp. Every
  // dashboard action is a JSON-RPC tools/call request through this
  // helper. /health and /stop remain plain HTTP — they're operational
  // endpoints, not tools.
  var __mcpRequestId = 1;
  async function mcpCall(name, args) {
    var body = JSON.stringify({
      jsonrpc: '2.0',
      id: __mcpRequestId++,
      method: 'tools/call',
      params: { name: name, arguments: args || {} }
    });
    var res = await fetch('/mcp', {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      }),
      body: body
    });
    if (!res.ok) throw new Error('MCP HTTP ' + res.status);
    var ct = res.headers.get('Content-Type') || '';
    var rpc;
    if (ct.indexOf('text/event-stream') !== -1) {
      // SSE response — parse the first data: chunk as the JSON-RPC reply.
      var raw = await res.text();
      var lines = raw.split(/\\r?\\n/);
      var dataLine = lines.find(function(l) { return l.indexOf('data: ') === 0; });
      if (!dataLine) throw new Error('MCP SSE response missing data line');
      rpc = JSON.parse(dataLine.slice(6));
    } else {
      rpc = await res.json();
    }
    if (rpc.error) throw new Error(rpc.error.message || 'MCP error');
    var result = rpc.result || {};
    if (result.isError) {
      var content = result.content || [];
      var msg = content.map(function(c) { return c.text || ''; }).join(' ').trim();
      throw new Error(msg || 'MCP tool error');
    }
    // Convenience: if the only content piece is text and parses as JSON,
    // return the parsed object so callers don't have to unwrap manually.
    var content = result.content || [];
    var firstText = content.find(function(c) { return c.type === 'text'; });
    if (firstText && firstText.text) {
      try { return JSON.parse(firstText.text); } catch (e) { return firstText.text; }
    }
    return result;
  }

  // Which surface does this daemon serve? A --compact daemon has no
  // granular tools: ask tools/list once and map every call onto
  // what is served (dashboardToolCall, shared with the server-side tests).
  ${dashboardToolCall.toString()}
  var __servedTools = null;
  function servedTools() {
    __servedTools = __servedTools || (async function() {
      try {
        var res = await fetch('/mcp', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }),
          body: JSON.stringify({ jsonrpc: '2.0', id: __mcpRequestId++, method: 'tools/list', params: {} })
        });
        var rpc = await res.json();
        return ((rpc.result && rpc.result.tools) || []).map(function(t) { return t.name; });
      } catch (e) { __servedTools = null; return []; }
    })();
    return __servedTools;
  }
  async function toolCall(tool, args) {
    var call = dashboardToolCall(await servedTools(), tool, args || {});
    if (!call) throw new Error('Not available on the --compact MCP surface of this daemon (start it without --compact for ' + tool + ')');
    return mcpCall(call.name, call.arguments);
  }

  // State
  let lastLogCount = 0;
  let paused = false;

  // DOM refs
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const versionTag = document.getElementById('versionTag');
  const confirmBanner = document.getElementById('confirmBanner');
  const confirmMsg = document.getElementById('confirmMsg');
  const logArea = document.getElementById('logArea');
  const emptyLogs = document.getElementById('emptyLogs');

  // Connection poll: /health is the public readiness probe and says nothing
  // about a pause. The pause itself comes from GET /resume, which needs the
  // token (the dashboard's cookie), so it stays off the unauthenticated /health.
  async function pollStatus() {
    try {
      const res = await fetch('/health');
      setConnected(res.ok);
    } catch(e) {
      setConnected(false);
      return;
    }
    pollPause();
  }

  function setConnected(ok) {
    connDot.className = 'conn-dot' + (ok ? '' : ' disconnected');
    connText.textContent = ok ? 'Connected' : 'Disconnected';
  }

  async function pollPause() {
    try {
      const res = await fetch('/resume', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      renderPause(data && data.waiting ? data.pause : null);
    } catch(e) { /* ignore */ }
  }

  // A pause for the user (sign-in, 2FA, CAPTCHA, a question). Same answers as the on-screen pill.
  function renderPause(pause) {
    paused = !!pause;
    if (pause) {
      const choices = pause.choices && pause.choices.length
        ? ' (options: ' + pause.choices.join(' / ') + ': answer on screen)'
        : '';
      confirmMsg.textContent = '⏸ ' + pause.message + choices;
      statusDot.className = 'status-dot confirming';
      statusText.textContent = 'Paused for you';
      confirmBanner.classList.add('visible');
    } else {
      statusDot.className = 'status-dot idle';
      statusText.textContent = 'Idle';
      confirmBanner.classList.remove('visible');
    }
  }

  // Answer a pause (POST /resume): Resume or End task.
  window.confirmAction = async function(approved) {
    if (!paused) { confirmBanner.classList.remove('visible'); return; }
    const answer = approved ? 'resume' : 'end';
    try {
      const res = await fetch('/resume', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ answer: answer }),
      });
      if (!res.ok) {
        const data = await res.json().catch(function() { return {}; });
        alert('Could not answer: ' + (data.error || res.statusText));
      }
      confirmBanner.classList.remove('visible');
    } catch(e) {
      alert('Failed to send the answer: ' + e.message);
    }
  };

  // Kill switch
  window.killSwitch = async function() {
    if (!confirm('Are you sure you want to stop Clawd Cursor?')) return;
    try {
      await fetch('/stop', { method: 'POST', headers: authHeaders() });
      setConnected(false);
      statusDot.className = 'status-dot idle';
      statusText.textContent = 'Stopped';
      alert('Clawd Cursor has been stopped.');
    } catch(e) {
      alert('Failed to stop: ' + e.message);
    }
  };

  // Logs polling
  async function pollLogs() {
    try {
      // v0.9 PR7.3: logs_recent replaces GET /logs.
      const logs = await toolCall('logs_recent', {});
      if (!Array.isArray(logs) || logs.length === 0) return;

      if (logs.length !== lastLogCount) {
        lastLogCount = logs.length;
        renderLogs(logs);
      }
    } catch(e) { /* ignore */ }
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) return;
    emptyLogs.style.display = 'none';

    const html = logs.map(function(entry) {
      const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      const msg = entry.message || JSON.stringify(entry);
      const level = entry.level || 'info';

      let cls = 'log-info';
      if (level === 'error') cls = 'log-error';
      else if (level === 'warn' || level === 'warning') cls = 'log-warn';
      else if (level === 'success') cls = 'log-success';

      return '<div class="log-entry"><span class="log-ts">[' + escHtml(ts) + ']</span> ' +
        '<span class="' + cls + '">' + escHtml(msg) + '</span></div>';
    }).join('');

    logArea.innerHTML = html;

    // Auto-scroll
    logArea.scrollTop = logArea.scrollHeight;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Fetch version from health endpoint
  async function fetchVersion() {
    try {
      const res = await fetch('/health');
      const data = await res.json();
      if (data.version) versionTag.textContent = 'v' + data.version;
    } catch(e) { /* ignore */ }
  }

  // Init
  fetchVersion();
  pollStatus();
  setInterval(pollStatus, 2000);
  setInterval(pollLogs, 2000);
})();
</script>
</body>
</html>`;
