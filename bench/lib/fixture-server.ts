/**
 * The fixture HTTP server: serves the web fixtures on 127.0.0.1 and records what each page reports about itself.
 *
 * A page is opened as /<page>.html?run=<id>. Its recorder (bench.js) POSTs every interaction and a snapshot of the page's
 * state to /api/state?run=<id>. The scorer reads that state: success is never judged from what the agent says.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { FixtureEvent, FixtureState } from './types';

export const WEB_DIR = path.join(__dirname, '..', 'fixtures', 'web');
export const WEB_PAGES = ['form', 'trap', 'timing', 'canvas', 'longread'] as const;

const STATIONS = 40;
/** The reference code of station Delta-<n> on the reading page: fixed, and close to its neighbours' codes. */
export function stationCode(n: number): string {
  let x = (n * 2654435761) >>> 0;
  const next = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x; };
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l = () => letters[next() % letters.length];
  return `QX-${4400 + (next() % 90)}-${l()}${l()}`;
}

const WORDS = ('survey station relay channel signal ridge valley sensor archive ledger window margin copper granite '
  + 'harbour lantern meadow orbit pilot quarry river summit timber upland vessel willow yard zenith').split(' ');

/** The long page: filler paragraphs, a table of stations and codes in the middle, an answer field at the end. */
export function renderLongread(): string {
  let seed = 20261111;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  const paragraph = (i: number) => {
    const words = Array.from({ length: 60 }, () => WORDS[rnd() % WORDS.length]).join(' ');
    return `<p>Section ${i}. ${words}.</p>`;
  };
  const rows = Array.from({ length: STATIONS }, (_, i) => `<tr><td>Delta-${i + 1}</td><td>${stationCode(i + 1)}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bench Reading</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
table{border-collapse:collapse}td,th{border:1px solid #888;padding:2px 10px}input,button{font:inherit;padding:4px 8px}</style></head>
<body>
<h1>Bench Reading</h1>
<p>Field notes of the Delta survey. The station table is in the middle of this page; the answer field is at the end.</p>
${Array.from({ length: 60 }, (_, i) => paragraph(i + 1)).join('\n')}
<h2>Station reference codes</h2>
<table><thead><tr><th>Station</th><th>Reference code</th></tr></thead><tbody>
${rows}
</tbody></table>
${Array.from({ length: 60 }, (_, i) => paragraph(i + 61)).join('\n')}
<h2>Answer</h2>
<p><label for="answer">Answer</label> <input id="answer" data-bench="answer" autocomplete="off">
<button id="submit" data-bench="submit" type="button">Submit</button> <span id="status" role="status"></span></p>
<script src="/bench.js"></script>
<script>
var submitted = null;
bench.snapshot = function () { return { answer: document.getElementById('answer').value, submitted: submitted }; };
document.getElementById('submit').addEventListener('click', function () {
  submitted = document.getElementById('answer').value.trim();
  document.getElementById('status').textContent = 'Submitted.';
});
</script>
</body></html>`;
}

interface Run { seq: number; state: Record<string, unknown>; events: Array<FixtureEvent & { seq: number }> }

export interface FixtureServer {
  port: number;
  url(page: string, run: string, query?: Record<string, string>): string;
  /** What the pages of this run reported so far. */
  state(run: string): FixtureState;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const runs = new Map<string, Run>();
  const runOf = (id: string) => {
    let r = runs.get(id);
    if (!r) { r = { seq: -1, state: {}, events: [] }; runs.set(id, r); }
    return r;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/api/state') {
      const run = url.searchParams.get('run') ?? '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) return send(400, 'bad run id');
      if (req.method === 'GET') return send(200, JSON.stringify(stateOf(run)), 'application/json');
      if (req.method !== 'POST') return send(405, 'method not allowed');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const msg = JSON.parse(body) as { seq?: number; state?: Record<string, unknown>; events?: FixtureEvent[] };
          const r = runOf(run);
          const seq = Number(msg.seq) || 0;
          const now = Date.now();
          for (const e of msg.events ?? []) r.events.push({ ...e, t: now, seq });
          // Posts can arrive out of order: the newest snapshot wins.
          if (seq > r.seq && msg.state && typeof msg.state === 'object') { r.seq = seq; r.state = msg.state; }
          send(204, '');
        } catch { send(400, 'bad json'); }
      });
      return;
    }
    if (req.method !== 'GET') return send(405, 'method not allowed');
    if (url.pathname === '/longread.html') return send(200, renderLongread(), TYPES['.html']);
    const name = url.pathname.slice(1);
    const allowed = name === 'bench.js' || WEB_PAGES.some(p => name === `${p}.html`);
    if (!allowed) return send(404, 'not found');
    fs.readFile(path.join(WEB_DIR, name), 'utf8', (err, text) => err ? send(404, 'not found') : send(200, text, TYPES[path.extname(name)]));
  });
  const stateOf = (run: string): FixtureState => {
    const r = runs.get(run);
    if (!r) return { state: {}, events: [] };
    const events = [...r.events].sort((a, b) => a.seq - b.seq).map(({ seq: _seq, ...e }) => e);
    return { state: r.state, events };
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    url: (page, run, query = {}) => `http://127.0.0.1:${bound}/${page}.html?${new URLSearchParams({ run, ...query })}`,
    state: stateOf,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
