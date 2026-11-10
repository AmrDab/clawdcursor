/**
 * open_app takes an application NAME (security review of #344). On Windows the name reaches Start-Process -FilePath, on
 * macOS `open -a`, on Linux an exec: a path there runs that file. Running a file is what open_file is for, and open_file
 * is the tool announced as destructive — so a path is refused here, on every OS, and the agent is pointed to open_file.
 */
import { describe, it, expect, vi } from 'vitest';
import { appNameRefusal } from '../core/router/aliases';
import { getOrchestrationTools } from '../tools/orchestration';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { ToolContext } from '../tools/types';

const PATHS = [
  'C:\\Windows\\System32\\calc.exe', 'c:/tools/x.exe', 'C:evil.exe', '\\\\server\\share\\payload.exe', '.\\payload.exe', './payload', '../payload',
  '/usr/bin/gnome-calculator', '/Applications/Calculator.app', '~/Downloads/installer', 'Downloads/setup.exe', 'sub\\tool.exe',
  'file:///C:/x.exe', 'https://example.com/app', '%TEMP%\\x.exe', '$HOME/x',
];
const NAMES = ['Designcenter', 'Calculator', 'Microsoft Edge', 'notepad', 'Notepad++', 'Visual Studio Code', 'calc.exe', 'Designcenter NX 2506', '7-Zip', 'Adobe Acrobat (64-bit)', 'TextEdit', 'gnome-calculator', 'AT&T Connect', "Sam's Notes", 'Zed', 'olk'];

describe('appNameRefusal', () => {
  it.each(PATHS)('refuses the path %s and points to open_file', (p) => {
    expect(appNameRefusal(p)).toMatch(/takes an application name, not a path.*open_file/);
  });

  it.each(NAMES)('accepts the name %s', (n) => {
    expect(appNameRefusal(n)).toBeNull();
  });

  it('an empty name is not a path refusal', () => {
    expect(appNameRefusal('')).toBeNull();
  });
});

describe('open_app refuses a path before anything is launched, on every OS', () => {
  const launchApp = vi.fn(async () => ({ pid: 1, title: 'x' }));
  const ctx = { ensureInitialized: async () => {}, platform: { platform: process.platform, launchApp }, a11y: { invalidateCache: () => {} } } as unknown as ToolContext;
  const mcp = getOrchestrationTools().find(t => t.name === 'open_app')!;
  const agent = buildUnifiedTools().find(t => t.name === 'open_app')!;

  it.each(PATHS)('MCP open_app: %s', async (p) => {
    launchApp.mockClear();
    const r = await mcp.handler({ name: p }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/open_file/);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it.each(PATHS)('agent-loop open_app: %s', async (p) => {
    launchApp.mockClear();
    const r = await agent.execute({ name: p }, { platform: { platform: process.platform, launchApp } } as never);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/open_file/);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it.each(['Designcenter', 'Calculator', 'Microsoft Edge'])('a normal name still launches: %s', async (n) => {
    launchApp.mockClear();
    const r = await mcp.handler({ name: n }, ctx);
    expect(r.isError).toBeFalsy();
    expect(launchApp).toHaveBeenCalledTimes(1);
  });
});
