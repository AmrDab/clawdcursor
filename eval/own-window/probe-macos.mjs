#!/usr/bin/env node
/**
 * Plan (h) step 1, macOS: while a fake "user" window (ClawdUser, our own Cocoa window) stays in front, which apps accept
 * input addressed to a BACKGROUND app? Measurement only; no product code. (docs/internal/own-window-plan.md, README.md "macOS".)
 *
 * Targets (each skipped with a reason if missing; everything is started by this script and closed at the end):
 *   native    our own Cocoa window ClawdTarget (a text field, buttons ClawdGo / ClawdReset, a status label): the baseline
 *   textedit  a new TextEdit INSTANCE on a temp .txt file (never the owner's TextEdit windows)
 *   chrome    Chrome with a temp --user-data-dir, incognito, its own debug port, a local test page (never the owner's Chrome)
 *   safari    a new PRIVATE window (File > New Private Window), a local test page. Skipped if Safari is already running.
 * Notes is not probed: it would touch the owner's notes.
 *
 * Methods:  M0 AX setValue (AXValue) | M1 AXPress | M2 CGEventPostToPid keys (one unicode event per char, so '@' and '!' go)
 *           M3 CGEventPostToPid mouse click | M4 AppleScript `tell application ... to set ...` | M5 CDP (Chrome only)
 * For every method: did the effect land (read back), did the frontmost app change (sampled every 50 ms), did the real cursor
 * move, did the ClawdUser text change.
 *
 *   node eval/own-window/probe-macos.mjs --dry-run     plan and checks; launches nothing
 *   node eval/own-window/probe-macos.mjs               the run (~2 min); hands off keyboard and mouse
 *   node eval/own-window/probe-macos.mjs --targets native,textedit
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, PAGE, helperSwift, sleep, compileHelper, makeH, launchWin, startSampler, startChrome, cdp } from './macos-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, 'results');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const TARGETS = (() => { const i = args.indexOf('--targets'); return i >= 0 ? args[i + 1].split(',') : ['native', 'textedit', 'chrome', 'safari']; })();
const TEXT = 'hello@1!';
const USER_TEXT = 'user-was-here';
const TEXTEDIT = '/System/Applications/TextEdit.app';
const HARD_TIMEOUT_MS = 300_000;
const log = (...a) => console.log(...a);
const norm = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
const osa = (...lines) => spawnSync('osascript', lines.flatMap(l => ['-e', l]), { encoding: 'utf8', timeout: 20_000 });
const osaErr = r => r.status === 0 ? null : String(r.stderr).trim().slice(0, 200);

const ALL = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'];
const WHAT = { M0: 'AX setValue (text)', M1: 'AXPress (click)', M2: 'CGEventPostToPid keys (text)', M3: 'CGEventPostToPid mouse (click)', M4: 'AppleScript (text)', M5: 'CDP insertText + mouse (Chrome)' };

if (DRY) {
  log('DRY RUN: nothing is launched, nothing is sent.\n');
  log('It would start (all of them its own, closed at the end):');
  log('  - the Swift helper, compiled with swiftc into a temp directory (eval/own-window/macos-helper.swift)');
  log('  - a fake user window "ClawdUser" (a text field holding "' + USER_TEXT + '"), put in front before every method');
  log('  - a frontmost-app + cursor sampler every 50 ms');
  if (TARGETS.includes('native')) log('  - native: our own window "ClawdTarget" (field, ClawdGo, ClawdReset, status label)');
  if (TARGETS.includes('textedit')) log('  - textedit: a NEW TextEdit instance (NSWorkspace, createsNewApplicationInstance) on a temp .txt file');
  if (TARGETS.includes('chrome')) log('  - chrome: ' + CHROME + ' --incognito --user-data-dir=<temp> --remote-debugging-port=<free> --force-renderer-accessibility, page from a local http server');
  if (TARGETS.includes('safari')) log('  - safari: Safari (only if not running), File > New Private Window through System Events, the page opened by AppleScript');
  log('\nMethods per target:');
  for (const m of ALL) log(`  ${m}  ${WHAT[m]}`);
  log('\nChecks:');
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'darwin', `macOS (${process.platform})`);
  ok(spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0, 'swiftc on PATH (xcode-select --install)');
  ok(fs.existsSync(helperSwift), 'macos-helper.swift present');
  ok(fs.existsSync(TEXTEDIT), 'TextEdit installed');
  ok(fs.existsSync(CHROME), 'Google Chrome installed (the chrome target is skipped without it)');
  ok(fs.existsSync('/Applications/Safari.app') || fs.existsSync('/System/Cryptexes/App/System/Applications/Safari.app'), 'Safari installed');
  ok(typeof WebSocket === 'function', `global WebSocket (node ${process.version}; needs node 22+ for the Chrome CDP method)`);
  log(`  ok   results go to ${path.relative(process.cwd(), resultsDir)}/macos-<time>.jsonl; hard timeout ${HARD_TIMEOUT_MS / 1000} s`);
  log('\nPermissions for the terminal that runs it: Accessibility (required), Automation for System Events / TextEdit / Safari (asked on first use).');
  log('Do not touch the keyboard or mouse during the run.');
  process.exit(0);
}
if (process.platform !== 'darwin') { console.error('probe-macos.mjs measures macOS only (use --dry-run elsewhere).'); process.exit(2); }

// ---------------------------------------------------------------- state
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-macos-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const samples = [];
const rows = [];       // type:"method" lines
const targets = [];    // type:"target" lines
const notes = [];
const owned = new Set();   // pids a delivery may be addressed to
let H, h, sampler = null, user = null, cleanups = [], fatal = null;

/** A helper call addressed to one of our own pids (never the user window); throws on failure. */
function D(cmd, pid, ...rest) {
  if (!owned.has(pid) || pid === user?.pid) throw new Error(`refused: pid ${pid} is not an app this script started`);
  const r = h(cmd, pid, ...rest);
  if (!r.ok) throw new Error(r.err);
  return r.value;
}

