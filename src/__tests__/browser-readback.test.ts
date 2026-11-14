/**
 * #399: browser type and select_option read the element back over CDP, so the reply says what the page shows:
 * [confirmed] when it holds what was asked, [failed · READBACK_MISMATCH] when a page script rewrote or cleared it, and
 * [unverified] only when it cannot be read.
 */
import { describe, it, expect, vi } from 'vitest';
import { getCdpTools } from '../tools/cdp';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { projectToToolDefinition } from '../core/agent-loop/project-mcp';
import { classifyResult } from '../core/result-codes';

const tool = (n: string) => getCdpTools().find(t => t.name === n)!;
/** cdp_type, as agents get it: the agent-loop browser_type projected onto the MCP surface. */
const cdpType = projectToToolDefinition(buildUnifiedTools().find(t => t.name === 'browser_type')!);
const ctxWith = (cdp: object) => ({
  cdp: { isConnected: vi.fn(async () => true), ...cdp },
  platform: {}, desktop: {}, ensureInitialized: async () => {}, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
}) as any;
const outcome = (r: { text: string; isError?: boolean }) => classifyResult(r.text, !!r.isError, true);

describe('browser type reads the field back', () => {
  const typed = (shown: object | null) => {
    const r = vi.fn(async () => ({ success: true, read: async () => shown }));
    return ctxWith({ typeByLabel: r, typeInField: r });
  };

  it('the field holds the text: confirmed', async () => {
    const r = await cdpType.handler({ label: 'Name', text: 'hello' }, typed({ value: 'hello', readable: true }));
    expect(r.isError).toBe(false);
    expect(outcome(r)).toEqual({ outcome: 'confirmed' });
  });

  it('a page script rewrote it, or cleared it: failed, READBACK_MISMATCH, and it says what the field shows', async () => {
    const rewrote = await cdpType.handler({ label: 'Name', text: 'hello' }, typed({ value: 'goodbye', readable: true }));
    expect(rewrote.isError).toBe(true);
    expect(rewrote.text).toContain('the field shows "goodbye"');
    expect(outcome(rewrote)?.code).toBe('READBACK_MISMATCH');
    const cleared = await cdpType.handler({ label: 'Name', text: 'hello' }, typed({ value: '', readable: true }));
    expect(outcome(cleared)?.code).toBe('READBACK_MISMATCH');
  });

  it('a password input or an unreadable element: unverified, and the text is never echoed', async () => {
    const r = await cdpType.handler({ label: 'Password', text: 'hunter2' }, typed({ secure: true }));
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('hunter2');
    expect(outcome(r)).toEqual({ outcome: 'unverified' });
    expect(outcome(await cdpType.handler({ selector: '#x', text: 'a' }, typed(null)))).toEqual({ outcome: 'unverified' });
  });
});

describe('browser select_option reads the chosen option back', () => {
  const picked = (shown: object | null) => ctxWith({ selectOption: vi.fn(async () => ({ success: true, read: async () => shown })) });

  it('the option shows by its label or its value: confirmed', async () => {
    const byLabel = await tool('cdp_select_option').handler({ selector: '#plan', value: 'Pro' }, picked({ value: 'Pro', option: 'pro' }));
    expect(outcome(byLabel)).toEqual({ outcome: 'confirmed' });
    const byValue = await tool('cdp_select_option').handler({ selector: '#plan', value: 'pro' }, picked({ value: 'Pro plan', option: 'pro' }));
    expect(outcome(byValue)).toEqual({ outcome: 'confirmed' });
  });

  it('another option is chosen: failed, READBACK_MISMATCH', async () => {
    const r = await tool('cdp_select_option').handler({ selector: '#plan', value: 'Pro' }, picked({ value: 'Free', option: 'free' }));
    expect(r.isError).toBe(true);
    expect(outcome(r)?.code).toBe('READBACK_MISMATCH');
  });

  it('cannot be read: unverified', async () => {
    const r = await tool('cdp_select_option').handler({ selector: '#plan', value: 'Pro' }, picked(null));
    expect(outcome(r)).toEqual({ outcome: 'unverified' });
  });
});
