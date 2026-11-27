/**
 * Background check: does clawdcursor do its work when the app is NOT in front? No model: the same scripted calls run
 * against the bench fixtures in each condition, through the real daemon behind the fence, and each call is judged by
 * what it did, whether the app in front changed, and whether the fixture ended in the done state.
 *
 *   front      the fixture is the window in front (control)
 *   covered    another window (a second fixture, standing in for the user's app) is in front of it
 *   minimized  the fixture is minimized, the other window in front
 *
 * App-agnostic (the native fixture of each OS and a web page in Chromium) and OS-agnostic (the same calls, by name and
 * processId). Locked screen and display off cannot be set from a script: they are checked by hand (see README).
 *
 *   npx tsx bench/background.ts --build <dir> [--out <dir>]
 *
 * Takes over the desktop while it runs, like a live bench run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveCli, startIsolated } from './lib/isolated';
import { buildNative, openFixture, openNativeFixture, type LiveFixture, type NativeBuild } from './lib/live-fixtures';
import { startFixtureServer } from './lib/fixture-server';
import { findBrowser } from './lib/browser';
import { loadTasks, evaluate } from './lib/tasks';
import { freePort } from './lib/proc';

type Condition = 'front' | 'covered' | 'minimized';
const CONDITIONS: Condition[] = ['front', 'covered', 'minimized'];

interface Probe { label: string; tool: string; args: (pid: number) => Record<string, unknown>; acts: boolean }

/** The calls, per fixture. `pid` is the process of the fixture's window. */
const PROBES: Record<string, Probe[]> = {
  'native-dialog-fill': [
    { label: 'read tree', tool: 'accessibility', acts: false, args: pid => ({ action: 'read_tree', processId: pid }) },
    { label: 'set_value Name', tool: 'accessibility', acts: true, args: pid => ({ action: 'set_value', name: 'Name', value: 'Grace Hopper', processId: pid }) },
    { label: 'smart_type Email', tool: 'accessibility', acts: true, args: pid => ({ action: 'smart_type', target: 'Email', text: 'grace@example.com', processId: pid }) },
    { label: 'select Priority', tool: 'accessibility', acts: true, args: pid => ({ action: 'select', name: 'Priority', value: 'High', processId: pid }) },
    { label: 'toggle Subscribe', tool: 'accessibility', acts: true, args: pid => ({ action: 'toggle', name: 'Subscribe', processId: pid }) },
    { label: 'invoke Apply', tool: 'accessibility', acts: true, args: pid => ({ action: 'invoke', name: 'Apply', processId: pid }) },
    { label: 'ocr (window)', tool: 'system', acts: false, args: pid => ({ action: 'ocr', scope: 'window', processId: pid }) },
    { label: 'screenshot', tool: 'computer', acts: false, args: () => ({ action: 'screenshot', max_edge: 512 }) },
  ],
  'web-form-fill': [
    { label: 'read tree', tool: 'accessibility', acts: false, args: pid => ({ action: 'read_tree', processId: pid }) },
    { label: 'set_value Full name', tool: 'accessibility', acts: true, args: pid => ({ action: 'set_value', name: 'Full name', value: 'Ada Lovelace', processId: pid }) },
    { label: 'browser type Quantity', tool: 'browser', acts: true, args: () => ({ action: 'type', selector: '#qty', text: '7' }) },
    { label: 'browser select Shipping', tool: 'browser', acts: true, args: () => ({ action: 'select_option', selector: '#shipping', value: 'Express' }) },
    { label: 'toggle Gift wrap', tool: 'accessibility', acts: true, args: pid => ({ action: 'toggle', name: 'Gift wrap', processId: pid }) },
    { label: 'browser click Newsletter', tool: 'browser', acts: true, args: () => ({ action: 'click', selector: '#newsletter' }) },
    { label: 'expand Advanced options', tool: 'accessibility', acts: true, args: pid => ({ action: 'expand', name: 'Advanced options', processId: pid }) },
    { label: 'toggle Fragile', tool: 'accessibility', acts: true, args: pid => ({ action: 'toggle', name: 'Fragile', processId: pid }) },
    { label: 'smart_type Delivery note', tool: 'accessibility', acts: true, args: pid => ({ action: 'smart_type', target: 'Delivery note', text: 'Leave at the side door', processId: pid }) },
    { label: 'invoke Confirm', tool: 'accessibility', acts: true, args: pid => ({ action: 'invoke', name: 'Confirm', processId: pid }) },
    { label: 'copy_all_text', tool: 'system', acts: false, args: () => ({ action: 'copy_all_text' }) },
    { label: 'ocr (window)', tool: 'system', acts: false, args: pid => ({ action: 'ocr', scope: 'window', processId: pid }) },
  ],
};

interface Row { condition: Condition; label: string; ok: boolean; front: string; note: string }

const text = (r: unknown) => ((r as { content?: Array<{ type: string; text?: string }> }).content ?? [])
  .filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');