async function front() {
  for (let i = 0; i < 3; i++) {
    h('activate', user.pid);
    for (let j = 0; j < 10; j++) {
      await sleep(150);
      if (Number(String(h('frontmost').value).split('|')[0]) === user.pid) return true;
    }
    osa(`tell application "System Events" to set frontmost of (first process whose unix id is ${user.pid}) to true`);
  }
  return false;
}

// ---------------------------------------------------------------- targets: each returns {name, pid, readText, readLabel, reset, methods:[{id, kind, run}], teardown} or {skip}
const axText = pid => () => D('getvalue', pid);
const axLabel = pid => () => D('getlabel', pid);
const axReset = pid => async () => { try { D('press', pid, 'Reset'); } catch { /* no reset button */ } try { D('setvalue', pid, ''); } catch { /* read-only */ } };
const keys = pid => async () => { D('key', pid, TEXT); };
const clickBtn = pid => async () => { const [x, y] = D('center', pid, 'Send').split(',').map(Number); D('click', pid, x, y); };

async function setupNative() {
  const w = await launchWin(H, 'target');
  owned.add(w.pid);
  const pid = w.pid;
  const click = async () => { const [x, y] = D('center', pid, 'ClawdGo').split(',').map(Number); D('click', pid, x, y); };
  return { name: 'native (own Cocoa window)', pid, readText: axText(pid), readLabel: axLabel(pid), reset: axReset(pid),
    methods: [
      { id: 'M0', kind: 'text', run: async () => { D('setvalue', pid, TEXT); } },
      { id: 'M1', kind: 'click', run: async () => { D('press', pid, 'ClawdGo'); } },
      { id: 'M2', kind: 'text', run: keys(pid) },
      { id: 'M3', kind: 'click', run: click },
    ],
    teardown: async () => { w.child.kill(); } };
}

