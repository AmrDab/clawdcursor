// clawdcursor live suite — macOS. Drives the real MCP server (compact surface)
// over stdio like an agent host, and scores every result against ground truth:
// the target app's own log (exact global click points), screencapture, pbpaste
// and System Events. Coordinates: the target logs TOP-LEFT global POINTS;
// screenshots are physical pixels (points × backing scale), scaled to the image.
//   node suite-mac.mjs perception <label> | tasks <label>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import sharp from 'sharp';

const [MODE, LABEL] = process.argv.slice(2);
const OUT = `${process.env.SUITE_OUT || '/tmp/suite'}/${LABEL}`;
fs.mkdirSync(OUT, { recursive: true });
const LOG = '/tmp/cc-target.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => { try { return execSync(c, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return 'ERR ' + String(e.stderr || e.message).trim().slice(0, 200); } };
const osa = s => sh(`osascript -e '${s.replace(/'/g, `'"'"'`)}'`);
const events = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const since = (t, ev) => events().filter(e => e.t >= t && (!ev || e.ev === ev));
const layout = () => events().filter(e => e.ev === 'layout').pop();
const now = () => Date.now() / 1000;
const front = () => osa('tell application "System Events" to set p to first process whose frontmost is true\nreturn name of p');
const winState = () => osa('tell application "System Events" to tell process "cctarget" to get {position, size, value of attribute "AXMinimized"} of window "CC Target"');

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/surface/cli.js', 'mcp', '--compact'],
  env: { ...process.env, CLAWD_BATCH_ALLOW_CONFIRM: '1' }, stderr: 'pipe',
});
let serverErr = '';
transport.stderr?.on('data', d => { serverErr += d; });
const client = new Client({ name: 'cc-suite-mac', version: '1' });
await client.connect(transport);

