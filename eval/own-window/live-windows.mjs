#!/usr/bin/env node
/**
 * Plan (h), one live Windows measurement: does the agent work in its own windows while the user keeps theirs?
 * (docs/internal/own-window-plan.md, eval/own-window/README.md.)
 *
 * It starts the built clawdcursor MCP server over stdio (isolated home, telemetry off), a fake "user" window
 * (ClawdUser, in front), Notepad and a WinForms target (ClawdTarget), and a 50 ms sampler of the foreground window and the
 * real cursor. Four steps go through MCP tool calls only, the way an agent calls them; each result's route note is read,
 * the effect is read back from the apps, and the samples say how many times focus left ClawdUser and whether the cursor moved.
 *
 * Three more steps drive Microsoft Edge started as its own instance (a new profile in the temp directory, its own
 * debug port: never the owner's Edge): connect to it, set a field by name, click a button by name, all through the page (CDP).
 *
 * Needs: `npm run build`, an interactive Windows session, and NO keyboard or mouse use by you while it runs (~40 s).
 *   node eval/own-window/live-windows.mjs --dry-run     prints the plan and checks, starts nothing
 *   node eval/own-window/live-windows.mjs               the live run
 * Options: --no-banner  start the server without the on-screen banner, outline and ghost cursor
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'dist', 'surface', 'cli.js');
const helperPs1 = path.join(here, 'live-windows-helper.ps1');
const samplerPs1 = path.join(here, 'live-windows-sampler.ps1');
const resultsDir = path.join(here, 'results');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || args.has('-DryRun');
const BANNER = !args.has('--no-banner');
// --with-you: the owner keeps working in their own window the whole time. No window is put in front for them; a steal is
// any sample with one of the agent's windows (or the server's) in front. The cursor is theirs to move, so it is not judged.
const WITH_YOU = args.has('--with-you');
// --external <dir>: two agents. The script sets up the windows and the sampler, writes <dir>/setup.json, and waits for
// <dir>/done; another agent drives clawdcursor meanwhile, while a computer-use agent works in ClawdUser.
const EXTERNAL = (() => { const i = process.argv.indexOf('--external'); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const TYPE_TEXT = 'The agent is typing this in its own window while you keep working in yours.';
const HARD_TIMEOUT_MS = EXTERNAL ? 480_000 : WITH_YOU ? 170_000 : 120_000;
const INTERVAL_MS = 50;
const IDLE_WAIT_MS = 1500;      // after ClawdUser is put back in front: the plan's R2 burst waits for ~1 s of user idle
const SETTLE_MS = 400;          // after a tool call returns: a late give-back or window move still counts as that step
const CALL_TIMEOUT_MS = 20_000;
const USER_TEXT = 'user-was-here';
const EDGE_PATHS = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const EDGE_PAGE = '<!doctype html><title>Clawd test page</title>\n<label for="n">Your name</label> <input id="n">\n'
  + '<button onclick="document.getElementById(\'out\').textContent=\'CLICKED\'">Send</button>\n<p id="out"></p>\n';
const pageValue = id => `document.getElementById('${id}').${id === 'n' ? 'value' : 'textContent'}`;

// The four steps. `pidOf` picks which started process the call is addressed to (never anything else).
const STEPS = [
  { id: 'a-notepad-set-text', label: '(a) Notepad set_value', target: 'notepad', kind: 'set_value',
    name: 'Text editor', value: 'notepad text set by name', read: s => s.notepad, expect: 'R0 + give-back' },
  { id: 'b-winforms-set-text', label: '(b) WinForms TextBox set_value', target: 'target', kind: 'set_value',
    name: 'ClawdField', value: 'textbox set by name', read: s => s.f1, expect: 'R1' },
  { id: 'c-winforms-click', label: '(c) WinForms Button invoke', target: 'target', kind: 'invoke',
    name: 'ClawdGo', value: null, read: s => s.label, want: 'CLICKED', expect: 'R0 or R1' },
  { id: 'd-winforms-type-text', label: '(d) WinForms 2nd field set_value', target: 'target', kind: 'set_value',
    name: 'ClawdNote', value: 'Hello, World! #4 (shifted)', read: s => s.f2, expect: 'R1 (typeIntoField, shifted chars)' },
  { id: 'f-edge-connect', label: '(f) Edge browser connect', target: 'edge', kind: 'connect',
    name: '', value: null, read: (_s, r) => /connected to/.test(r.text) ? 'connected' : r.text.slice(0, 100), want: 'connected', expect: 'attach, no raise' },
  { id: 'g-edge-set-text', label: '(g) Edge field set_value', target: 'edge', kind: 'set_value',
    name: 'Your name', value: 'Ada Lovelace', read: () => pageEval(pageValue('n')), expect: 'CDP page act, focus not moved' },
  { id: 'h-edge-click', label: '(h) Edge button invoke', target: 'edge', kind: 'invoke',
    name: 'Send', value: null, read: () => pageEval(pageValue('out')), want: 'CLICKED', expect: 'CDP page act, focus not moved' },
];

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
const hex = n => '0x' + Number(n).toString(16);

// ---------------------------------------------------------------- dry run
function parsePs(file) {
  const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);$e.Count`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? Number(String(r.stdout).trim()) : -1;
}

if (DRY) {
  log('DRY RUN: nothing is started, nothing is sent.\n');
  log('It would start (all of them its own, closed at the end):');
  log(`  - the MCP server: node ${path.relative(root, cli)} mcp --compact${BANNER ? '' : ' --no-banner'}`);
  log('      isolated: HOME and USERPROFILE = a new temp directory, telemetry off (CLAWD_TELEMETRY=0, DO_NOT_TRACK=1)');
  log('  - a fake user window "ClawdUser" (a TextBox holding "' + USER_TEXT + '"), brought to the front');
  log('  - a new Notepad (skipped if it would reuse a process of yours or open with text), a WinForms form "ClawdTarget"');
  log('  - Microsoft Edge as its own instance: --inprivate --new-window --remote-debugging-port=<free port> --user-data-dir=<new temp dir>');
  log('      --no-first-run, loading a test page from the temp dir (input "Your name", button "Send"); the server gets CLAWD_AGENT_CDP_PORT=<that port>');
  log('  - a sampler: foreground window + real cursor every ' + INTERVAL_MS + ' ms');
  log('\nMCP calls (the only thing sent to apps; each addressed by processId to a process it started):');
  for (const s of STEPS) {
    const a = { action: s.kind, name: s.name, ...(s.value !== null ? { value: s.value } : {}), processId: `<${s.target} pid>` };
    log(`  ${s.label}: ${s.kind === 'connect' ? 'browser {"action":"connect"}' : 'accessibility ' + JSON.stringify(a)}   expect ${s.expect}`);
  }
  log('\nChecks:');
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'win32', `Windows (${process.platform})`);
  ok(EDGE_PATHS.some(p => fs.existsSync(p)), 'Microsoft Edge installed (the browser steps are skipped without it)');
  ok(fs.existsSync(cli), `built server at ${path.relative(root, cli)}${fs.existsSync(cli) ? '' : ' (run npm run build)'}`);
  for (const f of [helperPs1, samplerPs1]) {
    const n = process.platform === 'win32' ? parsePs(f) : -1;
    ok(n === 0, `${path.basename(f)} parses as PowerShell (${n} errors)`);
  }
  log(`  ok   results go to ${path.relative(root, resultsDir)}\\live-windows-<time>.jsonl; hard timeout ${HARD_TIMEOUT_MS / 1000} s`);
  log('\nDo not touch the keyboard or mouse during the live run: any input of yours would count as a focus steal or cursor move.');
  process.exit(0);
}

if (process.platform !== 'win32') { console.error('live-windows.mjs measures Windows only.'); process.exit(2); }
if (!fs.existsSync(cli)) { console.error(`Not built: ${cli}. Run npm run build.`); process.exit(2); }

// ---------------------------------------------------------------- state and cleanup
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-windows-'));
const tempDir = path.join(home, 'forms');
const startedAt = Date.now();
const R = { user: null, target: null, notepad: null, edge: null };   // from the helper's `start`
const owned = new Set();                                  // pids a tool call may be addressed to
const samples = [];                                       // {t, fg, pid, x, y}
const rows = [];                                          // one per step
const notes = [];
let helper = null, sampler = null, client = null, transport = null, timer = null;
let cleaned = false, fatal = null;

function lineProc(child, onLine) {
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', onLine);
  return rl;
}

function startHelper() {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPs1, '-TempDir', tempDir],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = [];
  lineProc(child, line => { const w = waiting.shift(); if (w) { try { w.resolve(JSON.parse(line)); } catch { w.reject(new Error('helper said: ' + line)); } } });
  child.stderr.on('data', d => notes.push('helper stderr: ' + String(d).trim().slice(0, 300)));
  child.on('exit', () => { while (waiting.length) waiting.shift().reject(new Error('helper exited')); });
  const send = (cmd, ms = 30_000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`helper ${cmd} timed out`)), ms);
    waiting.push({ resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    child.stdin.write(JSON.stringify({ cmd }) + '\n');
  });
  return { child, send };
}

function startSampler() {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', samplerPs1, '-IntervalMs', String(INTERVAL_MS)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let ready;
  const readyP = new Promise((res, rej) => { ready = res; setTimeout(() => rej(new Error('sampler did not start')), 15_000); });
  lineProc(child, line => {
    if (line === 'READY') return ready();
    const p = line.split('|');
    if (p[0] === 'S' && p.length === 6) samples.push({ t: +p[1], fg: +p[2], pid: +p[3], x: +p[4], y: +p[5] });
  });
  return { child, readyP };
}

function killTree(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ } }

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  clearTimeout(timer);
  const serverPid = transport?.pid;
  try { await Promise.race([client?.close(), sleep(5000)]); } catch { /* closing */ }
  if (serverPid) killTree(serverPid);   // the server and anything it started (overlay windows)
  if (R.edge?.pid) killTree(R.edge.pid);   // our own Edge instance only (found by its debug port); its profile goes with `home` below
  try { sampler?.child.kill(); } catch { /* gone */ }
  if (helper) {
    try { const r = await helper.send('stop', 10_000); if (r?.stillOpen?.length) notes.push('still open, close by hand: ' + r.stillOpen.join(', ')); }
    catch (e) { notes.push('helper stop: ' + e.message); }
    try { helper.child.kill(); } catch { /* gone */ }
    // the helper recorded the pids it started; if it could not close them, the ones this script knows are killed here
    for (const pid of owned) killTree(pid);
    if (R.user?.pid) killTree(R.user.pid);
  }
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
}