async function setupTextEdit() {
  if (!fs.existsSync(TEXTEDIT)) return { skip: 'TextEdit not found' };
  const file = path.join(tmp, `probe-${Date.now()}.txt`);
  fs.writeFileSync(file, '');
  const r = h('launch', TEXTEDIT, file);
  if (!r.ok) return { skip: 'could not launch a new TextEdit instance: ' + r.err };
  const pid = r.value;
  owned.add(pid);
  const base = path.basename(file);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { ready = h('getvalue', pid).ok; if (!ready) await sleep(250); }
  const teardown = async () => { h('quit', pid); };
  if (!ready) { await teardown(); return { skip: 'the new TextEdit window never showed a text area to Accessibility' }; }
  const asReset = () => osa(`tell application "TextEdit" to set text of document "${base}" to ""`);
  return { name: 'TextEdit (new instance)', pid, readText: axText(pid), readLabel: async () => '',
    reset: async () => { await axReset(pid)(); if (D('getvalue', pid) !== '') asReset(); },
    methods: [
      { id: 'M0', kind: 'text', run: async () => { D('setvalue', pid, TEXT); } },
      { id: 'M4', kind: 'text', run: async () => { const e = osaErr(osa(`tell application "TextEdit" to set text of document "${base}" to "${TEXT}"`)); if (e) throw new Error(e); } },
      { id: 'M2', kind: 'text', run: keys(pid) },
    ],
    teardown };
}

async function setupChrome() {
  const c = await startChrome(tmp);
  if (c.skip) return c;
  owned.add(c.pid);
  const ev = e => cdp(c.port, [['Runtime.evaluate', { expression: e, returnByValue: true }]]);
  return { name: 'Chrome (temp profile, incognito)', pid: c.pid,
    readText: async () => (await ev("document.getElementById('n').value")) ?? '',
    readLabel: async () => (await ev("document.getElementById('out').textContent")) ?? '',
    reset: async () => { await ev("document.getElementById('n').value='';document.getElementById('out').textContent='';document.getElementById('n').focus()"); },
    methods: [
      { id: 'M0', kind: 'text', run: async () => { D('setvalue', c.pid, TEXT); } },
      { id: 'M1', kind: 'click', run: async () => { D('press', c.pid, 'Send'); } },
      { id: 'M2', kind: 'text', run: keys(c.pid) },
      { id: 'M3', kind: 'click', run: clickBtn(c.pid) },
      { id: 'M5', kind: 'text', run: async () => { await cdp(c.port, [['Runtime.evaluate', { expression: "document.getElementById('n').focus()" }], ['Input.insertText', { text: TEXT }]]); } },
      { id: 'M5', kind: 'click', run: async () => {
        const p = JSON.parse(await ev("(()=>{const r=document.getElementById('s').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"));
        const m = { x: p.x, y: p.y, button: 'left', clickCount: 1 };
        await cdp(c.port, [['Input.dispatchMouseEvent', { type: 'mousePressed', ...m }], ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...m }]]);
      } },
    ],
    teardown: c.stop };
}

