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
 * Needs: `npm run build`, an interactive Windows session, and NO keyboard or mouse use by you while it runs (~30 s).
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
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'dist', 'surface', 'cli.js');
const helperPs1 = path.join(here, 'live-windows-helper.ps1');
const samplerPs1 = path.join(here, 'live-windows-sampler.ps1');
const resultsDir = path.join(here, 'results');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || args.has('-DryRun');
const BANNER = !args.has('--no-banner');
const HARD_TIMEOUT_MS = 90_000;
const INTERVAL_MS = 50;
const IDLE_WAIT_MS = 1500;      // after ClawdUser is put back in front: the plan's R2 burst waits for ~1 s of user idle
const SETTLE_MS = 400;          // after a tool call returns: a late give-back or window move still counts as that step
const CALL_TIMEOUT_MS = 20_000;
const USER_TEXT = 'user-was-here';

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
  log('  - a sampler: foreground window + real cursor every ' + INTERVAL_MS + ' ms');
  log('\nMCP calls (the only thing sent to apps; each addressed by processId to a process it started):');
  for (const s of STEPS) {
    const a = { action: s.kind, name: s.name, ...(s.value !== null ? { value: s.value } : {}), processId: `<${s.target} pid>` };
    log(`  ${s.label}: accessibility ${JSON.stringify(a)}   expect ${s.expect}`);
  }
  log('\nChecks:');
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'win32', `Windows (${process.platform})`);
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
const R = { user: null, target: null, notepad: null };   // from the helper's `start`
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

// ---------------------------------------------------------------- tool calls
let toolNames = null;
async function callTool(step) {
  const pid = R[step.target]?.pid;
  if (!pid || !owned.has(pid) || pid === R.user.pid) throw new Error(`refused: pid ${pid} is not a window this script started`);
  const compact = toolNames.has('accessibility');
  const byAction = { set_value: ['accessibility', 'set_value', 'set_field_value'], invoke: ['accessibility', 'invoke', 'invoke_element'] }[step.kind];
  const a = { name: step.name, processId: pid, ...(step.value !== null ? { value: step.value } : {}) };
  const call = compact ? { name: byAction[0], arguments: { action: byAction[1], ...a } } : { name: byAction[2], arguments: a };
  const res = await client.callTool(call, undefined, { timeout: CALL_TIMEOUT_MS });
  const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { call, isError: res.isError === true, text };
}

/** The route note the tool result carries: "(R0 by name, gave your window back)", "(R1 window message, focus not moved)", ... */
function routeNote(text) {
  const notes = [...text.matchAll(/\((R[0-3]\b[^()\n]*)\)/g)].map(m => m[1]);
  return notes.join(' | ');
}
const trailer = text => (text.match(/\[(?:confirmed|unverified|refused|failed)[^\]\n]*\]\s*$/m) ?? [''])[0];

// ---------------------------------------------------------------- sample analysis
function analyse(t0, t1, ref) {
  const w = samples.filter(s => s.t >= t0 && s.t <= t1);
  const who = s => s.fg === 0 ? 'none (between windows)'
    : s.fg === R.user.hwnd ? 'ClawdUser' : s.pid === R.target.pid ? 'ClawdTarget'
    : s.pid === R.notepad?.pid ? 'Notepad' : s.pid === transport?.pid ? 'server' : `other(pid ${s.pid}, ${hex(s.fg)})`;
  const steals = [];
  let cur = null;
  for (const s of w) {
    if (s.fg !== R.user.hwnd) {
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

  const fr = await helper.send('front');
  if (!fr.front) throw new Error('cannot make ClawdUser the foreground window (Windows foreground lock); run from an interactive session');
  sampler = startSampler();
  await sampler.readyP;
  await sleep(400);
  const ref = samples.at(-1);   // where the cursor is before anything starts
  if (!ref) throw new Error('the sampler produced no samples');
  log(`setup ok: ClawdUser pid ${R.user.pid}, ClawdTarget pid ${R.target.pid}, Notepad ${R.notepad ? 'pid ' + R.notepad.pid : 'SKIPPED'}; cursor at ${ref.x},${ref.y}`);
  log('Hands off the keyboard and mouse now.');

  // server start (the banner / overlay appear here)
  const tStart0 = Date.now();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--compact', ...(BANNER ? [] : ['--no-banner'])],
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', CLAWD_NO_PAUSE: '1' },
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
    // setup, not measured: ClawdUser back in front, then idle long enough for an R2 burst to be allowed
    const before = await helper.send('read');
    row.userWasFront = before.fg === R.user.hwnd;
    if (!row.userWasFront) { const f = await helper.send('front'); row.userRestoredBeforeStep = f.front; }
    await sleep(IDLE_WAIT_MS);

    const t0 = Date.now();
    let r;
    try { r = await callTool(step); } catch (e) { r = { call: null, isError: true, text: 'CALL ERROR: ' + e.message }; }
    const t1 = Date.now();
    await sleep(SETTLE_MS);
    const after = await helper.send('read');
    const tEnd = Date.now();

    const got = norm(step.read(after));
    const want = step.want ?? step.value;
    Object.assign(row, {
      tool: r.call, success: !r.isError, ms: t1 - t0, text: r.text.slice(0, 600),
      rung: routeNote(r.text) || '(no route note)', trailer: trailer(r.text),
      effectWant: want, effectGot: got.slice(0, 200), effectVerified: got === want,
      userTextUnchanged: after.userText === USER_TEXT, fgAfter: after.fg === R.user.hwnd ? 'ClawdUser' : hex(after.fg),
      ...analyse(t0, tEnd, ref),
    });
  }
  const tLast = Date.now();
  rows.push({ type: 'step', step: 'all-tool-calls', label: 'all four steps together', ...analyse(tFirst, tLast, ref) });
}

// ---------------------------------------------------------------- output
function table() {
  const cols = ['step', 'success', 'rung note', 'effect verified', 'focus steals', 'cursor moved'];
  const body = rows.filter(r => r.type === 'step').map(r => {
    const steals = r.steals?.length ? `${r.steals.length}: ` + r.steals.map(s => `${s.who} ${s.durMs} ms`).join(', ') : '0';
    const cursor = r.cursorMovedSamples ? `YES (${r.cursorMovedSamples} samples, max ${r.cursorMaxDistPx} px)` : (r.samples ? 'no' : '-');
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
      banner: BANNER, intervalMs: INTERVAL_MS, idleWaitMs: IDLE_WAIT_MS, user: R.user, target: R.target, notepad: R.notepad, notes },
    ...rows,
    { type: 'samples', fields: ['t', 'fg', 'pid', 'x', 'y'], userHwnd: R.user?.hwnd ?? null, rows: samples.map(s => [s.t, s.fg, s.pid, s.x, s.y]) },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });

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
