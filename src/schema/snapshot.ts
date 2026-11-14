/**
 * MCP schema snapshot helpers.
 *
 * The snapshot is what an agent receives, taken from the real server: createMcpServer (the path `clawdcursor mcp` and
 * the daemon use) answers `initialize` and `tools/list` over the SDK's in-memory transport, for the compact and the
 * granular surface. Nothing initializes the platform: the context is a stub and no tool is called.
 *
 * The instructions name the OS's shortcut keys, so each surface is captured once per OS (process.platform set for the
 * duration of the capture). A field that is the same on every OS is stored once; one that differs goes under `perOs`.
 * Tools and keys keep the order the wire sends them in, which the code fixes.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext } from '../tools/registry';

const OSES = ['darwin', 'linux', 'win32'] as const;
type Os = typeof OSES[number];

interface JsonRpcMessage { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: unknown }
interface LinkedTransport {
  onmessage?: (m: JsonRpcMessage) => void;
  start(): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

/** No desktop: tools/list and initialize never reach it. */
const stubContext = (): ToolContext => ({
  desktop: {} as ToolContext['desktop'], a11y: {} as ToolContext['a11y'], cdp: {} as ToolContext['cdp'], platform: undefined,
  getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
  ensureInitialized: async () => { throw new Error('the schema snapshot must not initialize the platform'); },
});

/** What `initialize` and `tools/list` return for one surface on one OS (serverInfo.version and the protocol version left out). */
async function captureOnce(compact: boolean, os: Os): Promise<Record<string, unknown>> {
  const { createMcpServer } = await import('../surface/mcp-server');
  const { resetToolCaches } = await import('../tools/registry');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js' as string) as {
    InMemoryTransport: { createLinkedPair(): [LinkedTransport, LinkedTransport] };
  };
  const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/sdk/types.js' as string) as { LATEST_PROTOCOL_VERSION: string };

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const sessionLogEnv = process.env.CLAWDCURSOR_SESSION_LOG;
  Object.defineProperty(process, 'platform', { ...platform, value: os });
  process.env.CLAWDCURSOR_SESSION_LOG = '0';  // no session file for a server nobody calls
  try {
    resetToolCaches();   // the tool lists are built on this OS, not reused from the OS captured before it
    const { server } = await createMcpServer({ compact, ctx: stubContext() });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide as never);
    const replies = new Map<number, (m: JsonRpcMessage) => void>();
    clientSide.onmessage = m => { if (typeof m.id === 'number') replies.get(m.id)?.(m); };
    await clientSide.start();
    const rpc = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      replies.set(id, m => (m.result ? resolve(m.result) : reject(new Error(`${method}: ${JSON.stringify(m.error)}`))));
      void clientSide.send({ jsonrpc: '2.0', id, method, params });
    });
    const init = await rpc(1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'schema-snapshot', version: '0' },
    });
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await rpc(2, 'tools/list', {});
    await clientSide.close();
    if (list.nextCursor !== undefined) throw new Error('tools/list is paginated; the snapshot reads only the first page');

    const serverInfo = { ...(init.serverInfo as Record<string, unknown>) };
    delete serverInfo.version;
    const result: Record<string, unknown> = { ...init, serverInfo, tools: list.tools };
    delete result.protocolVersion;
    return result;
  } finally {
    resetToolCaches();
    Object.defineProperty(process, 'platform', platform);
    if (sessionLogEnv === undefined) delete process.env.CLAWDCURSOR_SESSION_LOG;
    else process.env.CLAWDCURSOR_SESSION_LOG = sessionLogEnv;
  }
}

/**
 * One surface's captures merged: a field equal on every OS once, the rest under perOs. The fields are those of all three
 * OSes, so one that only some OS returns is kept (under perOs, absent on the others).
 */
export function mergeByOs(byOs: Record<Os, Record<string, unknown>>): Record<string, unknown> {
  const shared: Record<string, unknown> = {};
  const perOs: Record<string, Record<Os, unknown>> = {};
  for (const key of new Set([...Object.keys(byOs.win32), ...OSES.flatMap(os => Object.keys(byOs[os]))])) {
    const values = OSES.map(os => JSON.stringify(byOs[os][key]));
    if (values.every(v => v === values[0])) shared[key] = byOs.win32[key];
    else perOs[key] = Object.fromEntries(OSES.map(os => [os, byOs[os][key]])) as Record<Os, unknown>;
  }
  return { ...shared, perOs };
}

async function captureSurface(compact: boolean): Promise<Record<string, unknown>> {
  const byOs = {} as Record<Os, Record<string, unknown>>;
  for (const os of OSES) byOs[os] = await captureOnce(compact, os);
  return mergeByOs(byOs);
}

/** Serialized snapshot string — deterministic across runs and across the OS it runs on. */
export async function currentSnapshot(): Promise<string> {
  const payload = { version: 2, surfaces: { compact: await captureSurface(true), granular: await captureSurface(false) } };
  return JSON.stringify(payload, null, 2) + '\n';
}

/** Tool count per surface, for the script's summary line. */
export function toolCounts(snapshot: string): string {
  const { surfaces } = JSON.parse(snapshot) as { surfaces: Record<string, { tools: unknown[] }> };
  return Object.entries(surfaces).map(([name, s]) => `${name} ${s.tools.length}`).join(', ');
}

/** Resolve the committed snapshot file at repo root. */
export function snapshotPath(): string {
  return path.resolve(__dirname, '..', '..', 'schema.snapshot.json');
}

/** Read the stored snapshot; null if missing.
 *  EOLs are normalized to LF so Windows autocrlf checkouts don't
 *  cause spurious diffs against `currentSnapshot()` (which writes
 *  literal '\n'). The .gitattributes rule is the primary fix; this
 *  is defense-in-depth. */
export function readStoredSnapshot(): string | null {
  const p = snapshotPath();
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

export function writeSnapshot(snapshot: string): void {
  fs.writeFileSync(snapshotPath(), snapshot);
}
