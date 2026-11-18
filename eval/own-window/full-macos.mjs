#!/usr/bin/env node
/**
 * One combined live check of the own-window indicator on macOS, with spoken cues. The owner sits at the Mac.
 *   BACKGROUND  the owner types in the user TextEdit; the agent acts by name on ClawdTarget and on its own Chrome page.
 *               Expected: an amber frame round the agent's window, no glow, no focus steal, the owner's typing intact.
 *   FOREGROUND  hands off; the agent focuses ClawdTarget and types with the real keyboard. Expected: the amber edge glow.
 *   PAUSE       pause_for_user. Expected: blue edges and the card, no frame. The owner clicks Resume.
 * Every overlay window is recorded twice a second (overlay-recorder.swift) and each act is printed with what was on screen.
 *
 *   node eval/own-window/full-macos.mjs --dry-run
 *   node eval/own-window/full-macos.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CHROME, helperSwift, sleep, compileHelper, makeH, launchWin, startSampler, startChrome } from './macos-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cli = path.join(root, 'dist', 'surface', 'cli.js');
const recorderSwift = path.join(here, 'overlay-recorder.swift');
const TEXTEDIT = '/System/Applications/TextEdit.app';
const USER_TEXT = 'user-was-here';
const HARD_TIMEOUT_MS = 330_000;
const GAP_MS = 3000;          // between background acts
const ROUNDS = 3;
const log = (...a) => console.log(...a);
const say = text => { log(`  (say) ${text}`); spawnSync('say', [text], { timeout: 20_000 }); };

if (process.argv.includes('--dry-run')) {
  log('DRY RUN: nothing is started.\n\nPlan:');
  log('  setup       ClawdTarget (our own Cocoa window), a new TextEdit on <temp>/user.txt in front, Chrome with a temp profile on a local');
  log('              page, the built MCP server (temp HOME, pause_for_user enabled), a frontmost-app sampler, the overlay recorder');
  log(`  BACKGROUND  ${ROUNDS} rounds, ${GAP_MS / 1000} s apart: accessibility set_value ClawdField, accessibility invoke ClawdGo (both by processId),`);
  log('              browser type "#n", browser click "#s". The owner types in TextEdit the whole time.');
  log('  FOREGROUND  spoken "hands off"; window focus ClawdTarget, computer type');
  log('  PAUSE       system pause_for_user; the owner looks, then clicks Resume (waits up to 100 s)');
  log('  report      one line per act tagged [BACKGROUND] / [FOREGROUND] / [PAUSE] with the overlays on screen, then a PASS/FAIL table');
  log(`  cleanup     every window and process it started, on every exit; hard timeout ${HARD_TIMEOUT_MS / 1000} s\n\nChecks:`);
  const ok = (c, w) => log(`  ${c ? 'ok  ' : 'FAIL'} ${w}`);
  ok(process.platform === 'darwin', `macOS (${process.platform})`);
  ok(spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0, 'swiftc on PATH');
  ok(fs.existsSync(helperSwift) && fs.existsSync(recorderSwift), 'macos-helper.swift and overlay-recorder.swift present');
  ok(fs.existsSync(TEXTEDIT), 'TextEdit installed');
  ok(fs.existsSync(CHROME), 'Google Chrome installed (the browser acts are skipped without it)');
  ok(fs.existsSync(cli), `built server at ${path.relative(root, cli)} (npm run build)`);
  process.exit(0);
}
if (process.platform !== 'darwin') { console.error('full-macos.mjs runs on macOS only.'); process.exit(2); }
if (!fs.existsSync(cli)) { console.error(`Not built: ${cli}. Run npm run build.`); process.exit(2); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-full-macos-'));
const cleanups = [];
const samples = [];   // frontmost app, every 50 ms
const shots = [];     // {t, wins: [{pid, layer, x, y, w, h, owner}]}, every 500 ms
const report = [];
const phases = {};    // name -> {from, to}
let fatal = null;

// Which drawer a clawd-overlay process is: its first argument (pill | outline | glow).
const modes = new Map();
const modeOf = pid => {
  if (!modes.has(pid)) modes.set(pid, (String(spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout).match(/ (pill|outline|glow)( |$)/m) ?? [])[1] ?? '?');
  return modes.get(pid);
};
const box = w => `${w.x},${w.y} ${w.w}x${w.h}`;
const near = (a, b) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) <= 4);

/** What one recorder snapshot shows, for the agent's window `pid`. */
function seen(shot, pid) {
  const over = shot.wins.filter(w => w.owner.startsWith('clawd-overlay')).map(w => ({ ...w, mode: modeOf(w.pid) }));
  const target = shot.wins.find(w => w.pid === pid && w.layer === 0 && w.w >= 40 && w.h >= 40);
  const outlines = over.filter(w => w.mode === 'outline' && w.w >= 40 && w.h >= 40);   // not the small ghost pointer
  const glow = over.find(w => w.mode === 'glow');
  return { target, outlines, glow, pill: over.some(w => w.mode === 'pill'), around: !!target && outlines.some(o => near(o, target)) };
}
/** The snapshots of [from, to], summed up for `pid`: the one that shows the frame round it if any does, else the last. */
function during(from, to, pid) {
  const all = shots.filter(s => s.t >= from && s.t <= to).map(s => seen(s, pid));
  const best = all.find(s => s.around) ?? all.at(-1) ?? { outlines: [], pill: false, around: false };
  return { ...best, n: all.length, anyGlow: all.find(s => s.glow)?.glow, anyOutline: all.some(s => s.outlines.length > 0), around: all.some(s => s.around) };
}
function line(phase, act, result, from, pid, who) {
  const s = during(from, Date.now(), pid);
  const outline = s.outlines.length ? s.outlines.map(box).join(' + ') : 'none';
  const where = s.target ? `${who} window ${box(s.target)}${s.outlines.length ? (s.around ? ' MATCH' : ' NO MATCH') : ''}` : `${who} window not on screen`;
  const text = `[${phase}] +${((from - phases.BACKGROUND.from) / 1000).toFixed(1).padStart(5)}s ${act} -> ${result} | outline ${outline} (${where}) | glow ${s.anyGlow ? 'yes layer ' + s.anyGlow.layer : 'no'} | pill ${s.pill ? 'yes' : 'no'}`;
  report.push(text);
  log(text);
  return s;
}