async function setupSafari() {
  if (spawnSync('pgrep', ['-x', 'Safari']).status === 0) return { skip: 'Safari is already running (its windows are yours; close it to include it)' };
  const server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let winId = null;
  const teardown = async () => {
    if (winId) osa(`tell application "Safari" to close (window id ${winId})`);
    osa('tell application "Safari" to quit');
    await sleep(2000);
    const p = spawnSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8' }).stdout.trim();
    if (p) h('quit', Number(p.split('\n')[0]));
    server.close();
  };
  spawnSync('open', ['-g', '-a', 'Safari']);
  let pid = 0;
  for (let i = 0; i < 40 && !pid; i++) { await sleep(250); pid = Number(spawnSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || 0; }
  if (!pid) { server.close(); return { skip: 'Safari did not start' }; }
  owned.add(pid);
  const menu = osa('tell application "System Events" to tell process "Safari" to click menu item "New Private Window" of menu "File" of menu bar 1');
  const e1 = osaErr(menu);
  if (e1) { await teardown(); return { skip: 'could not open a private window (Accessibility / Automation for System Events, English menus): ' + e1 }; }
  await sleep(800);
  const id = osa('tell application "Safari" to return id of front window');
  winId = Number(String(id.stdout).trim()) || null;
  const nav = osa(`tell application "Safari" to set URL of front document to "${url}"`);
  if (osaErr(nav)) { await teardown(); return { skip: 'could not load the test page: ' + osaErr(nav) }; }
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await sleep(250); ready = h('press', pid, 'Reset').ok; }
  if (!ready) { await teardown(); return { skip: 'the test page never appeared to Accessibility in Safari' }; }
  notes.push('safari: readback is through Accessibility only (page eval needs "Allow JavaScript from Apple Events"); M0 reads the value it set through the same route');
  return { name: 'Safari (private window)', pid, readText: axText(pid), readLabel: axLabel(pid), reset: axReset(pid),
    methods: [
      { id: 'M0', kind: 'text', run: async () => { D('setvalue', pid, TEXT); } },
      { id: 'M1', kind: 'click', run: async () => { D('press', pid, 'Send'); } },
      { id: 'M2', kind: 'text', run: keys(pid) },
      { id: 'M3', kind: 'click', run: clickBtn(pid) },
      { id: 'M4', kind: 'text', run: async () => { const e = osaErr(osa(`tell application "Safari" to do JavaScript "document.getElementById('n').value='${TEXT}'" in front document`)); if (e) throw new Error(e); } },
    ],
    teardown };
}

const SETUP = { native: setupNative, textedit: setupTextEdit, chrome: setupChrome, safari: setupSafari };

// ---------------------------------------------------------------- one method
async function measure(app, m) {
  const row = { type: 'method', target: app.name, method: m.id, kind: m.kind };
  rows.push(row);
  try {
    await app.reset();
    const left = m.kind === 'text' ? norm(await app.readText()) : norm(await app.readLabel()).includes('CLICKED') ? 'CLICKED' : '';
    if (left) { Object.assign(row, { outcome: 'error', detail: `could not reset the target (still "${left}")` }); return; }
    if (!(await front())) { Object.assign(row, { outcome: 'error', detail: 'could not put ClawdUser in front' }); return; }
    await sleep(600);
  } catch (e) { Object.assign(row, { outcome: 'error', detail: 'setup: ' + e.message }); return; }
  const ref = samples.at(-1) ?? { x: 0, y: 0 };
  const t0 = Date.now();
  let err = null;
  try { await m.run(); } catch (e) { err = e.message; }
  await sleep(400);
  const t1 = Date.now();
  const w = samples.filter(s => s.t >= t0 && s.t <= t1);
  const front_ = [...new Set(w.filter(s => s.pid !== user.pid && s.pid !== 0).map(s => s.name || s.pid))];
  const cursor = w.some(s => Math.abs(s.x - ref.x) > 1 || Math.abs(s.y - ref.y) > 1);
  const userNow = h('getvalue', user.pid).value;
  let got = '';
  try { got = m.kind === 'text' ? norm(await app.readText()) : norm(await app.readLabel()).includes('CLICKED') ? 'CLICKED' : ''; } catch (e) { err = err ?? 'readback: ' + e.message; }
  const want = m.kind === 'text' ? TEXT : 'CLICKED';
  Object.assign(row, { want, got: got.slice(0, 200), foregroundChanged: front_.length > 0, foregroundTo: front_, cursorMoved: cursor, userTextChanged: userNow !== USER_TEXT, ms: t1 - t0,
    outcome: got === want ? 'ok' : err ? 'error' : got === '' ? 'no-effect' : 'partial', ...(err ? { detail: err } : {}) });
}

