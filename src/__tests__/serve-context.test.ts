/**
 * Both transports serve from one tool context (serve.ts startServing → tool-context.ts). Before, the stdio server built
 * its context without the log buffer, so logs_recent answered [] over stdio, and the daemon built a second UIMapHolder on
 * an `any`-typed context. The desktop classes are stubs here: nothing touches the screen.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../platform/native-desktop', () => ({
  NativeDesktop: class { getScaleFactor() { return 1; } getLlmWidth() { return 0; } async connect() {} },
}));
vi.mock('../platform/accessibility', () => ({ AccessibilityBridge: class { async warmup() {} } }));
vi.mock('../platform/cdp-driver', () => ({ CDPDriver: class { async connect() { return false; } } }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolContext } from '../surface/tool-context';
import { startServing } from '../surface/serve';
import { getLogBuffer } from '../surface/log-buffer';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import { writeConsentFile } from '../surface/onboarding';

describe('the tool context both transports build', () => {
  it('carries the log buffer, one UIMapHolder and the vision setting', async () => {
    const ctx = await createToolContext({ disableVision: true });
    expect(ctx.getLogBuffer).toBe(getLogBuffer);
    expect(ctx.uiMaps).toBeInstanceOf(UIMapHolder);
    expect(ctx.disableVision).toBe(true);
    expect((await createToolContext({ disableVision: false })).disableVision).toBe(false);
  });
});

describe('logs_recent on a served server (the stdio path builds it the same way)', () => {
  it('returns the console lines the server printed after it started', async () => {
    writeConsentFile();
    const { createHandle } = await startServing({ compact: false, banner: false, disableVision: false });
    console.log('serve-context: a line the agent can read');
    const { server } = await createHandle();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server as unknown as { connect(t: unknown): Promise<void> }).connect(a);
    const client = new Client({ name: 'serve-context-test', version: '0' });
    await client.connect(b);
    const r = await client.callTool({ name: 'logs_recent', arguments: {} });
    await client.close();
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('serve-context: a line the agent can read');
  });
});