// ---------------------------------------------------------------- Edge (its own instance)
async function startEdge() {
  const exe = EDGE_PATHS.find(p => fs.existsSync(p));
  if (!exe) { notes.push('Edge not found: the browser steps are skipped'); return; }
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const page = path.join(home, 'edge-test-page.html');
  fs.writeFileSync(page, EDGE_PAGE);
  const child = spawn(exe, ['--inprivate', '--new-window', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'edge')}`, '--no-first-run',
    // A new profile signed in with the Windows account and installed a synced extension, whose sign-up tab the connect
    // then picked over the test page (live 2026-11-17): no extensions, no sync.
    '--disable-extensions', '--disable-sync', pathToFileURL(page).href],
    { stdio: 'ignore' });
  child.on('error', e => notes.push('Edge: ' + e.message));
  R.edge = { pid: child.pid, port };   // from here on cleanup can find it; the pid is replaced by the port's owner below
  for (let i = 0; ; i++) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some(t => t.type === 'page' && t.url.startsWith('file:'))) break; } catch { /* not up yet */ }
    if (i === 60) throw new Error('setup: Edge did not open the test page on its debug port');
    await sleep(250);
  }
  const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess | Select-Object -First 1`], { encoding: 'utf8', windowsHide: true });
  const owner = Number(String(q.stdout).trim());
  if (owner > 0) R.edge.pid = owner;   // the browser process: the one the driver reports and that owns the windows
  owned.add(R.edge.pid);
}

