#!/usr/bin/env node
/**
 * One combined live check of the own-window indicator and the user's turn on Windows, with spoken cues. The owner sits
 * at the PC; their answers go on clawdcursor's own pause card (Yes / No buttons), never in a chat.
 *   BACKGROUND  the owner types in ClawdUser; the agent acts by name on ClawdTarget and on its own Edge page.
 *               Expected: an amber frame round the agent's windows, no glow, no focus steal, the owner's typing intact.
 *   FOREGROUND  hands off; the agent focuses ClawdTarget and types with the real keyboard. Expected: the amber edge glow.
 *   PAUSE       pause_for_user, a question card. Expected: blue edges and the card, no frame.
 *   YOUR TURN   the owner keeps typing in ClawdUser while the agent wants to type in ClawdTarget. Expected: it waits;
 *               after 5 s the pill says Paused and shows Resume; nothing of the agent's lands while they type; after
 *               their Resume it types in ClawdTarget.
 *   PILL PAUSE  the owner clicks Pause on the pill; a background act waits; it lands only after their Resume.
 * Every overlay window of the test server is recorded twice a second (overlay-recorder.ps1); each act is printed with
 * what was on screen, then a PASS/FAIL table.
 *
 *   node eval/own-window/full-windows.mjs --dry-run
 *   node eval/own-window/full-windows.mjs
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
const recorderPs1 = path.join(here, 'overlay-recorder.ps1');
const resultsDir = path.join(here, 'results');
const EDGE_PATHS = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const EDGE_PAGE = '<!doctype html><title>Clawd test page</title>\n<label for="n">Your name</label> <input id="n">\n'
  + '<button onclick="document.getElementById(\'out\').textContent=\'CLICKED\'">Send</button>\n<p id="out"></p>\n';
const USER_TEXT = 'user-was-here';
const HARD_TIMEOUT_MS = 480_000;
const GAP_MS = 3000;          // between background acts
const ROUNDS = 2;
const AGENT_MARKS = /agent-round|page-round|foreground-typed|after-your-turn|set-while-paused/;

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** A spoken cue (System.Speech); the text goes through the environment, never into the command. */
const say = text => {
  log(`  (say) ${text}`);
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:CLAWD_SAY)'],
  { env: { ...process.env, CLAWD_SAY: text }, windowsHide: true, timeout: 30_000 });
};

if (process.argv.includes('--dry-run')) {
  log('DRY RUN: nothing is started.\n\nPlan:');
  log('  setup       ClawdUser (the owner\'s stand-in window, in front), ClawdTarget (the agent\'s WinForms window), Notepad, Edge as its');
  log('              own instance (temp profile, own debug port) on a local page, the built MCP server (temp home, pauses allowed),');
  log('              a 50 ms foreground sampler, the overlay recorder (only the test server\'s overlays and the agent\'s windows)');
  log(`  BACKGROUND  ${ROUNDS} rounds, ${GAP_MS / 1000} s apart: set_value ClawdField, invoke ClawdGo (by processId), browser type / click.`);
  log('              The owner types in ClawdUser the whole time.');
  log('  FOREGROUND  spoken "hands off"; window focus ClawdTarget, computer type');
  log('  PAUSE       a question card (pause_for_user with Yes / No): the frame earlier, the blue edges now');
  log('  YOUR TURN   the owner types in ClawdUser while the agent focuses ClawdTarget; they click Resume on the pill when it shows');
  log('  PILL PAUSE  the owner clicks Pause on the pill; set_value ClawdNote waits; they click Resume; one more question card');
  log(`  cleanup     every window and process it started, on every exit; hard timeout ${HARD_TIMEOUT_MS / 1000} s\n\nChecks:`);
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'win32', `Windows (${process.platform})`);
  ok([helperPs1, samplerPs1, recorderPs1].every(f => fs.existsSync(f)), 'helper, sampler and recorder scripts present');
  ok(EDGE_PATHS.some(p => fs.existsSync(p)), 'Microsoft Edge installed (the browser acts are skipped without it)');
  ok(fs.existsSync(cli), `built server at ${path.relative(root, cli)} (npm run build)`);
  process.exit(0);
}
if (process.platform !== 'win32') { console.error('full-windows.mjs runs on Windows only.'); process.exit(2); }
if (!fs.existsSync(cli)) { console.error(`Not built: ${cli}. Run npm run build.`); process.exit(2); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-full-win-'));
const heldFile = path.join(home, '.clawdcursor', 'held.json');   // the user's hold, as the server under test writes it
const R = { user: null, target: null, edge: null };
const samples = [];   // {t, pid}: the foreground, every 50 ms
const shots = [];     // {t, wins: [{pid, kind, x, y, w, h}]}, every 500 ms
const report = [];
const phases = {};
const children = [];
let helper = null, client = null, transport = null, fatal = null;

function lines(child, onLine) { readline.createInterface({ input: child.stdout }).on('line', onLine); }
function killTree(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ } }

