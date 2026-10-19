/**
 * The agent `type` tool must paste via the clipboard (fast) instead of
 * per-character typing (slow, "letter by letter") — restoring the legacy
 * smart_type speed. It also restores the prior clipboard so a pending copy
 * isn't clobbered. Falls back to typeText if clipboard/paste fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

function ctxWith(platform: any): AgentToolContext {
  return {
    platform, task: 't', mode: 'blind',
    screen: { logicalWidth: 1280, logicalHeight: 720, physicalWidth: 1280, physicalHeight: 720, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  };
}
const typeTool = () => buildUnifiedTools().find(t => t.name === 'type')!;

describe('type tool — clipboard paste fast path', () => {
  it('pastes via clipboard (write + mod+v), NOT per-character typeText', async () => {
    const calls: string[] = [];
    let clip = 'PRIOR';
    const platform = {
      readClipboard: vi.fn(async () => clip),
      writeClipboard: vi.fn(async (s: string) => { clip = s; calls.push(`write:${s}`); }),
      keyPress: vi.fn(async (c: string) => { calls.push(`key:${c}`); }),
      typeText: vi.fn(async () => { calls.push('typeText'); }),
    };
    const r = await typeTool().execute({ text: 'adele songs' }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).not.toHaveBeenCalled();          // NOT char-by-char
    expect(calls).toContain('write:adele songs');               // wrote the text
    expect(calls).toContain('key:mod+v');                       // pasted
    expect(r.text).toMatch(/paste/);
  });

  it('restores the prior clipboard after pasting (no clobber of a pending copy)', async () => {
    const writes: string[] = [];
    let clip = 'COPIED SENTENCE';
    const platform = {
      readClipboard: vi.fn(async () => clip),
      writeClipboard: vi.fn(async (s: string) => { clip = s; writes.push(s); }),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    await typeTool().execute({ text: 'a filename' }, ctxWith(platform));
    // write the text to paste, then restore the prior clipboard
    expect(writes).toEqual(['a filename', 'COPIED SENTENCE']);
    expect(platform.typeText).not.toHaveBeenCalled();
  });

  it('never pastes when the clipboard did not take the text (it would paste the USER\'s clipboard) — types it instead', async () => {
    const keys: string[] = [];
    const platform = {
      readClipboard: vi.fn(async () => 'password123 the user copied'),
      writeClipboard: vi.fn(async () => { /* Set-Clipboard timed out: nothing written, no error */ }),
      keyPress: vi.fn(async (c: string) => { keys.push(c); }),
      typeText: vi.fn(async () => {}),
    };
    const r = await typeTool().execute({ text: 'https://glama.ai/x\n' }, ctxWith(platform));
    expect(keys).not.toContain('mod+v');
    expect(platform.typeText).toHaveBeenCalledWith('https://glama.ai/x\n');
    expect(r.text).not.toMatch(/paste/);
  });

  it('falls back to per-character typeText when clipboard is unavailable', async () => {
    const platform = {
      readClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      writeClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    const r = await typeTool().execute({ text: 'hello' }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).toHaveBeenCalledWith('hello');
  });
});
