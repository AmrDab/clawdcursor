#!/usr/bin/env node
/**
 * Plan (h), the --external two-agent run on macOS (the Windows counterpart is live-windows.mjs --external).
 * This script sets up the windows and the sampler, writes <dir>/setup.json for agent-bridge.mjs, and waits for <dir>/done.
 *   Agent A (computer use) types in the USER app: a new TextEdit instance on user.txt (it holds "user-was-here").
 *   Agent B (a subagent) drives clawdcursor through agent-bridge.mjs, addressing ONLY the agent windows by processId:
 *     ClawdTarget (our own Cocoa window: field ClawdField's text area, buttons ClawdGo / ClawdReset) and Chrome's test page
 *     (field "Your name", button "Send"; Chrome has its own temp profile and debug port; the server gets CLAWD_AGENT_CDP_PORT).
 * Measured from when <dir>/start appears (it holds the start time in ms): focus steals (an agent window frontmost) and cursor moves.
 * Agent A moves the cursor itself, so a cursor count is only informative; focus steals are the number that matters.
 *
 *   node eval/own-window/live-macos.mjs --dry-run
 *   node eval/own-window/live-macos.mjs --external <dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CHROME, helperSwift, sleep, compileHelper, makeH, launchWin, startSampler, startChrome, cdp } from './macos-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'dist', 'surface', 'cli.js');
const resultsDir = path.join(here, 'results');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const EXTERNAL = (() => { const i = args.indexOf('--external'); return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : null; })();
const TEXTEDIT = '/System/Applications/TextEdit.app';
const USER_TEXT = 'user-was-here';
const HARD_TIMEOUT_MS = 480_000;
const log = (...a) => console.log(...a);

if (DRY || !EXTERNAL) {
  log(DRY ? 'DRY RUN: nothing is started.\n' : 'usage: live-macos.mjs --external <dir>   (or --dry-run)\n');
  log('It would start (all its own, closed at the end):');
  log('  - the Swift helper (swiftc into a temp directory)');
  log('  - the USER app for agent A: a new TextEdit instance on <temp>/user.txt holding "' + USER_TEXT + '", put in front');
  log('  - ClawdTarget: our own Cocoa window (text field, buttons ClawdGo / ClawdReset, status label) for agent B');
  log('  - Chrome: --incognito --user-data-dir=<temp> --remote-debugging-port=<free>, a local test page (field "Your name", button "Send")');
  log('  - a sampler of the frontmost app and the real cursor every 50 ms');
  log('  - <dir>/setup.json for agent-bridge.mjs (cli, env with a temp HOME and CLAWD_AGENT_CDP_PORT, pids); then it waits for <dir>/start and <dir>/done');
  log('\nChecks:');
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'darwin', `macOS (${process.platform})`);
  ok(spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0, 'swiftc on PATH');
  ok(fs.existsSync(helperSwift), 'macos-helper.swift present');
  ok(fs.existsSync(TEXTEDIT), 'TextEdit installed');
  ok(fs.existsSync(CHROME), 'Google Chrome installed (the browser steps are skipped without it)');
  ok(fs.existsSync(cli), `built server at ${path.relative(root, cli)} (npm run build)`);
  log(`  ok   results go to ${path.relative(root, resultsDir)}/live-macos-<time>.jsonl; hard timeout ${HARD_TIMEOUT_MS / 1000} s`);
  process.exit(DRY ? 0 : 2);
}
if (process.platform !== 'darwin') { console.error('live-macos.mjs measures macOS only.'); process.exit(2); }
if (!fs.existsSync(cli)) { console.error(`Not built: ${cli}. Run npm run build.`); process.exit(2); }

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-macos-'));
const samples = [];
const notes = [];
const cleanups = [];
let fatal = null, t0 = 0, t1 = 0, row = {};

async function run() {
  const H = compileHelper(home);
  const h = makeH(H);
  if (h('trusted').value !== true) throw new Error('Accessibility is not granted to this terminal');
  const target = await launchWin(H, 'target');
  cleanups.push(() => target.child.kill());
  const file = path.join(home, 'user.txt');
  fs.writeFileSync(file, USER_TEXT);
  const u = h('launch', TEXTEDIT, file);
  if (!u.ok) throw new Error('could not launch the user TextEdit: ' + u.err);
  cleanups.push(() => h('quit', u.value));
  const chrome = await startChrome(home);
  if (chrome.skip) notes.push(chrome.skip + ': the browser steps are skipped');
  else cleanups.push(chrome.stop);
  const agents = new Set([target.pid, chrome.pid].filter(Boolean));

  h('activate', u.value);   // the user app in front; agent A brings its own window forward anyway
  const sampler = startSampler(H, samples);
  cleanups.push(() => sampler.kill());
  await sleep(600);
  const ref = samples.at(-1);
  if (!ref) throw new Error('the sampler produced no samples');
  log(`setup ok: user TextEdit pid ${u.value} (user.txt), ClawdTarget pid ${target.pid}, Chrome ${chrome.pid ? 'pid ' + chrome.pid + ' cdp ' + chrome.port : 'SKIPPED'}; cursor at ${ref.x},${ref.y}`);

  fs.mkdirSync(EXTERNAL, { recursive: true });
  for (const f of ['done', 'start']) fs.rmSync(path.join(EXTERNAL, f), { force: true });
  const env = { HOME: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', CLAWD_NO_PAUSE: '1', ...(chrome.pid ? { CLAWD_AGENT_CDP_PORT: String(chrome.port) } : {}) };
  fs.writeFileSync(path.join(EXTERNAL, 'setup.json'), JSON.stringify({ cli, env, user: { pid: u.value, file }, target: { pid: target.pid }, chrome: chrome.pid ? { pid: chrome.pid, port: chrome.port } : null }, null, 2));
  log(`EXTERNAL: setup written to ${EXTERNAL}/setup.json; waiting for ${EXTERNAL}/start, then ${EXTERNAL}/done`);
  while (!fs.existsSync(path.join(EXTERNAL, 'start'))) await sleep(200);
  t0 = Number(fs.readFileSync(path.join(EXTERNAL, 'start'), 'utf8')) || Date.now();
  while (!fs.existsSync(path.join(EXTERNAL, 'done'))) await sleep(500);
  t1 = Date.now();
  await sleep(400);

  const w = samples.filter(s => s.t >= t0 && s.t <= t1);
  const steals = [];
  let cur = null;
  for (const s of w) {
    if (agents.has(s.pid)) {
      if (cur && cur.pid === s.pid) { cur.last = s.t; cur.n++; } else { cur = { pid: s.pid, who: s.name, first: s.t, last: s.t, n: 1 }; steals.push(cur); }
    } else cur = null;
  }
  const moved = w.filter(s => Math.abs(s.x - ref.x) > 1 || Math.abs(s.y - ref.y) > 1);
  const page = chrome.pid ? await cdp(chrome.port, [['Runtime.evaluate', { expression: 'JSON.stringify({ name: document.getElementById("n").value, out: document.getElementById("out").textContent })', returnByValue: true }]]).catch(e => 'ERR ' + e.message) : null;
  row = {
    type: 'step', step: 'external', ms: t1 - t0, samples: w.length,
    steals: steals.map(c => ({ who: c.who, pid: c.pid, atMs: c.first - t0, durMs: c.last - c.first + 50 })),
    cursorMovedSamples: moved.length, cursorMaxDistPx: Math.round(moved.reduce((m, s) => Math.max(m, Math.hypot(s.x - ref.x, s.y - ref.y)), 0)),
    effects: { targetField: h('getvalue', target.pid).value, targetLabel: h('getlabel', target.pid).value, page },
    userText: h('getvalue', u.value).value,
  };
  log(`user app text now: ${JSON.stringify(row.userText)}`);
  log(`agent B effects: ${JSON.stringify(row.effects)}`);
  log(`focus steals (an agent window frontmost): ${row.steals.length}${row.steals.map(s => `, ${s.who} ${s.durMs} ms at +${s.atMs} ms`).join('')}`);
  log(`cursor moved samples: ${row.cursorMovedSamples} (max ${row.cursorMaxDistPx} px; agent A's own moves count)`);
}

// Every exit (done, error, hard timeout, SIGINT / SIGTERM) goes through the one `finally` below: Chrome's stop() is async,
// so it must be awaited there, never followed by an immediate process.exit.
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });
const timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fatal = fatal ?? `interrupted (${sig})`; abort(); });
try { await Promise.race([run(), aborted]); } catch (e) { fatal = fatal ?? (e instanceof Error ? e.message : String(e)); }
finally {
  clearTimeout(timer);
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* closing */ } }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
}
fs.mkdirSync(resultsDir, { recursive: true });
const out = path.join(resultsDir, `live-macos-${stamp}.jsonl`);
fs.writeFileSync(out, [{ type: 'meta', status: fatal ? 'error' : 'done', error: fatal, os: os.release(), notes }, row, { type: 'samples', fields: ['t', 'pid', 'x', 'y', 'name'], rows: samples.map(s => [s.t, s.pid, s.x, s.y, s.name]) }].map(l => JSON.stringify(l)).join('\n') + '\n');
for (const n of notes) log('note: ' + n);
if (fatal) log('FAILED: ' + fatal);
log('results: ' + out);
process.exit(fatal ? 1 : 0);