function startHelper() {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPs1, '-TempDir', home],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = [];
  lines(child, line => { const w = waiting.shift(); if (w) { try { w.resolve(JSON.parse(line)); } catch { w.reject(new Error('helper said: ' + line)); } } });
  child.on('exit', () => { while (waiting.length) waiting.shift().reject(new Error('helper exited')); });
  const send = (cmd, ms = 30_000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`helper ${cmd} timed out`)), ms);
    waiting.push({ resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    child.stdin.write(JSON.stringify({ cmd }) + '\n');
  });
  return { child, send };
}

function startPs(file, args, onLine) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  children.push(child);
  let ready;
  const readyP = new Promise((res, rej) => { ready = res; setTimeout(() => rej(new Error(`${path.basename(file)} did not start`)), 20_000); });
  lines(child, line => (line === 'READY' ? ready() : onLine(line)));
  return readyP;
}

async function startEdge() {
  const exe = EDGE_PATHS.find(p => fs.existsSync(p));
  if (!exe) { log('note: Edge not found: the browser acts are skipped'); return; }
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const page = path.join(home, 'edge-test-page.html');
  fs.writeFileSync(page, EDGE_PAGE);
  spawn(exe, ['--inprivate', '--new-window', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'edge')}`, '--no-first-run',
    '--disable-extensions', '--disable-sync', pathToFileURL(page).href], { stdio: 'ignore' });
  R.edge = { pid: 0, port };
  for (let i = 0; ; i++) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some(t => t.type === 'page' && t.url.startsWith('file:'))) break; } catch { /* not up yet */ }
    if (i === 60) throw new Error('setup: Edge did not open the test page on its debug port');
    await sleep(250);
  }
  const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess | Select-Object -First 1`], { encoding: 'utf8', windowsHide: true });
  R.edge.pid = Number(String(q.stdout).trim()) || 0;   // the browser process: it owns the windows
  if (!R.edge.pid) throw new Error('setup: could not find the test Edge\'s process');
}

/** Read the test page over CDP, from this script (not through clawdcursor). */
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

async function call(name, a, timeout = 70_000) {
  try {
    const r = await client.callTool({ name, arguments: a }, undefined, { timeout });
    const text = (r.content ?? []).filter(x => x.type === 'text').map(x => x.text).join(' ').replace(/\s+/g, ' ').trim();
    return (r.isError ? 'ERROR ' : '') + text;
  } catch (e) { return 'ERROR ' + (e instanceof Error ? e.message : String(e)); }
}
/** A call the user's turn may hold: called again on the waiting reply, as an agent is told to. */
async function callThroughHold(name, a, tries = 3) {
  let r = '';
  for (let i = 0; i < tries; i++) { r = await call(name, a); if (!/paused by the user/.test(r)) return r; }
  return r;
}
/** A question on clawdcursor's own pause card; the owner answers with a button. */
async function ask(message, choices) {
  for (let i = 0; i < 4; i++) {
    const r = await call('system', { action: 'pause_for_user', message, choices }, 70_000);
    const m = /"choice"\s*:\s*"([^"]+)"/.exec(r) ?? /choice[:=]\s*"?([A-Za-z][^",}]*)/.exec(r);
    if (m) return { answer: m[1], text: r };
    if (!/waiting/i.test(r)) return { answer: null, text: r };
  }
  return { answer: null, text: 'no answer' };
}

