/**
 * Security scan (2026-11): NativeDesktop.typeText logged `Typed: "<the first 60 characters>"`. Console lines reach the
 * MCP host's log file (stdio servers write them to stderr) and GET /logs / logs_recent, and typed text can be a password.
 * SECURITY.md promises the logs hold no typed text. Only the length is logged now. (macOS: native-desktop-mac-keyboard.test.ts.)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { ClawdConfig } from '../types';

vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real, platform: () => 'win32' }, platform: () => 'win32' };
});
const typed = vi.hoisted(() => [] as string[]);
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} },
  keyboard: { config: {}, type: vi.fn(async (t: string) => { typed.push(t); }) },
  screen: { config: {}, grab: vi.fn(), width: vi.fn(async () => 1920), height: vi.fn(async () => 1080) },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

import { NativeDesktop } from '../platform/native-desktop';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); vi.restoreAllMocks(); });

describe('typeText logs how much was typed, never what', () => {
  it.each([
    ['correct horse battery staple', 28],
    ['p@ssw0rd-🔑-日本語', 14],   // characters, not UTF-16 units (15)
    ['x'.repeat(200), 200],
  ])('%j', async (text, chars) => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const d = new NativeDesktop({} as ClawdConfig);
    (d as unknown as { connected: boolean }).connected = true;
    await d.typeText(text);
    log.mockRestore();
    expect(typed[typed.length - 1]).toBe(text);   // it was typed
    expect(lines.join('\n')).toContain(`Typed ${chars} chars`);
    for (const piece of [text, text.slice(0, 6), text.slice(-6)]) expect(lines.join('\n')).not.toContain(piece);
  });
});
