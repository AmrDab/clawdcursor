/**
 * Dashboard — Single-page web dashboard for Clawd Cursor.
 * 
 * Exports a mount function that adds GET / to the Express app.
 * All HTML, CSS, and JS are inline — no external files or frameworks.
 */

import type { Express } from 'express';
import { VERSION } from './version';
import { dashboardToolCall } from './dashboard-tools';

export function mountDashboard(app: Express, getToken?: () => string): void {
  app.get('/', (_req, res) => {
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
  });
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
  .status-dot.running { background: var(--green); animation: pulse 1.5s ease-in-out infinite; }
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

  /* Tabs */
  .tab-bar {
    display: flex;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }

  .tab-btn {
    padding: 12px 24px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    font-family: var(--font-sans);
  }
  .tab-btn:hover { color: var(--text-primary); }
  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* Main content */
  .main {
    flex: 1;
    padding: 20px;
    max-width: 1000px;
    margin: 0 auto;
    width: 100%;
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Task Tab */
  .task-input-area {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }

  .task-input {
    flex: 1;
    padding: 14px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 1rem;
    font-family: var(--font-sans);
    outline: none;
    transition: border-color 0.15s;
  }
  .task-input:focus { border-color: var(--accent); }
  .task-input::placeholder { color: var(--text-muted); }

  .send-btn {
    padding: 14px 24px;
    background: var(--green-dim);
    color: #fff;
    border: 1px solid var(--green);
    border-radius: var(--radius);
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    font-family: var(--font-sans);
  }
  .send-btn:hover { background: var(--green); }
  .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Spinner */
  .spinner {
    display: none;
    text-align: center;
    padding: 20px;
    color: var(--text-secondary);
  }
  .spinner.visible { display: block; }
  .spinner::before {
    content: '';
    display: inline-block;
    width: 24px;
    height: 24px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 10px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Response card */
  .response-card {
    display: none;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 20px;
    margin-bottom: 20px;
    box-shadow: var(--shadow);
  }
  .response-card.visible { display: block; }
  .response-card .label {
    font-size: 0.8rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .response-card pre {
    font-family: var(--font-mono);
    font-size: 0.88rem;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
    line-height: 1.5;
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

  /* History */
  .history-title {
    font-size: 0.85rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  .history-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .history-item {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 0.88rem;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px;
  }
  .history-item .star-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.1rem;
    padding: 0 4px;
    line-height: 1;
    flex-shrink: 0;
    transition: transform 0.15s;
  }
  .history-item .star-btn:hover { transform: scale(1.25); }
  .history-item .history-content { flex: 1; min-width: 0; }
  .history-item .task-text { color: var(--accent); font-weight: 500; }
  .history-item .task-time { color: var(--text-muted); font-size: 0.75rem; margin-left: 8px; }
  .history-item .task-result {
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Favorites section */
  .favorites-section {
    margin-bottom: 16px;
    display: none;
  }
  .favorites-section.visible { display: block; }
  .favorites-title {
    font-size: 0.85rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .favorites-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .fav-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font-sans);
    max-width: 100%;
  }
  .fav-chip:hover {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
  }
  .fav-chip .fav-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fav-chip .fav-remove {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0 2px;
    line-height: 1;
    flex-shrink: 0;
  }
  .fav-chip .fav-remove:hover { color: var(--red); }
  .fav-chip:hover .fav-remove { color: var(--bg-primary); }
  .fav-chip:hover .fav-remove:hover { color: var(--red); }

  /* Logs Tab */
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

  /* Scheduled tab (v0.9.1) */
  .sched-help {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.55;
    margin-bottom: 18px;
  }
  .sched-help code {
    background: rgba(0,0,0,0.3);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--accent);
    font-size: 0.85em;
  }
  .sched-form {
    display: grid;
    grid-template-columns: 200px 1fr 180px auto;
    gap: 8px;
    margin-bottom: 20px;
  }
  .sched-input {
    background: var(--bg-tertiary);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 0.92rem;
    font-family: 'JetBrains Mono', monospace;
  }
  .sched-input:focus { outline: none; border-color: var(--accent); }
  .sched-add-btn { padding: 10px 20px; }
  .sched-list-section { }
  .sched-title {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 10px;
    font-weight: 600;
  }
  .sched-list { list-style: none; padding: 0; margin: 0; }
  .sched-item {
    display: grid;
    grid-template-columns: 160px 1fr auto auto auto;
    align-items: center;
    gap: 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 8px;
    font-size: 0.88rem;
  }
  .sched-item.disabled { border-left-color: var(--text-muted); opacity: 0.6; }
  .sched-item-cron {
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent);
    font-size: 0.85rem;
  }
  .sched-item-task {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sched-item-meta {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }
  .sched-toggle-btn, .sched-delete-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: 6px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 0.78rem;
    transition: all 0.15s;
  }
  .sched-toggle-btn:hover { color: var(--accent); border-color: var(--accent); }
  .sched-delete-btn:hover { color: #e74c3c; border-color: #e74c3c; }

  /* Responsive */
  @media (max-width: 640px) {
    .header { padding: 10px 14px; gap: 10px; }
    .header-title { font-size: 1rem; }
    .main { padding: 14px; }
    .task-input-area { flex-direction: column; }
    .send-btn { width: 100%; }
    .tab-btn { padding: 10px 16px; font-size: 0.88rem; }
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

<!-- Tabs -->
<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('task')" id="tabTask">📋 Tasks</button>
  <button class="tab-btn" onclick="switchTab('scheduled')" id="tabScheduled">⏰ Scheduled</button>
  <button class="tab-btn" onclick="switchTab('logs')" id="tabLogs">📜 Logs</button>
</div>

<!-- Main -->
<div class="main">

  <!-- Task Tab -->
  <div class="tab-content active" id="panelTask">

    <!-- Favorites Section -->
    <div class="favorites-section" id="favoritesSection">
      <div class="favorites-title">⭐ Favorites</div>
      <div class="favorites-chips" id="favoritesChips"></div>
    </div>

    <div class="task-input-area">
      <input type="text" class="task-input" id="taskInput"
             placeholder="Enter a task... e.g. Open Chrome and go to github.com"
             onkeydown="if(event.key==='Enter')sendTask()">
      <button class="send-btn" id="sendBtn" onclick="sendTask()">🐾 Send Task</button>
    </div>

    <div class="spinner" id="spinner">Processing task...</div>

    <div class="confirm-banner" id="confirmBanner">
      <span class="msg" id="confirmMsg">⚠️ Action requires confirmation</span>
      <button class="approve-btn" id="approveBtn" onclick="confirmAction(true)">✅ Approve</button>
      <button class="reject-btn" id="rejectBtn" onclick="confirmAction(false)">❌ Reject</button>
    </div>

    <div class="response-card" id="responseCard">
      <div class="label">Latest Response</div>
      <pre id="responseText"></pre>
    </div>

    <div id="historySection" style="display:none">
      <div class="history-title">Task History</div>
      <ul class="history-list" id="historyList"></ul>
    </div>

    <div class="empty-state" id="emptyTask">
      <p>🐾 No tasks yet. Type a task above and press Send.</p>
    </div>
  </div>

  <!-- Scheduled Tab (v0.9.1) -->
  <div class="tab-content" id="panelScheduled">
    <div class="sched-help">
      Scheduled tasks were removed: clawdcursor no longer runs a model, so it has nothing to run on a schedule.
      Schedule your own agent instead.
    </div>
  </div>

  <!-- Logs Tab -->
  <div class="tab-content" id="panelLogs">
    <div class="log-area" id="logArea">
      <div class="empty-state" id="emptyLogs">Waiting for logs...</div>
    </div>
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
  let currentTab = 'task';
  let connected = false;
  let lastLogCount = 0;
  let taskHistory = [];
  let currentStatus = 'idle';
  let favorites = [];

  // DOM refs
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const versionTag = document.getElementById('versionTag');
  const taskInput = document.getElementById('taskInput');
  const sendBtn = document.getElementById('sendBtn');
  const spinner = document.getElementById('spinner');
  const responseCard = document.getElementById('responseCard');
  const responseText = document.getElementById('responseText');
  const confirmBanner = document.getElementById('confirmBanner');
  const confirmMsg = document.getElementById('confirmMsg');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const emptyTask = document.getElementById('emptyTask');
  const logArea = document.getElementById('logArea');
  const emptyLogs = document.getElementById('emptyLogs');
  const favoritesSection = document.getElementById('favoritesSection');
  const favoritesChips = document.getElementById('favoritesChips');

  // Tab switching
  window.switchTab = function(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
    document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
    document.getElementById('panel' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Status polling
  async function pollStatus() {
    try {
      const res = await fetch('/health');
      setConnected(res.ok);
    } catch(e) {
      setConnected(false);
    }
  }

  function setConnected(ok) {
    connected = ok;
    connDot.className = 'conn-dot' + (ok ? '' : ' disconnected');
    connText.textContent = ok ? 'Connected' : 'Disconnected';
  }

  function updateStatus(data) {
    const st = data.status || 'idle';
    currentStatus = st;

    // Map agent states to display
    let displayStatus, dotClass;
    if (st === 'idle') {
      displayStatus = 'Idle';
      dotClass = 'idle';
    } else if (st === 'waiting_confirm') {
      displayStatus = 'Confirming';
      dotClass = 'confirming';
    } else if (st === 'paused') {
      displayStatus = 'Paused for you';
      dotClass = 'confirming';
    } else {
      displayStatus = 'Running';
      dotClass = 'running';
    }

    statusDot.className = 'status-dot ' + dotClass;
    statusText.textContent = displayStatus;

    // Show/hide the pause banner: a task paused for the user (sign-in, 2FA,
    // CAPTCHA). Same answers as the on-screen pill.
    const pause = data.pause || null;
    paused = !!pause;
    if (pause) {
      confirmMsg.textContent = '⏸ ' + pause.message;
      document.getElementById('approveBtn').textContent = '▶ Resume';
      document.getElementById('rejectBtn').textContent = '⏹ End task';
      confirmBanner.classList.add('visible');
    } else {
      confirmBanner.classList.remove('visible');
    }

    // Show current step info
    if (data.currentTask && (st !== 'idle')) {
      const info = data.currentTask + (data.currentStep ? ' — ' + data.currentStep : '');
      document.title = '⚡ ' + info + ' | Clawd Cursor';
    } else {
      document.title = '🐾 Clawd Cursor Dashboard';
    }
  }

  // Send task: the built-in agent loop was removed, so the form only says so.
  window.sendTask = function() {
    responseCard.classList.add('visible');
    responseText.textContent = 'Removed: clawdcursor no longer runs tasks itself. ' +
      'Drive its MCP tools from your own agent (Claude Code, Codex, Cursor).';
  };

  // Answer a pause (POST /resume): Resume or End task.
  let paused = false;
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

  // History
  function addHistory(task, result) {
    taskHistory.unshift({ task, result, time: new Date().toLocaleTimeString() });
    renderHistory();
  }

  function updateHistoryResult(task, result) {
    const item = taskHistory.find(h => h.task === task);
    if (item) item.result = result;
    renderHistory();
  }

  function renderHistory() {
    if (taskHistory.length === 0) {
      historySection.style.display = 'none';
      return;
    }
    historySection.style.display = 'block';
    historyList.innerHTML = taskHistory.map(function(h, idx) {
      var isFav = favorites.indexOf(h.task) !== -1;
      var starIcon = isFav ? '⭐' : '☆';
      return '<li class="history-item">' +
        '<button class="star-btn" onclick="toggleStar(' + idx + ')" title="' + (isFav ? 'Unstar' : 'Star') + '">' + starIcon + '</button>' +
        '<div class="history-content">' +
          '<span class="task-text">' + escHtml(h.task) + '</span>' +
          '<span class="task-time">' + escHtml(h.time) + '</span>' +
          '<div class="task-result">' + escHtml(h.result) + '</div>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  // Favorites
  async function loadFavorites() {
    try {
      // v0.9 PR7.3: favorites_list replaces GET /favorites.
      var data = await toolCall('favorites_list', {});
      if (Array.isArray(data)) {
        favorites = data;
        renderFavorites();
        renderHistory();
      }
    } catch(e) { /* ignore */ }
  }

  function renderFavorites() {
    if (favorites.length === 0) {
      favoritesSection.classList.remove('visible');
      return;
    }
    favoritesSection.classList.add('visible');
    favoritesChips.innerHTML = favorites.map(function(fav) {
      return '<div class="fav-chip" title="Click to run: ' + escHtml(fav) + '">' +
        '<span class="fav-text" onclick="runFavorite(this)">' + escHtml(fav) + '</span>' +
        '<button class="fav-remove" onclick="event.stopPropagation();removeFavorite(this)" title="Remove from favorites">&times;</button>' +
      '</div>';
    }).join('');
  }

  function looksLikeCredential(text) {
    // NOTE: this code lives inside an outer JS template literal, so single
    // backslashes get stripped at parse time (\\s in source → s at runtime).
    // To preserve a literal backslash for the inner regex, we double-escape.
    var patterns = [
      /sk-[a-zA-Z0-9_-]{20,}/,                        // OpenAI / generic API keys (incl. sk-proj-)
      /sk-ant-[a-zA-Z0-9-]{20,}/,                      // Anthropic keys
      /sk_(?:live|test)_[a-zA-Z0-9]{20,}/,             // Stripe secret keys
      /rk_(?:live|test)_[a-zA-Z0-9]{20,}/,             // Stripe restricted keys
      /gh[posru]_[A-Za-z0-9_]{30,}/,                   // GitHub PAT (ghp_, gho_, ghu_, ghs_, ghr_)
      /xox[abprs]-[A-Za-z0-9-]{10,}/,                  // Slack tokens
      /AKIA[0-9A-Z]{16}/,                              // AWS access key id
      /ya29\\.[A-Za-z0-9_-]{20,}/,                     // Google OAuth access token
      /eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\./,      // JWT (header.payload.…)
      /password\\s*[:=]\\s*\\S+/i,                    // password: xxx
      /secret\\s*[:=]\\s*\\S+/i,                      // secret: xxx
      /token\\s*[:=]\\s*\\S+/i,                       // token: xxx
      /api[_-]?key\\s*[:=]\\s*\\S+/i,                 // api_key: xxx
      /Bearer\\s+[a-zA-Z0-9._-]{20,}/                 // Bearer tokens
    ];
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) return true;
    }
    return false;
  }

  window.toggleStar = async function(idx) {
    var item = taskHistory[idx];
    if (!item) return;
    var isFav = favorites.indexOf(item.task) !== -1;

    // When starring, check for credentials
    if (!isFav && looksLikeCredential(item.task)) {
      var msg = '🔒 This task may contain sensitive info (API key, password, or token).\\n\\n' +
        'Starred commands are saved locally in .clawdcursor-favorites.json on your machine — ' +
        'never sent over the network. Your credentials stay secure on your device.\\n\\n' +
        'Star this command anyway?';
      if (!confirm(msg)) return;
    }

    try {
      // v0.9 PR7.3: favorites_add / favorites_remove replace POST/DELETE /favorites.
      var data = await toolCall(
        isFav ? 'favorites_remove' : 'favorites_add',
        { task: item.task }
      );
      favorites = (data && data.favorites) || [];
      renderFavorites();
      renderHistory();
    } catch(e) {
      console.error('Failed to toggle star:', e);
    }
  };

  window.runFavorite = function(el) {
    var text = el.textContent;
    taskInput.value = text;
    sendTask();
  };

  window.removeFavorite = async function(el) {
    var chip = el.parentElement;
    var text = chip.querySelector('.fav-text').textContent;
    try {
      // v0.9 PR7.3: favorites_remove replaces DELETE /favorites.
      var data = await toolCall('favorites_remove', { task: text });
      favorites = (data && data.favorites) || [];
      renderFavorites();
      renderHistory();
    } catch(e) {
      console.error('Failed to remove favorite:', e);
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
  loadFavorites();
  pollStatus();
  setInterval(pollStatus, 2000);
  setInterval(pollLogs, 2000);
})();
</script>
</body>
</html>`;