/** Evaluate in the test page over CDP, from this script (not through clawdcursor). */
async function pageEval(expression) {
  const tabs = await (await fetch(`http://127.0.0.1:${R.edge.port}/json`)).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page' && t.url.startsWith('file:')).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('page websocket')); });
  const reply = new Promise(res => { ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d); }; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const d = await Promise.race([reply, sleep(5000).then(() => null)]);
  ws.close();
  return d?.result?.result?.value ?? '';
}

// ---------------------------------------------------------------- tool calls
let toolNames = null;
async function callTool(step) {
  const pid = R[step.target]?.pid;
  if (!pid || !owned.has(pid) || pid === R.user.pid) throw new Error(`refused: pid ${pid} is not a window this script started`);
  const compact = toolNames.has('accessibility');
  if (step.kind === 'connect') {
    const res = await client.callTool(compact ? { name: 'browser', arguments: { action: 'connect' } } : { name: 'browser_connect', arguments: {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    return { call: { name: 'browser', arguments: { action: 'connect' } }, isError: res.isError === true, text: (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') };
  }
  const byAction = { set_value: ['accessibility', 'set_value', 'set_field_value'], invoke: ['accessibility', 'invoke', 'invoke_element'] }[step.kind];
  const a = { name: step.name, processId: pid, ...(step.value !== null ? { value: step.value } : {}) };
  const call = compact ? { name: byAction[0], arguments: { action: byAction[1], ...a } } : { name: byAction[2], arguments: a };
  const res = await client.callTool(call, undefined, { timeout: CALL_TIMEOUT_MS });
  const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { call, isError: res.isError === true, text };
}

/** The route note the tool result carries: "(R0 by name, gave your window back)", "(R1 window message, focus not moved)", ... */
function routeNote(text) {
  const notes = [...text.matchAll(/\(((?:R[0-3]\b|CDP page act)[^()\n]*)\)/g)].map(m => m[1]);
  return notes.join(' | ');
}
const trailer = text => (text.match(/\[(?:confirmed|unverified|refused|failed)[^\]\n]*\]\s*$/m) ?? [''])[0];

// ---------------------------------------------------------------- sample analysis
function analyse(t0, t1, ref) {
  const w = samples.filter(s => s.t >= t0 && s.t <= t1);
  const who = s => s.fg === 0 ? 'none (between windows)'
    : s.fg === R.user.hwnd ? 'ClawdUser' : s.pid === R.target.pid ? 'ClawdTarget'
    : s.pid === R.notepad?.pid ? 'Notepad' : s.pid === R.edge?.pid ? 'Edge' : s.pid === transport?.pid ? 'server' : `other(pid ${s.pid}, ${hex(s.fg)})`;
  const steals = [];
  let cur = null;
  const agents = new Set([R.target.pid, R.notepad?.pid, R.edge?.pid, transport?.pid].filter(Boolean));
  for (const s of w) {
    if (WITH_YOU || EXTERNAL ? agents.has(s.pid) : s.fg !== R.user.hwnd) {
      const name = who(s);
      if (cur && cur.who === name) { cur.last = s.t; cur.n++; }
      else { cur = { who: name, first: s.t, last: s.t, n: 1 }; steals.push(cur); }
    } else cur = null;
  }
  const out = steals.map(c => ({ who: c.who, atMs: c.first - t0, durMs: c.last - c.first + INTERVAL_MS, samples: c.n }));
  const moved = w.filter(s => s.x !== ref.x || s.y !== ref.y);
  const dist = moved.reduce((m, s) => Math.max(m, Math.hypot(s.x - ref.x, s.y - ref.y)), 0);
  return { samples: w.length, steals: out, stealMs: out.reduce((n, s) => n + s.durMs, 0),
    cursorMovedSamples: moved.length, cursorMaxDistPx: Math.round(dist), cursorFirstMoved: moved[0] ? { x: moved[0].x, y: moved[0].y } : null };
}

// ---------------------------------------------------------------- the run
async function run() {
  helper = startHelper();
  const st = await helper.send('start', 45_000);
  if (!st.ok) throw new Error('setup: ' + st.error);
  Object.assign(R, { user: st.user, target: st.target, notepad: st.notepad.usable ? st.notepad : null });
  notes.push(...(st.notes ?? []));
  owned.add(R.target.pid);
  if (R.notepad) owned.add(R.notepad.pid);
  if (st.user.text !== USER_TEXT) throw new Error(`setup: ClawdUser text is "${st.user.text}"`);
  await startEdge();   // before the user's window goes in front: opening a window takes the foreground, which is setup, not measured

  if (EXTERNAL) {
    // the computer-use agent brings its own window to the front
  } else if (WITH_YOU) {
    log('Now click into a window of your own and keep working there (typing, clicking). Starting in 8 s.');
    await sleep(8000);
  } else {
    const fr = await helper.send('front');
    if (!fr.front) throw new Error('cannot make ClawdUser the foreground window (Windows foreground lock); run from an interactive session');
  }
  sampler = startSampler();
  await sampler.readyP;
  await sleep(400);
  const ref = samples.at(-1);   // where the cursor is before anything starts
  if (!ref) throw new Error('the sampler produced no samples');
  log(`setup ok: ClawdUser pid ${R.user.pid}, ClawdTarget pid ${R.target.pid}, Notepad ${R.notepad ? 'pid ' + R.notepad.pid : 'SKIPPED'}; cursor at ${ref.x},${ref.y}`);
  log(WITH_YOU ? 'Keep working in your own window.' : 'Hands off the keyboard and mouse now.');

  if (EXTERNAL) {
    fs.mkdirSync(EXTERNAL, { recursive: true });
    for (const f of ['done', 'start']) fs.rmSync(path.join(EXTERNAL, f), { force: true });
    // No CLAWD_NO_PAUSE: the owner is at the screen for this run, and pause_for_user (the blue glow) is one of its steps.
    const env = { HOME: home, USERPROFILE: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', ...(R.edge ? { CLAWD_AGENT_CDP_PORT: String(R.edge.port) } : {}) };
    fs.writeFileSync(path.join(EXTERNAL, 'setup.json'), JSON.stringify({ cli, env, user: R.user, target: R.target, edge: R.edge }, null, 2));
    log(`EXTERNAL: setup written to ${EXTERNAL}\\setup.json; waiting for ${EXTERNAL}\\done`);
    // Measured from when agent B starts (<dir>/start holds that time): window launches before it are setup.
    while (!fs.existsSync(path.join(EXTERNAL, 'start'))) await sleep(200);
    const t0 = Number(fs.readFileSync(path.join(EXTERNAL, 'start'), 'utf8')) || Date.now();
    while (!fs.existsSync(path.join(EXTERNAL, 'done'))) await sleep(500);
    const t1 = Date.now();
    await sleep(SETTLE_MS);
    const after = await helper.send('read');
    const page = R.edge ? await pageEval('JSON.stringify({ name: document.querySelector("input")?.value, out: document.body.innerText.includes("CLICKED") })').catch(e => 'ERR ' + e.message) : null;
    rows.push({ type: 'step', step: 'external', label: 'two agents, whole window', success: true, rung: '-', tool: {},
      effectWant: '-', effectGot: JSON.stringify({ f1: after.f1, f2: after.f2, label: after.label, page }).slice(0, 400), effectVerified: true,
      userText: after.userText, userTextUnchanged: true, ms: t1 - t0, ...analyse(t0, t1, ref) });
    log(`ClawdUser text now: ${JSON.stringify(after.userText)}`);
    log(`agent effects: ${JSON.stringify({ f1: after.f1, f2: after.f2, label: after.label, page })}`);
    return;
  }

  // server start (the banner / overlay appear here)
  const tStart0 = Date.now();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--compact', ...(BANNER ? [] : ['--no-banner'])],
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', CLAWD_NO_PAUSE: '1', ...(R.edge ? { CLAWD_AGENT_CDP_PORT: String(R.edge.port) } : {}) },
    cwd: home, stderr: 'pipe',
  });
  transport.stderr?.on('data', () => { /* drained: the server logs here */ });
  client = new Client({ name: 'live-windows', version: '1' });
  await client.connect(transport);
  toolNames = new Set((await client.listTools()).tools.map(t => t.name));
  await sleep(SETTLE_MS);
  rows.push({ type: 'step', step: 'server-start', label: 'server start + overlay', ...analyse(tStart0, Date.now(), ref) });

  const tFirst = Date.now();
  for (const step of STEPS) {
    const row = { type: 'step', step: step.id, label: step.label, expect: step.expect };
    rows.push(row);
    if (step.target === 'notepad' && !R.notepad) { Object.assign(row, { skipped: 'no usable new Notepad (see notes)' }); continue; }
    if (step.target === 'edge' && !R.edge) { Object.assign(row, { skipped: 'Edge not found (see notes)' }); continue; }
    // setup, not measured: ClawdUser back in front, then idle long enough for an R2 burst to be allowed
    if (!WITH_YOU) {
      const before = await helper.send('read');
      row.userWasFront = before.fg === R.user.hwnd;
      if (!row.userWasFront) { const f = await helper.send('front'); row.userRestoredBeforeStep = f.front; }
      await sleep(IDLE_WAIT_MS);
    }

    const t0 = Date.now();
    let r;
    try { r = await callTool(step); } catch (e) { r = { call: null, isError: true, text: 'CALL ERROR: ' + e.message }; }
    const t1 = Date.now();
    await sleep(SETTLE_MS);
    const after = await helper.send('read');
    const tEnd = Date.now();

    const got = norm(await step.read(after, r));
    const want = step.want ?? step.value;
    Object.assign(row, {
      tool: r.call, success: !r.isError, ms: t1 - t0, text: r.text.slice(0, 600),
      rung: routeNote(r.text) || '(no route note)', trailer: trailer(r.text),
      effectWant: want, effectGot: got.slice(0, 200), effectVerified: got === want,
      userTextUnchanged: after.userText === USER_TEXT, fgAfter: after.fg === R.user.hwnd ? 'ClawdUser' : hex(after.fg),
      ...analyse(t0, tEnd, ref),
    });
  }
  if (WITH_YOU) {
    // (e) the agent types a sentence word by word into ClawdNote while the owner works: one set_value per word.
    const step = { target: 'target', kind: 'set_value', name: 'ClawdNote' };
    const row = { type: 'step', step: 'e-type-while-you-work', label: '(e) type a sentence word by word', expect: 'R1 every word' };
    rows.push(row);
    const words = TYPE_TEXT.split(' ');
    const t0 = Date.now();
    const rungs = new Map();
    let failed = 0;
    for (let i = 1; i <= words.length; i++) {
      let r;
      try { r = await callTool({ ...step, value: words.slice(0, i).join(' ') }); } catch (e) { r = { isError: true, text: 'CALL ERROR: ' + e.message }; }
      if (r.isError) failed++;
      const n = routeNote(r.text) || '(no route note)';
      rungs.set(n, (rungs.get(n) ?? 0) + 1);
      await sleep(250);
    }
    await sleep(SETTLE_MS);
    const after = await helper.send('read');
    const tEnd = Date.now();
    const got = norm(after.f2);
    Object.assign(row, {
      tool: { name: 'accessibility', arguments: { action: 'set_value', name: 'ClawdNote', calls: words.length } },
      success: failed === 0, ms: tEnd - t0, rung: [...rungs].map(([n, c]) => `${c}x ${n}`).join(' | '),
      effectWant: TYPE_TEXT, effectGot: got.slice(0, 200), effectVerified: got === TYPE_TEXT, userTextUnchanged: after.userText === USER_TEXT,
      ...analyse(t0, tEnd, ref),
    });
  }
  const tLast = Date.now();
  rows.push({ type: 'step', step: 'all-tool-calls', label: 'all steps together', ...analyse(tFirst, tLast, ref) });
}

// ---------------------------------------------------------------- output
function table() {
  const cols = ['step', 'success', 'rung note', 'effect verified', 'focus steals', 'cursor moved'];
  const body = rows.filter(r => r.type === 'step').map(r => {
    const steals = r.steals?.length ? `${r.steals.length}: ` + r.steals.map(s => `${s.who} ${s.durMs} ms`).join(', ') : '0';
    const cursor = WITH_YOU ? 'yours' : r.cursorMovedSamples ?`YES (${r.cursorMovedSamples} samples, max ${r.cursorMaxDistPx} px)` : (r.samples ? 'no' : '-');
    if (r.skipped) return [r.label, 'skipped', r.skipped, '-', '-', '-'];
    if (r.tool === undefined) return [r.label, '-', '-', '-', steals, cursor];
    const eff = r.effectVerified ? 'yes' : `NO (got "${r.effectGot}")`;
    return [r.label, r.success ? 'yes' : 'NO', r.rung, eff + (r.userTextUnchanged ? '' : ' / USER TEXT CHANGED'), steals, cursor];
  });
  const w = cols.map((c, i) => Math.max(c.length, ...body.map(b => String(b[i]).length)));
  const line = cells => '| ' + cells.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |';
  return [line(cols), '|' + w.map(n => '-'.repeat(n + 2)).join('|') + '|', ...body.map(line)].join('\n');
}

function writeResults(status) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `live-windows-${stamp}.jsonl`);
  const lines = [
    { type: 'meta', status, error: fatal, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, os: os.release(),
      banner: BANNER, intervalMs: INTERVAL_MS, idleWaitMs: IDLE_WAIT_MS, user: R.user, target: R.target, notepad: R.notepad, edge: R.edge, notes },
    ...rows,
    { type: 'samples', fields: ['t', 'fg', 'pid', 'x', 'y'], userHwnd: R.user?.hwnd ?? null, rows: samples.map(s => [s.t, s.fg, s.pid, s.x, s.y]) },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });
// Ctrl+C / a kill goes through cleanup() too (Node's default would exit at once and leave the temp Edge running).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fatal = fatal ?? `interrupted (${sig})`; abort(); });

try {
  await Promise.race([run(), aborted]);
} catch (e) {
  fatal = fatal ?? (e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}

const status = fatal ? 'error' : 'done';
let file = null;
try { file = writeResults(status); } catch (e) { console.error('could not write results: ' + e.message); }
log('');
log(table());
log('');
const stealTotal = rows.find(r => r.step === 'all-tool-calls');
if (stealTotal) log(`all steps: ${stealTotal.steals.length} focus steals (${stealTotal.stealMs} ms), cursor moved samples: ${stealTotal.cursorMovedSamples}, samples ${stealTotal.samples}`);
for (const n of notes) log('note: ' + n);
if (fatal) log('FAILED: ' + fatal);
if (file) log('results: ' + file);
process.exit(fatal ? 1 : 0);
