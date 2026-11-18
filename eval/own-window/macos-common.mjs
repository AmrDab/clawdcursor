// Shared by probe-macos.mjs and live-macos.mjs: compile the Swift helper, call it, start a sampler, our own Chrome, CDP.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const helperSwift = path.join(here, 'macos-helper.swift');
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const PAGE = '<!doctype html><meta charset="utf-8"><title>Clawd test page</title>\n'
  + '<label for="n">Your name</label> <input id="n" aria-label="Your name" autofocus>\n'
  + '<button id="s" onclick="document.getElementById(\'out\').textContent=\'CLICKED\'">Send</button>\n'
  + '<button id="r" onclick="document.getElementById(\'n\').value=\'\';document.getElementById(\'out\').textContent=\'\'">Reset</button>\n'
  + '<p id="out"></p>\n';

export function compileHelper(dir) {
  const bin = path.join(dir, 'macos-helper');
  const r = spawnSync('swiftc', ['-O', helperSwift, '-o', bin], { encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error('swiftc failed: ' + String(r.stderr || r.error).slice(0, 800));
  return bin;
}

/** One helper command -> {ok, value|err}. */
export const makeH = bin => (...a) => {
  const r = spawnSync(bin, a.map(String), { encoding: 'utf8', timeout: 20_000 });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { ok: false, err: 'helper: ' + String(r.stderr || r.stdout || r.error || 'no output').slice(0, 200) }; }
};

/** A window of our own ("user" or "target"): resolves {child, pid}. */
export function launchWin(bin, kind) {
  const child = spawn(bin, ['win', kind], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${kind} window did not start`)), 10_000);
    child.stdout.once('data', d => { clearTimeout(t); try { res({ child, pid: JSON.parse(String(d).trim().split('\n')[0]).value }); } catch (e) { rej(e); } });
  });
}

/** Frontmost app + real cursor every 50 ms into `samples` ({t, pid, x, y, name}). */
export function startSampler(bin, samples) {
  const child = spawn(bin, ['watch', '50'], { stdio: ['ignore', 'pipe', 'inherit'] });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const p = line.split('|');
    if (p[0] === 'S' && p.length === 6) samples.push({ t: +p[1], pid: +p[2], x: +p[3], y: +p[4], name: p[5] });
  });
  return child;
}

/** Chrome as its own instance: a temp profile, incognito, its own debug port, a local page. Never the owner's Chrome. */
export async function startChrome(dir) {
  if (!fs.existsSync(CHROME)) return { skip: 'Google Chrome not found' };
  const server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const pagePort = server.address().port;
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(CHROME, [`--user-data-dir=${path.join(dir, 'chrome')}`, '--incognito', '--new-window', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--force-renderer-accessibility', `--remote-debugging-port=${port}`, `http://127.0.0.1:${pagePort}/`], { stdio: 'ignore' });
  child.on('error', () => {});
  const stop = async () => {
    try { await Promise.race([cdp(port, [['Browser.close', {}]]), sleep(3000)]); } catch { /* closing */ }   // bounded: the kill below always runs
    await sleep(500);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    server.close();
  };
  for (let i = 0; ; i++) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${pagePort}`))) break; } catch { /* not up yet */ }
    if (i === 60) { await stop(); return { skip: 'Chrome did not open the test page on its debug port' }; }
    await sleep(250);
  }
  return { pid: child.pid, port, pagePort, stop };
}

/** Run CDP commands in order on the test page; returns the last result's value. */
export async function cdp(port, steps) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1')).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('page websocket')); });
  const pending = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    const resolve = Number.isInteger(d?.id) ? pending.get(d.id) : undefined;   // only a reply to one of our own ids
    if (typeof resolve === 'function') resolve(d);
  };
  let last = null;
  for (const [i, [method, params]] of steps.entries()) {
    const p = new Promise(res => pending.set(i + 1, res));
    ws.send(JSON.stringify({ id: i + 1, method, params }));
    last = await Promise.race([p, sleep(5000).then(() => null)]);
  }
  ws.close();
  return last?.result?.result?.value ?? last?.result ?? null;
}