async function connect(mcpUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: 'clawdcursor-background-check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 });
    return { ok: !(r as { isError?: boolean }).isError, text: text(r) };
  } catch (e) { return { ok: false, text: (e as Error).message }; }
}

/** The pid of the process in front, as clawdcursor reads it. */
async function frontPid(client: Client): Promise<number | null> {
  const t = (await call(client, 'window', { action: 'active' })).text;
  const m = /"(?:processId|pid)"\s*:\s*(\d+)/.exec(t) ?? /\bpid[ =:]+(\d+)/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** The pid that owns a window among the fixture's processes (a browser has many). */
async function windowPid(client: Client, roots: number[]): Promise<number> {
  const t = (await call(client, 'window', { action: 'list' })).text;
  for (const m of t.matchAll(/(?:processId|pid)"?\s*[:=]\s*(\d+)/gi)) if (roots.includes(Number(m[1]))) return Number(m[1]);
  return roots[0];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const { cli, version } = await resolveCli(opt('--build'));
  const outDir = opt('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-background-'));
  fs.mkdirSync(outDir, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdcursor-background-run-'));
  const server = await startFixtureServer();
  const native = await buildNative(path.join(temp, 'native'));
  if ('missing' in native) throw new Error(`native fixture: ${native.missing}`);
  const tasks = loadTasks().filter(t => t.id in PROBES);
  const rows: Row[] = [];
  const done: Array<{ task: string; condition: Condition; done: boolean }> = [];
  let n = 0;
  try {
    for (const task of tasks) {
      for (const condition of CONDITIONS) {
        const workDir = path.join(outDir, `${task.id}-${condition}`);
        fs.mkdirSync(workDir, { recursive: true });
        const fx = await openFixture(task, { server, browser: findBrowser(), native, workDir, runId: `bg${++n}-${task.id}`.slice(0, 64) });
        if ('skip' in fx) { console.log(`${task.id}: ${fx.skip}`); break; }
        let cover: LiveFixture | null = null;
        let daemon: Awaited<ReturnType<typeof startIsolated>> | null = null;
        let client: Client | null = null;
        try {
          if (condition !== 'front') cover = await openNativeFixture('editor', native as NativeBuild, path.join(workDir, 'cover'), 'Bench Cover');
          const roots = await fx.roots();
          const coverPids = cover ? await cover.roots() : [];
          daemon = await startIsolated({ cli, home: path.join(temp, `home-${n}`), sessionDir: path.join(workDir, 'sessions'),
            cdpPort: fx.cdp?.cdpPort ?? await freePort(), fencePids: [...roots, ...coverPids], logFile: path.join(workDir, 'server.log') });
          client = await connect(daemon.mcpUrl, daemon.token);
          const pid = await windowPid(client, roots);
          if (condition === 'front') await call(client, 'window', { action: 'focus', processId: pid });
          if (condition === 'minimized') await call(client, 'window', { action: 'minimize', processId: pid });
          if (cover) await call(client, 'window', { action: 'focus', processId: coverPids[0] });
          if (fx.cdp) await call(client, 'browser', { action: 'connect', port: fx.cdp.cdpPort });
          const expectFront = cover ? coverPids[0] : pid;
          for (const p of PROBES[task.id]) {
            const r = await call(client, p.tool, p.args(pid));
            const f = await frontPid(client);
            const moved = f !== null && f !== expectFront;
            rows.push({ condition, label: `${task.id}: ${p.label}`, ok: r.ok, front: f === null ? '?' : moved ? 'MOVED' : 'kept',
              note: r.text.split('\n').find(l => /\[(failed|refused|unverified|confirmed)/.test(l))?.slice(0, 90) ?? r.text.slice(0, 90).replace(/\s+/g, ' ') });
            // A call that took the front leaves it with the fixture: give it back, so the next call is judged alone.
            if (moved && cover) await call(client, 'window', { action: 'focus', processId: coverPids[0] });
          }
          const state = await fx.state();
          done.push({ task: task.id, condition, done: !!state && !!task.success && evaluate(task.success, state) });
        } finally {
          await client?.close().catch(() => undefined);
          await daemon?.stop().catch(() => undefined);
          await cover?.close().catch(() => undefined);
          await fx.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const md = [
    `# Background check: clawdcursor ${version}, ${process.platform}`, '',
    '| Task | ' + CONDITIONS.join(' | ') + ' |', '|---|' + CONDITIONS.map(() => '---').join('|') + '|',
    ...tasks.map(t => `| ${t.id} done | ${CONDITIONS.map(c => done.find(d => d.task === t.id && d.condition === c)?.done ? 'yes' : 'NO').join(' | ')} |`), '',
    '| Call | Condition | OK | App in front | Result |', '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.label} | ${r.condition} | ${r.ok ? 'yes' : 'NO'} | ${r.front} | ${r.note.replace(/\|/g, '/')} |`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'background.md'), md + '\n');
  console.log(md);
  console.log(`\nReport: ${path.join(outDir, 'background.md')}`);
}

void main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