// ---------------------------------------------------------------- output
function tables() {
  const apps = [...new Set(rows.map(r => r.target))];
  const out = [];
  const t1 = [['target', ...ALL]];
  const t2 = [['target', 'side effects (F foreground changed, C cursor moved, U user text changed)']];
  for (const a of apps) {
    const rs = rows.filter(r => r.target === a);
    t1.push([a, ...ALL.map(id => { const c = rs.filter(r => r.method === id); return c.length ? c.map(r => (c.length > 1 ? r.kind[0] + ':' : '') + r.outcome).join(' / ') : 'n/a'; })]);
    const fl = rs.filter(r => r.foregroundChanged || r.cursorMoved || r.userTextChanged)
      .map(r => `${r.method}${rs.filter(x => x.method === r.method).length > 1 ? r.kind[0] : ''}:${r.foregroundChanged ? 'F(' + r.foregroundTo.join(',') + ')' : ''}${r.cursorMoved ? 'C' : ''}${r.userTextChanged ? 'U' : ''}`);
    t2.push([a, fl.length ? fl.join(' ') : 'none']);
  }
  for (const t of [t1, t2]) {
    const w = t[0].map((_, i) => Math.max(...t.map(r => String(r[i]).length)));
    const line = c => '| ' + c.map((x, i) => String(x).padEnd(w[i])).join(' | ') + ' |';
    out.push([line(t[0]), '|' + w.map(n => '-'.repeat(n + 2)).join('|') + '|', ...t.slice(1).map(line)].join('\n'));
  }
  return out.join('\n\n');
}

function writeResults(status) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `macos-${stamp}.jsonl`);
  const lines = [{ type: 'meta', status, error: fatal, os: os.release(), arch: process.arch, targets: TARGETS, notes }, ...rows, ...targets];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// ---------------------------------------------------------------- run
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });
const timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
process.on('SIGINT', () => { fatal = 'interrupted'; abort(); });

async function run() {
  H = compileHelper(tmp);
  h = makeH(H);
  if (h('trusted').value !== true) throw new Error('Accessibility is not granted to this terminal (System Settings > Privacy & Security > Accessibility)');
  user = await launchWin(H, 'user');
  cleanups.push(async () => { user.child.kill(); });
  sampler = startSampler(H, samples);
  cleanups.push(async () => { sampler.kill(); });
  await sleep(500);
  if (!(await front())) throw new Error('cannot make ClawdUser the frontmost app');
  if (h('getvalue', user.pid).value !== USER_TEXT) throw new Error('ClawdUser text is not readable through Accessibility');
  for (const name of TARGETS) {
    const setup = SETUP[name];
    if (!setup) { notes.push(`unknown target ${name}`); continue; }
    let app;
    try { app = await setup(); } catch (e) { app = { skip: 'setup failed: ' + e.message }; }
    if (app.skip) { log(`skip ${name}: ${app.skip}`); targets.push({ type: 'target', target: name, skipped: app.skip }); continue; }
    cleanups.push(app.teardown);
    targets.push({ type: 'target', target: app.name, pid: app.pid });
    log(`target ${app.name} (pid ${app.pid})`);
    for (const m of app.methods) { await measure(app, m); const r = rows.at(-1); log(`  ${m.id} ${m.kind}: ${r.outcome}${r.detail ? ' (' + r.detail + ')' : ''}`); }
    await app.teardown();
    cleanups = cleanups.filter(c => c !== app.teardown);
    await front();
  }
}

try { await Promise.race([run(), aborted]); }
catch (e) { fatal = fatal ?? (e instanceof Error ? e.message : String(e)); }
finally {
  clearTimeout(timer);
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* closing */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
let file = null;
try { file = writeResults(fatal ? 'error' : 'done'); } catch (e) { console.error('could not write results: ' + e.message); }
log('\n' + tables() + '\n');
for (const n of notes) log('note: ' + n);
if (fatal) log('FAILED: ' + fatal);
if (file) log('results: ' + file);
process.exit(fatal ? 1 : 0);
