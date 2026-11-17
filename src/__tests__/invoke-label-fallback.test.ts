/**
 * Live 2026-11-17 (Siemens Designcenter): ribbon buttons are not in the UIA tree, `invoke "Circle"` missed, and the agent
 * clicked x,y off a screenshot instead of following the hint. An invoke BY NAME that found no element of that name now
 * presses the visible label itself, with the real smart_click handler (project-mcp.ts pressVisibleLabel).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const smartClick = vi.fn();
vi.mock('../tools/smart', async (orig) => {
  const actual = await orig<typeof import('../tools/smart')>();
  return { ...actual, getSmartTools: () => actual.getSmartTools().map(t => t.name === 'smart_click' ? { ...t, handler: smartClick } : t) };
});

import { getTool, getCompactSurface } from '../tools/registry';
import { classifyResult, renderResultLine } from '../core/result-codes';
import { makeMockPlatform } from './helpers/mock-platform';
import type { ToolContext } from '../tools/types';

const NOT_FOUND = { success: false, data: { reason: 'not_found' } };
const AMBIGUOUS = { success: false, data: { reason: 'ambiguous', candidates: [{ name: 'Circle', controlType: 'Button' }, { name: 'Circle', controlType: 'Button' }] } };

function makeCtx(invoke: unknown): ToolContext {
  const platform = makeMockPlatform();
  (platform as any).invokeElement = vi.fn(async () => invoke);
  return {
    desktop: { getScreenSize: () => ({ width: 1920, height: 1080 }) },
    a11y: {}, cdp: null, platform,
    getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  } as unknown as ToolContext;
}

const invoke = (args: Record<string, unknown>, invokeResult: unknown = NOT_FOUND) => getTool('invoke_element')!.handler(args, makeCtx(invokeResult));
const SMART_OK = { text: '[via OCR] clicked "Circle" at 10,20' };
const SMART_MISS = { text: JSON.stringify({ error: 'no_clickable_target', reason: 'no match', target: 'Circle' }), isError: true };

beforeEach(() => { smartClick.mockReset(); smartClick.mockResolvedValue(SMART_OK); });

describe('invoke by a name the tree does not have presses the visible label', () => {
  it('falls back to smart_click with the same target and processId', async () => {
    const r = await invoke({ name: 'Circle', processId: 4242 });
    expect(smartClick).toHaveBeenCalledTimes(1);
    expect(smartClick.mock.calls[0][0]).toEqual({ target: 'Circle', processId: 4242 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe(`No element named "Circle" in the accessibility tree; pressed its visible label instead (OCR, no screenshot): ${SMART_OK.text}`);
  });

  it('omits processId when none was given', async () => {
    await invoke({ name: 'Circle' });
    expect(smartClick.mock.calls[0][0]).toEqual({ target: 'Circle' });
  });

  it('the success reads as a smart_click success, not NOT_FOUND', async () => {
    const r = await invoke({ name: 'Circle' });
    expect(classifyResult(r.text, !!r.isError, true)).toEqual({ outcome: 'unverified' });
  });

  it('no fallback with within', async () => {
    const r = await invoke({ name: 'Circle', within: 'Ribbon' });
    expect(smartClick).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/missed — Element not found/);
  });

  it('no fallback on an ambiguous miss', async () => {
    const r = await invoke({ name: 'Circle' }, AMBIGUOUS);
    expect(smartClick).not.toHaveBeenCalled();
    expect(r.text).toMatch(/elements on screen match that name/);
  });

  // Live 2026-11-17: `invoke "New"` in Designcenter matched two help-page lines that only CONTAIN "New"; the pixel next
  // sent the agent to screenshots for the whole run. Nothing is named "New" there: press the visible label.
  it('an ambiguous miss whose candidates only contain the name falls back like not found', async () => {
    const partial = { success: false, data: { reason: 'ambiguous', candidates: [
      { name: 'New to NX? Start with these videos', controlType: 'Text', container: { name: 'Discovery Center', controlType: 'Document' } },
      { name: 'New to NX and ready to learn?', controlType: 'Text', container: { name: 'Discovery Center', controlType: 'Document' } },
    ] } };
    const r = await invoke({ name: 'New' }, partial);
    expect(smartClick).toHaveBeenCalledTimes(1);
    expect(smartClick.mock.calls[0][0]).toEqual({ target: 'New' });
    expect(r.text).toMatch(/^No element named "New" in the accessibility tree; pressed its visible label instead/);
  });

  it('an ambiguous partial miss whose label is not on screen either keeps the ambiguous text', async () => {
    smartClick.mockResolvedValue(SMART_MISS);
    const partial = { success: false, data: { reason: 'ambiguous', inexact: true, candidates: [{ name: 'What\'s New', controlType: 'Button' }, { name: 'New tab', controlType: 'Button' }] } };
    const r = await invoke({ name: 'New' }, partial);
    expect(smartClick).toHaveBeenCalledTimes(1);
    expect(r.text).not.toMatch(/not found on screen either/);
    expect(r.text).toMatch(/no element is named exactly that|elements on screen match that name/);
  });

  it('an ambiguous miss is never answered with a pixel click: its next names the element', () => {
    const line = renderResultLine(classifyResult('a11y invoke "Close" missed — 2 elements on screen match that name, nothing was done', true, true, 'mcp')!);
    expect(line).toContain('accessibility {"action":"invoke"');
    expect(line).not.toContain('"x":');
  });

  it('no fallback for a verb other than click', async () => {
    const r = await invoke({ name: 'Circle', action: 'expand' });
    expect(smartClick).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
  });

  it('no fallback on the element_id path', async () => {
    const r = await invoke({ element_id: 'el_1', snapshot_id: 'nope' });
    expect(smartClick).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
  });

  it('no fallback for an automationId-only call', async () => {
    const r = await invoke({ automationId: 'btnCircle' });
    expect(smartClick).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
  });

  it('when the label is not on screen either: says so, and the next step is not smart_click again', async () => {
    smartClick.mockResolvedValue(SMART_MISS);
    const r = await invoke({ name: 'Circle' });
    expect(r.isError).toBe(true);
    expect(r.text.endsWith(' Its visible label was not found on screen either.')).toBe(true);
    expect(r.text).not.toMatch(/no_clickable_target/);
    const line = renderResultLine(classifyResult(r.text, true, true)!);
    expect(line).toMatch(/NOT_FOUND/);
    expect(line).toMatch(/no visible label matches it/);
    expect(line).not.toMatch(/smart_click/);
  });

  it('a smart_click failure that is not a plain no-match (locked screen) leaves today\'s miss text', async () => {
    smartClick.mockResolvedValue({ text: JSON.stringify({ error: 'screen_locked', reason: 'locked' }), isError: true });
    const r = await invoke({ name: 'Circle' });
    expect(r.text).not.toMatch(/Its visible label/);
  });

  it('a plain miss still suggests smart_click (the fallback does not run for it)', () => {
    const line = renderResultLine(classifyResult('a11y invoke "Circle" missed — Element not found.', true, true)!);
    expect(line).toMatch(/smart_click/);
  });

  it('the compact accessibility invoke gets the same behavior', async () => {
    const acc = getCompactSurface().find(t => t.name === 'accessibility')!;
    const r = await acc.handler({ action: 'invoke', name: 'Circle' }, makeCtx(NOT_FOUND));
    expect(smartClick).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/^No element named "Circle" in the accessibility tree; pressed its visible label instead/);
  });
});