const near = (a, b) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= 8);
const box = w => `${w.x},${w.y} ${w.w}x${w.h}`;
/** What the recorder saw in [from, to] for the agent window of `pid`. */
function during(from, to, pid) {
  const all = shots.filter(s => s.t >= from && s.t <= to).map(s => {
    const target = s.wins.find(w => w.kind === 'target' && w.pid === pid && w.w >= 100 && w.h >= 100);
    const outlines = s.wins.filter(w => w.kind === 'outline' && w.w >= 60 && w.h >= 60);   // not the ghost pointer
    return { target, outlines, glow: s.wins.some(w => w.kind === 'glow'), blue: s.wins.some(w => w.kind === 'glow-blue'),
      pill: s.wins.some(w => w.kind === 'pill'), around: !!target && outlines.some(o => near(o, target)) };
  });
  const best = all.find(s => s.around) ?? all.at(-1) ?? { outlines: [], around: false };
  return { ...best, around: all.some(s => s.around), glow: all.some(s => s.glow), blue: all.some(s => s.blue), pill: all.some(s => s.pill),
    anyOutline: all.some(s => s.outlines.length > 0) };
}
function line(phase, act, result, from, pid, who) {
  const s = during(from, Date.now(), pid);
  const outline = s.outlines.length ? s.outlines.map(box).join(' + ') : 'none';
  const where = s.target ? `${who} ${box(s.target)}${s.outlines.length ? (s.around ? ' MATCH' : ' NO MATCH') : ''}` : `${who} not on screen`;
  const text = `[${phase}] +${((from - phases.BACKGROUND.from) / 1000).toFixed(1).padStart(5)}s ${act} -> ${result.slice(0, 90)} | outline ${outline} (${where}) | glow ${s.blue ? 'BLUE' : s.glow ? 'amber' : 'no'} | pill ${s.pill ? 'yes' : 'no'}`;
  report.push(text);
  log(text);
  return s;
}