async function run() {
  const H = compileHelper(home);
  const h = makeH(H);
  if (h('trusted').value !== true) throw new Error('Accessibility is not granted to this terminal');
  const recBin = path.join(home, 'overlay-recorder');
  const c = spawnSync('swiftc', ['-O', recorderSwift, '-o', recBin], { encoding: 'utf8', timeout: 180_000 });
  if (c.status !== 0) throw new Error('swiftc (recorder) failed: ' + String(c.stderr || c.error).slice(0, 400));

  const target = await launchWin(H, 'target');
  cleanups.push(() => target.child.kill());
  const file = path.join(home, 'user.txt');
  fs.writeFileSync(file, USER_TEXT);
  const u = h('launch', TEXTEDIT, file);
  if (!u.ok) throw new Error('could not launch the user TextEdit: ' + u.err);
  cleanups.push(() => h('quit', u.value));
  const chrome = await startChrome(home);
  if (chrome.skip) log(`note: ${chrome.skip}: the browser acts are skipped`); else cleanups.push(chrome.stop);
  const agents = new Set([target.pid, chrome.pid].filter(Boolean));

  const rec = spawn(recBin, [...agents].map(String), { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanups.push(() => rec.kill());
  readline.createInterface({ input: rec.stdout }).on('line', l => {
    const p = l.split('|');
    if (p[0] !== 'R') return;
    shots.push({ t: +p[1], wins: (p[2] || '').split(';').filter(Boolean).map(w => { const f = w.split(','); return { pid: +f[0], layer: +f[1], x: +f[2], y: +f[3], w: +f[4], h: +f[5], owner: f.slice(6).join(',') }; }) });
    // Name each overlay's drawer now, while its process is alive: the pause's overlays are gone by the time the table is made.
    for (const w of shots.at(-1).wins) if (w.owner.startsWith('clawd-overlay')) modeOf(w.pid);
  });
  const sampler = startSampler(H, samples);
  cleanups.push(() => sampler.kill());

  // The server under test: the built CLI over stdio, its own HOME, pause_for_user left on (no CLAWD_NO_PAUSE).
  const sdk = f => import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
  const { Client } = await sdk('client/index.js');
  const { StdioClientTransport } = await sdk('client/stdio.js');
  const env = { ...process.env, HOME: home, CLAWDCURSOR_CONSENT: 'true', CLAWD_TELEMETRY: '0', DO_NOT_TRACK: '1', ...(chrome.pid ? { CLAWD_AGENT_CDP_PORT: String(chrome.port) } : {}) };
  delete env.CLAWD_NO_PAUSE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--compact'], env, cwd: home, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'full-macos', version: '1' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name, a, timeout = 60_000) => {
    try {
      const r = await client.callTool({ name, arguments: a }, undefined, { timeout });
      const text = (r.content ?? []).filter(x => x.type === 'text').map(x => x.text).join(' ').replace(/\s+/g, ' ').trim();
      return (r.isError ? 'ERROR ' : '') + text.slice(0, 110);
    } catch (e) { return 'ERROR ' + (e instanceof Error ? e.message : String(e)).slice(0, 110); }
  };

  h('activate', u.value);   // the owner's window in front
  await sleep(800);
  log(`setup ok: user TextEdit pid ${u.value}, ClawdTarget pid ${target.pid}, Chrome ${chrome.pid ? 'pid ' + chrome.pid : 'SKIPPED'}`);

  // Warm-up, not measured: the first act brings the pill up (a fresh HOME compiles the overlay first, some seconds).
  await call('accessibility', { action: 'set_value', name: 'ClawdField', value: 'warm-up', processId: target.pid });
  if (chrome.pid) await call('browser', { action: 'connect' });
  for (let i = 0; i < 80 && !shots.some(s => s.wins.some(w => w.owner.startsWith('clawd-overlay'))); i++) await sleep(500);
  if (!shots.some(s => s.wins.some(w => w.owner.startsWith('clawd-overlay')))) throw new Error('no overlay window appeared within 40 s of the first act');

  // ---- BACKGROUND
  say('Background test. Type in the Text Edit window now, and keep typing until I say stop.');
  phases.BACKGROUND = { from: Date.now() };
  const bg = { target: false, chrome: !chrome.pid };
  for (let i = 1; i <= ROUNDS; i++) {
    const acts = [
      ['accessibility set_value ClawdField', 'accessibility', { action: 'set_value', name: 'ClawdField', value: `agent-round-${i}`, processId: target.pid }, target.pid, 'ClawdTarget'],
      ['accessibility invoke ClawdGo', 'accessibility', { action: 'invoke', name: 'ClawdGo', processId: target.pid }, target.pid, 'ClawdTarget'],
      ...(chrome.pid ? [
        ['browser type #n', 'browser', { action: 'type', selector: '#n', text: `page-round-${i}` }, chrome.pid, 'Chrome'],
        ['browser click #s', 'browser', { action: 'click', selector: '#s' }, chrome.pid, 'Chrome'],
      ] : []),
    ];
    for (const [label, tool, a, pid, who] of acts) {
      const from = Date.now();
      const result = await call(tool, a);
      await sleep(GAP_MS);
      const s = line('BACKGROUND', label, result, from, pid, who);
      if (s.around) bg[pid === target.pid ? 'target' : 'chrome'] = true;
    }
  }
  phases.BACKGROUND.to = Date.now();
  const userText = String(h('getvalue', u.value).value ?? '');
  const targetText = String(h('getvalue', target.pid).value ?? '');

  // ---- FOREGROUND
  say('Stop typing. Hands off the keyboard and mouse. The agent takes the foreground now. Watch for the amber glow on the screen edges.');
  await sleep(2500);
  phases.FOREGROUND = { from: Date.now() };
  let from = Date.now();
  let result = await call('window', { action: 'focus', processId: target.pid });
  await sleep(1000);
  line('FOREGROUND', 'window focus ClawdTarget', result, from, target.pid, 'ClawdTarget');
  from = Date.now();
  result = await call('computer', { action: 'type', text: ' foreground-typed' });
  await sleep(2500);
  line('FOREGROUND', 'computer type', result, from, target.pid, 'ClawdTarget');
  phases.FOREGROUND.to = Date.now();
  await sleep(4000);   // the glow fades before the pause's own

  // ---- PAUSE
  say('Pause test. Look for blue pulsing edges and a card, and no frame round any window. Then click Resume on the card.');
  phases.PAUSE = { from: Date.now() };
  const message = 'Test pause: check the blue edges, then click Resume';
  for (let i = 0; i < 2; i++) {
    from = Date.now();
    result = await call('system', { action: 'pause_for_user', message, timeout: 50 }, 70_000);
    line('PAUSE', 'system pause_for_user', result, from, target.pid, 'ClawdTarget');
    if (!/waiting/i.test(result)) break;
    if (i === 0) say('Still paused. Click Resume when you have looked.');
  }
  phases.PAUSE.to = Date.now();
  await sleep(1500);

  // ---- the table
  const inPhase = (p, pid = target.pid) => shots.filter(s => s.t >= phases[p].from && s.t <= phases[p].to).map(s => seen(s, pid));
  const w = samples.filter(s => s.t >= phases.BACKGROUND.from && s.t <= phases.BACKGROUND.to);
  const steals = w.filter((s, i) => agents.has(s.pid) && !(i > 0 && w[i - 1].pid === s.pid)).length;
  // Paused: from the first snapshot that shows the pause's glow, so the hand-over half-second is not held against it.
  const paused = inPhase('PAUSE');
  const blue = paused.slice(Math.max(0, paused.findIndex(s => s.glow)));
  const rows = [
    ['outline round ClawdTarget in background', bg.target],
    ['outline round Chrome in background', chrome.pid ? bg.chrome : null],
    ['no glow in background', !inPhase('BACKGROUND').some(s => s.glow)],
    ['glow in foreground', inPhase('FOREGROUND').some(s => s.glow)],
    ['glow and no outline in pause', paused.some(s => s.glow) && !blue.some(s => s.outlines.length > 0)],
    [`focus steals during background = 0 (${steals})`, steals === 0],
    [`user's typing intact (${JSON.stringify(userText.slice(0, 60))}; ClawdField ${JSON.stringify(targetText)})`,
      userText.includes(USER_TEXT) && !/agent-round|page-round|warm-up/.test(userText) && targetText === `agent-round-${ROUNDS}`],
  ];
  log('\nRESULT');
  for (const [what, ok] of rows) log(`  ${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${what}`);
  log(`  (${shots.length} overlay snapshots, ${samples.length} frontmost samples)`);
  say(rows.every(r => r[1] !== false) ? 'Test finished. Everything passed.' : 'Test finished. Some checks failed.');
  if (rows.some(r => r[1] === false)) process.exitCode = 1;
}

// Every exit (done, error, hard timeout, SIGINT / SIGTERM) goes through the one `finally`: Chrome's stop() is async.
let abort;
const aborted = new Promise((_, rej) => { abort = () => rej(new Error(fatal)); });
const timer = setTimeout(() => { fatal = fatal ?? `hard timeout ${HARD_TIMEOUT_MS / 1000} s`; abort(); }, HARD_TIMEOUT_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fatal = fatal ?? `interrupted (${sig})`; abort(); });
try { await Promise.race([run(), aborted]); } catch (e) { fatal = fatal ?? (e instanceof Error ? e.message : String(e)); }
finally {
  clearTimeout(timer);
  for (const c of cleanups.reverse()) { try { await Promise.race([c(), sleep(6000)]); } catch { /* closing */ } }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
}
if (fatal) { log('FAILED: ' + fatal); if (report.length) log('(the lines above are what ran before it)'); }
process.exit(fatal ? 1 : process.exitCode ?? 0);
