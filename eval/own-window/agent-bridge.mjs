// A localhost bridge for agent B: one persistent clawdcursor MCP server (the branch build), tools called over plain HTTP.
// POST /call {"name":"accessibility","arguments":{...}} -> the tool result text.  GET /tools -> names + descriptions.
// POST /done ends it. Every request sends header X-Bridge-Token: the contents of <dir>/bridge-ready.
import fs from 'fs'; import path from 'path'; import http from 'http'; import crypto from 'crypto'; import { fileURLToPath, pathToFileURL } from 'url';
import { allowedPids, outOfScope } from './bridge-scope.mjs';
const dir = process.argv[2];
const root = fileURLToPath(new URL('../..', import.meta.url));
const sdk = f => import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');
const s = JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8'));
// Scope, always on: agent B may call only accessibility addressed to this run's own pids, and browser (bridge-scope.mjs).
const pids = allowedPids(s);
const t = new StdioClientTransport({ command: process.execPath, args: [s.cli, 'mcp', '--compact'], env: { ...process.env, ...s.env }, cwd: s.env.HOME, stderr: 'pipe' });
t.stderr?.on('data', () => {});
const c = new Client({ name: 'agent-b', version: '1' }); await c.connect(t);
const tools = (await c.listTools()).tools;
// Only the agent that read <dir>/bridge-ready may call: a per-run secret in X-Bridge-Token, no browser Origin, the exact
// Host (no DNS rebinding). A web page could otherwise POST to this port and drive the desktop.
const token = crypto.randomBytes(32).toString('hex');
http.createServer(async (req, res) => {
  const ok = req.headers['x-bridge-token'] === token && !req.headers.origin && req.headers.host === '127.0.0.1:8766'
    && (req.url === '/tools'                                                        // GET, no body
      || (req.url === '/done' && req.method === 'POST')                             // POST, no body needed
      || (req.url === '/call' && req.method === 'POST' && String(req.headers['content-type']).startsWith('application/json')));
  if (!ok) { res.statusCode = 403; res.end('forbidden'); return; }
  let body = ''; for await (const ch of req) body += ch;
  try {
    if (req.url === '/tools') { res.end(JSON.stringify(tools.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })))); return; }
    if (req.url === '/done') { fs.writeFileSync(path.join(dir, 'done'), '0'); res.end('ok'); setTimeout(async () => { await c.close().catch(() => {}); process.exit(0); }, 300); return; }
    if (req.url !== '/call') { res.statusCode = 404; res.end('not found'); return; }
    const { name, arguments: a } = JSON.parse(body);
    const refused = outOfScope(name, a, pids);
    if (refused) {   // never reaches the server; still one line in calls.jsonl
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ t: Date.now(), tool: name, action: a?.action ?? null, image: false, route: null, error: true, blocked: true }) + '\n');
      res.statusCode = 403; res.end(refused); return;
    }
    const r = await c.callTool({ name, arguments: a ?? {} }, undefined, { timeout: 60000 });
    const text = (r.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    // One line per call, for the report: did the agent see the screen as pixels (a screenshot / image) or by name?
    const image = (r.content ?? []).some(x => x.type === 'image');
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ t: Date.now(), tool: name, action: a?.action ?? null, image, route: (text.match(/\((R[0-3][^()\n]*|CDP page act[^()\n]*)\)/) ?? [])[1] ?? null, error: r.isError === true }) + '\n');
    res.end(text);
  } catch (e) { res.statusCode = 500; res.end('bridge error: ' + e.message); }
}).listen(8766, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'bridge-ready'), token, { mode: 0o600 }));
