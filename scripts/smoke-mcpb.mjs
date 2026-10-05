#!/usr/bin/env node
/**
 * Smoke-test the built extension the way Claude Desktop runs it: start the
 * server from build/mcpb/clawdcursor with the manifest's own command, over
 * MCP stdio, in a throwaway home directory.
 *   1. install checkbox OFF  → every tool refuses with the consent prompt
 *   2. install checkbox ON   → consent is recorded, all tools are listed and
 *                              a read-only call succeeds
 * Needs a display on Linux (run under xvfb-run in CI).
 *
 * Usage:  node scripts/smoke-mcpb.mjs   (after scripts/build-mcpb.mjs)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'build', 'mcpb', 'clawdcursor');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const cfg = manifest.server.mcp_config;
const args = cfg.args.map(a => a.replace('${__dirname}', dir));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcpb-'));

async function connect(consent) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAWDCURSOR_CONSENT: consent };
  const transport = new StdioClientTransport({ command: process.execPath, args, env, cwd: home, stderr: 'pipe' });
  const client = new Client({ name: 'mcpb-smoke', version: '1' });
  await client.connect(transport);
  return client;
}

let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

const off = await connect('false');
const refused = await off.callTool({ name: 'system', arguments: { action: 'system_time' } });
check(refused.isError && /consent/i.test(refused.content?.[0]?.text ?? ''), 'checkbox off: tools refuse with the consent prompt');
await off.close();

const on = await connect('true');
const { tools } = await on.listTools();
const want = manifest.tools.map(t => t.name).sort();
check(JSON.stringify(tools.map(t => t.name).sort()) === JSON.stringify(want), `serves the manifest's tools (${want.join(', ')})`);
const time = await on.callTool({ name: 'system', arguments: { action: 'system_time' } });
check(!time.isError, 'checkbox on: a tool call succeeds');
check(fs.existsSync(path.join(home, '.clawdcursor', 'consent')), 'checkbox on: consent recorded');
await on.close();

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
