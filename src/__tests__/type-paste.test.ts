/**
 * The agent `type` tool: short text is typed as keystrokes (the user's clipboard is never touched); text longer than
 * TYPE_KEYS_MAX is pasted (one Ctrl/Cmd+V instead of ~20 ms a character), with the clipboard verified before and the
 * prior clipboard restored after. Falls back to typeText if the clipboard or the paste fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';
import { TYPE_KEYS_MAX } from '../tools/paste-guard';
import type { AgentToolContext } from '../tools/projected/types';

function ctxWith(platform: any): AgentToolContext {
  return {
    platform, task: 't', mode: 'blind',
    screen: { logicalWidth: 1280, logicalHeight: 720, physicalWidth: 1280, physicalHeight: 720, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  };
}
const typeTool = () => buildUnifiedTools().find(t => t.name === 'type')!;
const LONG = 'a'.repeat(TYPE_KEYS_MAX + 1);

describe('type tool — keystrokes for short text', () => {
  it('short text: keystrokes, and no clipboard read or write at all', async () => {
    const platform = {
      readClipboard: vi.fn(async () => 'PRIOR'),
      writeClipboard: vi.fn(async () => {}),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    const r = await typeTool().execute({ text: 'adele songs' }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).toHaveBeenCalledWith('adele songs');
    expect(platform.readClipboard).not.toHaveBeenCalled();
    expect(platform.writeClipboard).not.toHaveBeenCalled();
    expect(r.text).toMatch(/\(keys\)/);
  });
});

describe('type tool — clipboard paste for long text', () => {
  it('pastes via clipboard (write + mod+v), NOT per-character typeText', async () => {
    const calls: string[] = [];
    let clip = 'PRIOR';
    const platform = {
      readClipboard: vi.fn(async () => clip),
      writeClipboard: vi.fn(async (s: string) => { clip = s; calls.push(`write:${s.length}`); }),
      keyPress: vi.fn(async (c: string) => { calls.push(`key:${c}`); }),
      typeText: vi.fn(async () => { calls.push('typeText'); }),
    };
    const r = await typeTool().execute({ text: LONG }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).not.toHaveBeenCalled();
    expect(calls).toContain(`write:${LONG.length}`);
    expect(calls).toContain('key:mod+v');
    expect(r.text).toMatch(/\(paste\)/);
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
    await typeTool().execute({ text: LONG }, ctxWith(platform));
    expect(writes).toEqual([LONG, 'COPIED SENTENCE']);
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
    const r = await typeTool().execute({ text: LONG + '\n' }, ctxWith(platform));
    expect(keys).toEqual(['Return']);
    expect(platform.typeText).toHaveBeenCalledWith(LONG);
    expect(r.text).toMatch(/\(keys\)/);
  });

  it('falls back to per-character typeText when the clipboard is unavailable', async () => {
    const platform = {
      readClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      writeClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    const r = await typeTool().execute({ text: LONG }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).toHaveBeenCalledWith(LONG);
  });
});

// #377: a field that can be read and still reads empty after typing may have got none of the text — or be a hidden input
// the app empties after each key (an xterm.js terminal's helper textarea, Google Docs), where the text did arrive.
describe('type tool — a readable field that reads back empty', () => {
  const field = (value: string, readable?: boolean) => ({ name: 'Name', controlType: 'Edit', bounds: { x: 0, y: 0, width: 100, height: 20 }, value, ...(readable ? { readable } : {}) });
  const platform = (focused: any) => ({ keyPress: vi.fn(async () => {}), typeText: vi.fn(async () => {}), getFocusedElement: vi.fn(async () => focused) });

  it('is a success with a warning, unverified: Return still goes, and the agent is told to look before any retype', async () => {
    const { classifyResult } = await import('../core/result-codes');
    const p = platform(field('', true));
    const r = await typeTool().execute({ text: 'npm test\n' }, ctxWith(p));
    expect(r.success).toBe(true);
    expect(p.typeText).toHaveBeenCalledWith('npm test');
    expect(p.keyPress).toHaveBeenCalledWith('Return');
    expect(r.text).toMatch(/⚠ read back: the focused field reads empty/);
    expect(r.text).toMatch(/type again only if the text is not there/);
    expect(r.text).not.toMatch(/then type again/);
    expect(classifyResult(r.text, false, true)?.outcome).toBe('unverified');
  });

  it('an empty read from a field that cannot be read is no verdict: success, unverified', async () => {
    const r = await typeTool().execute({ text: 'hello' }, ctxWith(platform(field(''))));
    expect(r.success).toBe(true);
    expect(r.text).not.toMatch(/read back/);
  });
});