async function run() {
  helper = startHelper();
  const st = await helper.send('start', 45_000);
  if (!st.ok) throw new Error('setup: ' + st.error);
  R.user = st.user; R.target = st.target;
  if (st.user.text !== USER_TEXT) throw new Error(`setup: ClawdUser text is "${st.user.text}"`);
  await startEdge();
  const agents = new Set([R.target.pid, R.edge?.pid].filter(Boolean));

  await startPs(samplerPs1, ['-IntervalMs', '50'], l => { const p = l.split('|'); if (p[0] === 'S') samples.push({ t: +p[1], pid: +p[3] }); });

  // The server under test: the built CLI over stdio, its own home, pauses allowed (no CLAWD_NO_PAUSE).
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', ...(R.edge ? { CLAWD_AGENT_CDP_PORT: String(R.edge.port) } : {}) };
  delete env.CLAWD_NO_PAUSE;
  transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--compact'], env, cwd: home, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'full-windows', version: '1' });
  await client.connect(transport);
  await startPs(recorderPs1, ['-ServerPid', String(transport.pid), '-Pids', [...agents].join(',')], l => {
    const p = l.split('|');
    if (p[0] !== 'R') return;
    shots.push({ t: +p[1], wins: (p[2] || '').split(';').filter(Boolean).map(w => { const f = w.split(','); return { pid: +f[0], kind: f[1], x: +f[2], y: +f[3], w: +f[4], h: +f[5] }; }) });
  });

  const fr = await helper.send('front');
  if (!fr.front) throw new Error('cannot put ClawdUser in front (Windows foreground lock); run from an interactive session');
  log(`setup ok: ClawdUser pid ${R.user.pid}, ClawdTarget pid ${R.target.pid}, Edge ${R.edge ? 'pid ' + R.edge.pid : 'SKIPPED'}, server pid ${transport.pid}`);

  // Warm-up, not measured: the first act brings the pill up.
  await call('accessibility', { action: 'set_value', name: 'ClawdField', value: 'warm-up', processId: R.target.pid });
  if (R.edge) await call('browser', { action: 'connect' });
  for (let i = 0; i < 40 && !shots.some(s => s.wins.some(w => w.kind === 'pill')); i++) await sleep(500);
  if (!shots.some(s => s.wins.some(w => w.kind === 'pill'))) throw new Error('no pill appeared within 20 s of the first act');

  // ---- BACKGROUND
  say('Background test. Click in the Clawd User window and type, and keep typing until I say stop.');
  await sleep(3000);
  phases.BACKGROUND = { from: Date.now() };
  const bg = { target: false, edge: !R.edge };
  for (let i = 1; i <= ROUNDS; i++) {
    const acts = [
      ['set_value ClawdField', 'accessibility', { action: 'set_value', name: 'ClawdField', value: `agent-round-${i}`, processId: R.target.pid }, R.target.pid, 'ClawdTarget'],
      ['invoke ClawdGo', 'accessibility', { action: 'invoke', name: 'ClawdGo', processId: R.target.pid }, R.target.pid, 'ClawdTarget'],
      ...(R.edge ? [
        ['browser type #n', 'browser', { action: 'type', selector: '#n', text: `page-round-${i}` }, R.edge.pid, 'Edge'],
        ['browser click Send', 'browser', { action: 'click', selector: 'button' }, R.edge.pid, 'Edge'],
      ] : []),
    ];
    for (const [label, tool, a, pid, who] of acts) {
      const from = Date.now();
      const result = await call(tool, a);
      await sleep(GAP_MS);
      const s = line('BACKGROUND', label, result, from, pid, who);
      if (s.around) bg[pid === R.target.pid ? 'target' : 'edge'] = true;
    }
  }
  phases.BACKGROUND.to = Date.now();
  const afterBg = await helper.send('read');
  const page = R.edge ? await pageEval('document.getElementById("n").value + "|" + document.getElementById("out").textContent').catch(() => '') : '';

  // ---- FOREGROUND
  say('Stop typing. Hands off the keyboard and mouse. The agent takes the foreground now. Watch for the amber glow on the screen edges.');
  await sleep(3000);
  phases.FOREGROUND = { from: Date.now() };
  let from = Date.now();
  let result = await call('window', { action: 'focus', processId: R.target.pid });
  await sleep(1000);
  line('FOREGROUND', 'window focus ClawdTarget', result, from, R.target.pid, 'ClawdTarget');
  from = Date.now();
  result = await call('computer', { action: 'type', text: ' foreground-typed' });
  await sleep(2000);
  line('FOREGROUND', 'computer type', result, from, R.target.pid, 'ClawdTarget');
  phases.FOREGROUND.to = Date.now();
  const afterFg = await helper.send('read');
  await sleep(3000);   // the amber glow's tail ends before the pause's own

  // ---- PAUSE (a question card: the blue state, and the owner's answer about the frame)
  say('A question card is on screen. Look at the screen edges, then answer on the card.');
  phases.PAUSE = { from: Date.now() };
  const q1 = await ask('Two questions. Earlier, while you typed, was there an amber frame round the agent\'s windows (the ClawdTarget form and Edge), and no glow at the edges? And right now, are the screen edges pulsing blue, with no frame round any window?',
    ['Both yes', 'Frame earlier: no', 'Blue now: no', 'Neither']);
  phases.PAUSE.to = Date.now();
  log(`[PAUSE] owner: ${q1.answer ?? q1.text.slice(0, 120)}`);
  await sleep(1500);

  // ---- YOUR TURN (the agent waits while the owner types)
  await helper.send('front');
  say('Your turn test. Click in the Clawd User window and type, and keep typing. The pill will say paused, and after a few seconds it shows a Resume button. Then stop typing, click Resume on the pill, and take your hands off.');
  await sleep(2500);
  phases.TURN = { from: Date.now() };
  let sawHeld = false;
  const watchHeld = setInterval(() => { if (fs.existsSync(heldFile)) sawHeld = true; }, 200);
  from = Date.now();
  result = await callThroughHold('window', { action: 'focus', processId: R.target.pid });
  const focusMs = Date.now() - from;
  line('YOUR TURN', `window focus ClawdTarget (${(focusMs / 1000).toFixed(1)} s)`, result, from, R.target.pid, 'ClawdTarget');
  from = Date.now();
  result = await callThroughHold('computer', { action: 'type', text: ' after-your-turn' });
  await sleep(1500);
  line('YOUR TURN', 'computer type', result, from, R.target.pid, 'ClawdTarget');
  clearInterval(watchHeld);
  phases.TURN.to = Date.now();
  const afterTurn = await helper.send('read');

  // ---- PILL PAUSE (a background act waits for Resume)
  say('Pill pause test. Click Pause on the pill at the top of the screen.');
  phases.HOLD = { from: Date.now() };
  for (let i = 0; i < 200 && !fs.existsSync(heldFile); i++) await sleep(200);
  const paused = fs.existsSync(heldFile);
  let held = { landedEarly: false, landed: false, ms: 0, result: 'not run: Pause was not clicked within 40 s' };
  if (paused) {
    await sleep(1000);
    from = Date.now();
    const act = call('accessibility', { action: 'set_value', name: 'ClawdNote', value: 'set-while-paused', processId: R.target.pid });
    await sleep(5000);
    held.landedEarly = (await helper.send('read')).f2 === 'set-while-paused';
    say('Now click Resume on the pill.');
    held.result = await act;
    held.ms = Date.now() - from;
    await sleep(800);
    held.landed = (await helper.send('read')).f2 === 'set-while-paused';
    line('PILL PAUSE', `set_value ClawdNote (${(held.ms / 1000).toFixed(1)} s)`, held.result, from, R.target.pid, 'ClawdTarget');
  }
  phases.HOLD.to = Date.now();
  const q2 = await ask('Last question. When you clicked Pause, did the pill say Paused and show a Resume button, with no glow at the screen edges?', ['Yes', 'No']);
  log(`[PILL PAUSE] owner: ${q2.answer ?? q2.text.slice(0, 120)}`);

  // ---- the table
  const inPhase = p => shots.filter(s => s.t >= phases[p].from && s.t <= phases[p].to);
  const w = samples.filter(s => s.t >= phases.BACKGROUND.from && s.t <= phases.BACKGROUND.to);
  const steals = w.filter((s, i) => agents.has(s.pid) && !(i > 0 && w[i - 1].pid === s.pid)).length;
  const pauseShots = inPhase('PAUSE');
  const blueFrom = pauseShots.findIndex(s => s.wins.some(x => x.kind === 'glow-blue'));
  const holdShots = inPhase('HOLD');
  const rows = [
    ['outline round ClawdTarget in background', bg.target],
    ['outline round Edge in background', R.edge ? bg.edge : null],
    ['no glow in background', !inPhase('BACKGROUND').some(s => s.wins.some(x => x.kind === 'glow' || x.kind === 'glow-blue'))],
    ['amber glow in foreground', inPhase('FOREGROUND').some(s => s.wins.some(x => x.kind === 'glow'))],
    ['blue glow and no outline at the pause', blueFrom >= 0 && !pauseShots.slice(blueFrom).some(s => s.wins.some(x => x.kind === 'outline' && x.w >= 60 && x.h >= 60))],
    [`owner: frame earlier and blue now (${q1.answer ?? 'no answer'})`, q1.answer === 'Both yes'],
    [`focus steals during background = 0 (${steals})`, steals === 0],
    [`the owner's typing intact in background (ClawdUser has no agent text; ClawdField ${JSON.stringify(afterBg.f1)}${R.edge ? `; page ${JSON.stringify(page)}` : ''})`,
      !AGENT_MARKS.test(afterBg.userText) && afterBg.f1 === `agent-round-${ROUNDS}` && (!R.edge || page === `page-round-${ROUNDS}|CLICKED`)],
    ['foreground typing landed in ClawdTarget', /foreground-typed/.test(`${afterFg.f1}${afterFg.f2}`)],
    [`your turn: the agent waited for you (focus took ${(focusMs / 1000).toFixed(1)} s, held ${sawHeld ? 'yes' : 'no'})`, focusMs >= 4500 && sawHeld],
    ['your turn: nothing of the agent\'s landed in your window, and it typed in ClawdTarget after Resume',
      !AGENT_MARKS.test(afterTurn.userText) && /after-your-turn/.test(`${afterTurn.f1}${afterTurn.f2}`)],
    [`pill Pause held a background act until Resume (${(held.ms / 1000).toFixed(1)} s)`, paused && !held.landedEarly && held.landed],
    ['no glow while paused from the pill', paused && !holdShots.some(s => s.wins.some(x => x.kind === 'glow'))],
    [`owner: the pill said Paused with Resume, no glow (${q2.answer ?? 'no answer'})`, q2.answer === 'Yes'],
  ];
  log('\nRESULT');
  for (const [what, ok] of rows) log(`  ${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${what}`);
  log(`  (${shots.length} overlay snapshots, ${samples.length} foreground samples)`);
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `full-windows-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ report, rows: rows.map(([what, ok]) => ({ what, ok })), answers: { q1: q1.answer, q2: q2.answer } }, null, 2));
  log(`  written: ${path.relative(root, out)}`);
  say(rows.every(r => r[1] !== false) ? 'Test finished. Everything passed.' : 'Test finished. Some checks failed.');
  if (rows.some(r => r[1] === false)) process.exitCode = 1;
}

// Every exit (done, error, hard timeout, Ctrl+C) goes through the one `finally`.
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });
const timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fatal = fatal ?? `interrupted (${sig})`; abort(); });
try { await Promise.race([run(), aborted]); } catch (e) { fatal = fatal ?? (e instanceof Error ? e.message : String(e)); }
finally {
  clearTimeout(timer);
  const serverPid = transport?.pid;
  try { await Promise.race([client?.close(), sleep(5000)]); } catch { /* closing */ }
  if (serverPid) killTree(serverPid);   // the server and its overlays
  if (R.edge?.pid) killTree(R.edge.pid);   // our own Edge instance only
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  if (helper) { try { await helper.send('stop', 10_000); } catch { /* closing */ } try { helper.child.kill(); } catch { /* gone */ } }
  if (R.user?.pid) killTree(R.user.pid);
  if (R.target?.pid) killTree(R.target.pid);
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
}
if (fatal) { log('FAILED: ' + fatal); if (report.length) log('(the lines above are what ran before it)'); }
process.exit(fatal ? 1 : process.exitCode ?? 0);