const calls = [], checks = [];
let n = 0;
async function call(tool, args) {
  const id = String(++n).padStart(3, '0');
  const t0 = Date.now();
  let text = '', isError = false, img = null, threw = null;
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90000 });
    isError = !!r.isError;
    for (const c of r.content || []) {
      if (c.type === 'text') text += (text ? '\n' : '') + c.text;
      if (c.type === 'image') { img = Buffer.from(c.data, 'base64'); fs.writeFileSync(`${OUT}/${id}.png`, img); }
    }
  } catch (e) { threw = String(e.message || e).slice(0, 300); isError = true; }
  calls.push({ id, tool, args, ms: Date.now() - t0, isError, threw, text: text.slice(0, 1500) });
  console.log(`  [${id}] ${tool} ${JSON.stringify(args).slice(0, 140)} → ${isError ? 'ERR ' : ''}${(threw || text).replace(/\s+/g, ' ').slice(0, 220)} (${Date.now() - t0}ms)`);
  return { text, isError, img, id };
}
function check(area, name, pass, detail) {
  checks.push({ area, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${area}] ${name} — ${detail}`);
}
const boundsOf = t => { const m = /@(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(t || ''); return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null; };
const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const jsonOf = t => { try { return JSON.parse(t); } catch { const m = /\{[\s\S]*\}/.exec(t || ''); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } };
async function samplePng(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const acc = [0, 0, 0]; let k = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.min(info.width - 1, Math.max(0, Math.round(x) + dx)), py = Math.min(info.height - 1, Math.max(0, Math.round(y) + dy));
    const i = (py * info.width + px) * info.channels;
    for (let c = 0; c < 3; c++) acc[c] += data[i + c];
    k++;
  }
  return acc.map(v => Math.round(v / k));
}
const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Wider tolerance than Linux: screencapture applies the display's colour profile.
function classify(got, exp) {
  if (cdist(got, exp) < 60) return 'exact';
  if (cdist(got, [exp[2], exp[1], exp[0]]) < 60) return 'bgr-swapped';
  if (got[0] + got[1] + got[2] < 30) return 'black';
  return `other(${got.join(',')})`;
}

async function perception() {
  const L = layout();
  if (!L) { check('setup', 'target layout', false, 'no layout event'); return; }
  const dpi = L.screen.scale;
  { const d = await call('window', { action: 'list_displays' });
    const disp = jsonOf(d.text);
    const first = Array.isArray(disp) ? disp[0] : null;
    check('display', 'list_displays matches NSScreen', first && Math.round(first.bounds.width) === Math.round(L.screen.w) && Math.abs((first.dpiRatio || 1) - dpi) < 0.01,
      `clawdcursor=${JSON.stringify(first?.bounds)} dpi=${first?.dpiRatio} | NSScreen ${L.screen.w}x${L.screen.h} @${dpi}x`); }
  const ss = jsonOf((await call('window', { action: 'screen_size' })).text) || {};
  const sscale = ss.screenshotScaleFactor || 1;
  check('display', 'screen_size = NSScreen × backing scale', Math.round(ss.physicalWidth) === Math.round(L.screen.w * dpi), `physical ${ss.physicalWidth}x${ss.physicalHeight}, screenshotScale=${sscale}, mouseScale=${ss.mouseScaleFactor}`);
  const toImg = p => ({ x: p.x * dpi / sscale, y: p.y * dpi / sscale });

  const shot = await call('computer', { action: 'screenshot' });
  if (shot.img) {
    const meta = await sharp(shot.img).metadata();
    check('screenshot', 'image size = physical/scale', Math.abs(meta.width - ss.physicalWidth / sscale) <= 1, `${meta.width}x${meta.height}`);
    sh(`screencapture -x /tmp/ref-${LABEL}.png`);
    const ref = fs.existsSync(`/tmp/ref-${LABEL}.png`) ? fs.readFileSync(`/tmp/ref-${LABEL}.png`) : null;
    const kinds = {};
    for (const [name, sq] of Object.entries(L.squares)) {
      const c = center(sq);
      const truth = ref ? classify(await samplePng(ref, c.x * dpi, c.y * dpi), sq.rgb) : 'no-ref';
      const ip = toImg(c);
      kinds[name] = `${classify(await samplePng(shot.img, ip.x, ip.y), sq.rgb)} (ref ${truth})`;
    }
    check('screenshot', 'colors at known positions', Object.values(kinds).every(k => k.startsWith('exact')), JSON.stringify(kinds));
  } else check('screenshot', 'returns an image', false, shot.text.slice(0, 300));

  const cv = L.canvas; const ic = toImg(cv);
  const reg = await call('computer', { action: 'screenshot_region', x: Math.round(ic.x), y: Math.round(ic.y), width: Math.round(cv.w * dpi / sscale), height: Math.round(cv.h * dpi / sscale) });
  if (reg.img) {
    const meta = await sharp(reg.img).metadata();
    const sq = L.squares.green; const c = center(sq);
    const got = await samplePng(reg.img, (c.x - cv.x) * meta.width / cv.w, (c.y - cv.y) * meta.height / cv.h);
    check('screenshot', 'region crop lands on the right pixels', ['exact', 'bgr-swapped'].includes(classify(got, sq.rgb)), `${meta.width}x${meta.height}, green → ${classify(got, sq.rgb)}`);
  } else check('screenshot', 'region returns an image', false, reg.text.slice(0, 300));

  const errs = []; const tol = sscale / dpi / 2 + 1.5;
  for (const [name, sq] of Object.entries(L.squares)) {
    for (const [tag, p] of [['center', center(sq)], ['corner+8', { x: sq.x + 8, y: sq.y + 8 }]]) {
      const t = now(); const ip = toImg(p);
      await call('computer', { action: 'click', x: Math.round(ip.x), y: Math.round(ip.y) });
      await sleep(300);
      const ev = since(t, 'canvas_click').pop();
      if (!ev) { errs.push(`${name}/${tag}: no click received`); continue; }
      const e = dist({ x: ev.x_root, y: ev.y_root }, p);
      errs.push(`${name}/${tag}: hit=${ev.hit} err=${e.toFixed(1)}pt`);
      if (ev.hit !== name || e > tol) errs.push(`  ^ OUT OF TOLERANCE (allow ${tol.toFixed(1)}pt)`);
    }
  }
  check('coords', 'image-space clicks land on target (12 clicks)', !errs.some(e => /OUT OF|no click/.test(e)), errs.join('; '));

  { const p = center(L.squares.magenta); const t = now();
    await call('computer', { action: 'click', x: Math.round(p.x), y: Math.round(p.y), space: 'screen' }); await sleep(300);
    const ev = since(t, 'canvas_click').pop();
    check('coords', "space:'screen' click lands on the a11y point", ev && dist({ x: ev.x_root, y: ev.y_root }, { x: Math.round(p.x), y: Math.round(p.y) }) <= 1, ev ? `hit=${ev.hit} at ${ev.x_root},${ev.y_root} want ${Math.round(p.x)},${Math.round(p.y)}` : 'no click'); }

  for (const nm of ['Bravo', 'Submit', 'First name']) {
    const f = await call('accessibility', { action: 'find', name: nm });
    const b = boundsOf(f.text), truth = L.widgets[nm];
    check('a11y', `find "${nm}" bounds match real widget`, b && truth && Math.abs(b.x - truth.x) <= 3 && Math.abs(b.y - truth.y) <= 3 && Math.abs(b.w - truth.w) <= 3, `a11y=${JSON.stringify(b)} real=${JSON.stringify(truth)}`);
  }
  { const f = await call('accessibility', { action: 'find', name: 'Bravo' }); const b = boundsOf(f.text);
    if (b) { const t = now(); const c = center(b);
      await call('computer', { action: 'click', x: Math.round(c.x), y: Math.round(c.y), space: 'screen' }); await sleep(300);
      check('a11y', 'click at a11y-reported center activates the button', since(t, 'button').some(e => e.name === 'Bravo'), `clicked ${Math.round(c.x)},${Math.round(c.y)}`); }
    else check('a11y', 'click at a11y-reported center activates the button', false, 'no bounds from find'); }

  for (const [label, args, want] of [
    ['invoke by name', { action: 'invoke', name: 'Charlie' }, 'Charlie'],
    ['smart_click', { action: 'smart_click', target: 'Delta' }, 'Delta'],
  ]) { const t = now(); const r = await call('accessibility', args); await sleep(400);
    check('a11y', label, since(t, 'button').some(e => e.name === want), r.text.replace(/\s+/g, ' ').slice(0, 160)); }
  { const fb = jsonOf((await call('accessibility', { action: 'find_button', intent: 'Alpha' })).text);
    const id = fb?.best?.element_id; const t = now();
    if (id) await call('accessibility', { action: 'invoke', element_id: id, snapshot_id: fb.snapshot_id });
    await sleep(400);
    check('a11y', 'find_button → invoke(element_id)', since(t, 'button').some(e => e.name === 'Alpha'), `best=${JSON.stringify(fb?.best || fb).slice(0, 160)}`); }

  { const o = jsonOf((await call('system', { action: 'ocr' })).text);
    const el = (o?.elements || []).find(e => /Reveal/.test(e.text));
    const truth = L.widgets.Reveal;
    check('ocr', 'finds "Reveal" text', !!el, el ? JSON.stringify(el) : `elements=${o?.elements?.length ?? 'parse-failed'} hint=${o?.hint || ''}`);
    if (el) { const bx = { x: el.x / dpi, y: el.y / dpi, w: el.width / dpi, h: el.height / dpi };
      check('ocr', 'OCR box lies inside the real button', bx.x >= truth.x - 4 && bx.y >= truth.y - 4 && bx.x + bx.w <= truth.x + truth.w + 4 && bx.y + bx.h <= truth.y + truth.h + 4, `ocr(pt)=${JSON.stringify(bx)} button=${JSON.stringify(truth)}`); } }

  { const r = await call('accessibility', { action: 'compile_ui' });
    const unknown = (r.text.match(/\[unknown\]/g) || []).length, total = (r.text.match(/el_\d+/g) || []).length;
    check('a11y', 'compile_ui assigns roles', total > 0 && unknown / total < 0.5, `${unknown}/${total} elements have role "unknown"`); }
}

async function tasks() {
  const L = layout();
  { const t = now();
    const ff = jsonOf((await call('accessibility', { action: 'find_field', intent: 'First name' })).text);
    if (ff?.best?.element_id) await call('accessibility', { action: 'set_value', element_id: ff.best.element_id, snapshot_id: ff.snapshot_id, value: 'Ada' });
    else await call('accessibility', { action: 'set_value', name: 'First name', value: 'Ada' });
    await call('accessibility', { action: 'set_value', name: 'Email', value: 'ada@example.com' });
    await call('accessibility', { action: 'toggle', name: 'Subscribe' });
    await call('accessibility', { action: 'smart_click', target: 'Submit' });
    await sleep(500);
    const s = since(t, 'submit').pop();
    check('task', 'T1 form fill via a11y (set_value/toggle/click)', s && s.first === 'Ada' && s.email === 'ada@example.com' && s.subscribe === true, JSON.stringify(s || 'no submit')); }
  { const t = now(); const w = L.widgets;
    for (const [nm, val] of [['First name', 'Grace'], ['Email', 'grace@example.com']]) {
      const c = center(w[nm]);
      await call('computer', { action: 'click', x: Math.round(c.x), y: Math.round(c.y), space: 'screen' });
      await call('computer', { action: 'key', combo: 'mod+a' });
      await call('computer', { action: 'type', text: val });
    }
    const c = center(w.Submit); await call('computer', { action: 'click', x: Math.round(c.x), y: Math.round(c.y), space: 'screen' });
    await sleep(500);
    const s = since(t, 'submit').pop();
    check('task', 'T1b form fill via coords+keyboard', s && s.first === 'Grace' && s.email === 'grace@example.com', JSON.stringify(s || 'no submit')); }
  { await call('accessibility', { action: 'smart_click', target: 'Reveal' });
    const w = await call('accessibility', { action: 'wait_for', name: 'Secret code: 4729', timeout: 6000 });
    const r = await call('accessibility', { action: 'find', name: 'Secret code' });
    check('task', 'T2 wait_for delayed element then read it', !w.isError && /4729/.test(r.text), `wait=${w.text.slice(0, 80)} find=${r.text.slice(0, 80)}`); }
  { const t0 = now();
    const f = await call('accessibility', { action: 'find', name: 'Row 50' });
    let r = await call('accessibility', { action: 'invoke', name: 'Row 50' }); await sleep(300);
    let ok = since(t0, 'row').some(e => e.name === 'Row 50'); let scrolls = 0;
    const list = { x: L.canvas.x + 470, y: L.canvas.y + 200 };
    while (!ok && scrolls < 8) {
      await call('computer', { action: 'scroll', x: Math.round(list.x), y: Math.round(list.y), direction: 'down', amount: 5, space: 'screen' }); scrolls++;
      const t = now(); r = await call('accessibility', { action: 'smart_click', target: 'Row 50' }); await sleep(300);
      ok = since(t, 'row').some(e => e.name === 'Row 50');
      if (!ok && since(t, 'row').length) { r = { text: `WRONG ROW clicked: ${JSON.stringify(since(t, 'row'))}` }; break; }
    }
    check('task', 'T3 reach + activate an offscreen list row', ok, `find: ${f.text.slice(0, 90).replace(/\s+/g, ' ')}; scrolls=${scrolls}; last=${r.text.slice(0, 140).replace(/\s+/g, ' ')}`); }
  { const name = `cc-note-${Date.now()}`;
    await call('window', { action: 'open_app', name: 'TextEdit' }); await sleep(3000);
    await call('computer', { action: 'key', combo: 'Escape' });
    await call('computer', { action: 'key', combo: 'mod+n' }); await sleep(1000);
    await call('computer', { action: 'type', text: 'Saved by clawdcursor' });
    await call('computer', { action: 'key', combo: 'mod+s' }); await sleep(1500);
    await call('computer', { action: 'key', combo: 'mod+a' });
    await call('computer', { action: 'type', text: name });
    await call('computer', { action: 'key', combo: 'Return' }); await sleep(2000);
    const hit = sh(`grep -l "Saved by clawdcursor" ~/Documents/${name}.* ~/Library/Containers/com.apple.TextEdit/Data/Documents/${name}.* 2>/dev/null | head -1`);
    check('task', 'T4 TextEdit: type + save through the native save sheet', hit && !hit.startsWith('ERR'), `file=${hit || 'not found'}`);
    await call('computer', { action: 'key', combo: 'mod+a' });
    await call('computer', { action: 'key', combo: 'mod+c' });
    await call('window', { action: 'focus', title: 'CC Target' }); await sleep(500);
    const c = center(L.widgets['First name']);
    await call('computer', { action: 'click', x: Math.round(c.x), y: Math.round(c.y), space: 'screen' });
    await call('computer', { action: 'key', combo: 'mod+a' });
    await call('computer', { action: 'key', combo: 'mod+v' });
    const t = now(); await call('accessibility', { action: 'smart_click', target: 'Submit' }); await sleep(500);
    const s = since(t, 'submit').pop();
    check('task', 'T5 copy in TextEdit, paste into another app', s?.first === 'Saved by clawdcursor', `${JSON.stringify(s || 'no submit')} clipboard=${JSON.stringify(sh('pbpaste').slice(0, 40))}`); }
  { await call('window', { action: 'resize', title: 'CC Target', x: 60, y: 80, width: 800, height: 600 }); await sleep(600);
    check('window', 'resize/move applied', /1000, 700/.test(winState()) || /1000,\s*700/.test(winState()), winState());
    await call('window', { action: 'minimize', title: 'CC Target' }); await sleep(800);
    check('window', 'minimize applied', /true$/.test(winState()), winState());
    await call('window', { action: 'restore', title: 'CC Target' }); await sleep(800);
    check('window', 'restore un-minimizes', /false$/.test(winState()), winState());
    await call('window', { action: 'focus', title: 'CC Target' }); await sleep(500);
    check('window', 'focus by title', front() === 'cctarget', `frontmost=${front()}`);
    await call('window', { action: 'focus', processName: 'TextEdit' }); await sleep(500);
    check('window', 'focus by process name', front() === 'TextEdit', `frontmost=${front()}`);
    const lst = await call('window', { action: 'list' });
    check('window', 'list reports process names', /cctarget/.test(lst.text) && /TextEdit/.test(lst.text), lst.text.split('\n').slice(0, 4).join(' | '));
    await call('window', { action: 'focus', title: 'CC Target' }); await sleep(400); }
  { const nav = await call('window', { action: 'navigate', url: 'http://localhost:8765/form.html' }); await sleep(5000);
    const con = await call('browser', { action: 'connect' });
    await call('browser', { action: 'page_context' });
    await call('browser', { action: 'type', label: 'City', text: 'Paris' });
    await call('browser', { action: 'select_option', selector: '#size', value: 'L' });
    await call('batch', { allowConfirm: true, steps: [{ name: 'browser', arguments: { action: 'click', text: 'Send' } }] }); await sleep(600);
    const res = await call('browser', { action: 'read_text', selector: '#result' });
    check('browser', 'T7 fill + submit a web form over CDP (Chrome)', /OK Paris L/.test(res.text), `nav=${nav.text.slice(0, 70).replace(/\s+/g, ' ')} | connect=${con.text.slice(0, 60)} | result=${res.text.slice(0, 80)}`);
    const tabs = await call('browser', { action: 'list_tabs' });
    check('browser', 'list_tabs', !tabs.isError && /CC Form/.test(tabs.text), tabs.text.slice(0, 120).replace(/\s+/g, ' '));
    await call('window', { action: 'focus', title: 'CC Target' }); await sleep(500); }
  { const t = now();
    const b = await call('batch', { steps: [
      { name: 'accessibility', arguments: { action: 'smart_click', target: 'Alpha' }, expect: { window: 'CC Target' } },
      { name: 'accessibility', arguments: { action: 'smart_click', target: 'Bravo' }, expect: { window: 'No Such Window' } },
      { name: 'accessibility', arguments: { action: 'smart_click', target: 'Charlie' } },
    ] }); await sleep(400);
    const names = since(t, 'button').map(e => e.name);
    check('batch', 'executes guarded step, halts at failed precondition', names.includes('Alpha') && !names.includes('Bravo') && !names.includes('Charlie'), `clicked=${JSON.stringify(names)}; ${b.text.replace(/\s+/g, ' ').slice(0, 160)}`); }
  { for (const combo of ['cmd+opt+esc', 'cmd+ctrl+q', 'cmd+q']) {
      const r = await call('computer', { action: 'key', combo });
      check('safety', `${combo} is blocked`, r.isError && /block/i.test(r.text), r.text.slice(0, 110)); }
    const r2 = await call('system', { action: 'clipboard_write', text: 'x' });
    check('safety', 'clipboard_write needs confirmation', r2.isError && /confirm/i.test(r2.text), r2.text.slice(0, 100));
    const r3 = await call('window', { action: 'close', title: 'CC Target' }); await sleep(600);
    check('safety', 'window close needs confirmation (target still open)', !/ERR/.test(winState()), r3.text.slice(0, 120));
    const r4 = await call('computer', { action: 'key', combo: 'x" & (do shell script "touch /tmp/pwned") & "' });
    check('safety', 'AppleScript-injection key name refused, nothing ran', r4.isError && !fs.existsSync('/tmp/pwned'), r4.text.slice(0, 120)); }
  { const r = await call('computer', { action: 'key', combo: 'Escape', expect: [{ type: 'window_title_contains', value: 'CC Target' }] });
    check('verify', 'expect passes when true', !r.isError, r.text.slice(0, 100));
    const r2 = await call('computer', { action: 'key', combo: 'Escape', expect: [{ type: 'window_title_contains', value: 'Nope Window' }] });
    check('verify', 'expect reports DEVIATION when false', r2.isError && /DEVIATION/.test(r2.text), r2.text.slice(0, 100));
    const r3 = await call('computer', { action: 'key', combo: 'Escape', expect: 'not json' });
    check('verify', 'malformed expect refused before acting', r3.isError && /nothing executed/.test(r3.text), r3.text.slice(0, 100)); }
}

console.log(`== ${MODE} ${LABEL}  macOS ${sh('sw_vers -productVersion')} ${os.arch()}`);
try { if (MODE === 'perception') await perception(); else await tasks(); }
catch (e) { check('harness', 'suite crashed', false, String(e.stack || e).slice(0, 400)); }
fs.writeFileSync(`${OUT}/checks.json`, JSON.stringify(checks, null, 2));
fs.writeFileSync(`${OUT}/calls.json`, JSON.stringify(calls, null, 2));
fs.writeFileSync(`${OUT}/server-stderr.log`, serverErr);
console.log(`== ${LABEL}: ${checks.filter(c => c.pass).length}/${checks.length} checks passed`);
await client.close().catch(() => {});
process.exit(0);
