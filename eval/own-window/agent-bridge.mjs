// A localhost bridge for agent B: one persistent clawdcursor MCP server (the branch build), tools called over plain HTTP.
// POST /call {"name":"accessibility","arguments":{...}} -> the tool result text.  GET /tools -> names + descriptions.
import fs from 'fs'; import path from 'path'; import http from 'http';
const dir = process.argv[2];
const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { Client } = await import(`file:///${root}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StdioClientTransport } = await import(`file:///${root}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const s = JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8'));
const t = new StdioClientTransport({ command: process.execPath, args: [s.cli, 'mcp', '--compact'], env: { ...process.env, ...s.env }, cwd: s.env.HOME, stderr: 'pipe' });
t.stderr?.on('data', () => {});
const c = new Client({ name: 'agent-b', version: '1' }); await c.connect(t);
const tools = (await c.listTools()).tools;
http.createServer(async (req, res) => {
  let body = ''; for await (const ch of req) body += ch;
  try {
    if (req.url === '/tools') { res.end(JSON.stringify(tools.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })))); return; }
    if (req.url === '/done') { fs.writeFileSync(path.join(dir, 'done'), '0'); res.end('ok'); setTimeout(async () => { await c.close().catch(() => {}); process.exit(0); }, 300); return; }
    const { name, arguments: a } = JSON.parse(body);
    const r = await c.callTool({ name, arguments: a ?? {} }, undefined, { timeout: 60000 });
    res.end((r.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n'));
  } catch (e) { res.statusCode = 500; res.end('bridge error: ' + e.message); }
}).listen(8766, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'bridge-ready'), '1'));
