/**
 * P0 perception regression guards (2026-06-12). Three fixes that, together,
 * restored clawdcursor's cheap-perception path for external `/mcp` agents.
 * These are source-level invariants (the platform adapters and the PS bridge
 * are impractical to instantiate in vitest) — each locks in one fix so it
 * can't silently regress. All three were additionally verified live:
 * read_screen returned a real 17-element tree, a find-MISS returned in 0.6s
 * (was ~20s), and open_app('calc') foregrounded Calculator so an a11y-only
 * 7×8 computed 56 (clipboard-verified).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, '..', ...p), 'utf8');

/** Extract a method/function body by name up to the next top-level `async `/`private `/`function `. */
function methodBody(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) return '';
  const after = src.slice(start + header.length);
  const next = after.search(/\n {2}(?:async |private |public |function |get )/);
  return next === -1 ? after : after.slice(0, next);
}

describe('P0-2 — ps-bridge must not pipe arrays into ConvertTo-Json (20s-stall guard)', () => {
  const bridge = read('..', 'scripts', 'ps-bridge.ps1');

  it('serializes the dispatch result with -InputObject (empty/single arrays survive)', () => {
    // `@() | ConvertTo-Json` emits NOTHING (the array unrolls to zero objects),
    // so the bridge never answers and PSRunner stalls 20s on every miss; a
    // single-element array unwraps to a bare object and TS drops it. -InputObject
    // fixes both: @() -> "[]", @(x) -> "[x]".
    expect(bridge).toContain('ConvertTo-Json -InputObject $result');
  });

  it('does NOT contain the piped form `$result | ConvertTo-Json`', () => {
    expect(/\$result\s*\|\s*ConvertTo-Json/.test(bridge)).toBe(false);
  });
});

describe('P0-1 — getUiTree defaults to the active-window pid on every platform', () => {
  // Without a pid the bridge/script returns no tree, so read_screen came back
  // "(empty a11y tree)" for EVERY app over MCP. Each adapter must resolve the
  // foreground pid when the caller omits it.
  it('windows getUiTree resolves getActiveWindow() when pid is omitted', () => {
    const body = methodBody(read('platform', 'windows.ts'), 'async getUiTree(processId?: number)');
    expect(body).toContain('getActiveWindow');
    expect(body).toMatch(/focusedProcessId:\s*pid/);
  });

  it('macos getUiTree resolves getActiveWindow() when pid is omitted', () => {
    const body = methodBody(read('platform', 'macos.ts'), 'async getUiTree(processId?: number)');
    expect(body).toContain('getActiveWindow');
    expect(body).toContain("'-FocusedProcessId'");
  });

  it('linux getUiTree resolves getActiveWindow() when pid is omitted', () => {
    // 1.5.12: the foreground-pid lookup moved into resolveA11yPid so that
    // findElements / invokeElement get the same default (L7 — find without a
    // pid searched the wrong app). Follow the helper.
    const linux = read('platform', 'linux.ts');
    const body = methodBody(linux, 'async getUiTree(processId?: number)');
    expect(body).toContain('resolveA11yPid');
    expect(body).toContain("'--process-id'");
    const helper = methodBody(linux, 'private async resolveA11yPid(processId?: number)');
    expect(helper).toContain('getActiveWindow');
    for (const m of ['async findElements(query', 'async invokeElement(query']) {
      expect(methodBody(linux, m), m).toContain('resolveA11yPid');
    }
  });
});

describe('P0-3 — launchApp foregrounds the freshly-launched window', () => {
  const windows = read('platform', 'windows.ts');

  it('defines a foregroundLaunched helper that focuses the launched pid', () => {
    const body = methodBody(windows, 'private async foregroundLaunched(');
    expect(body).toContain('focusWindow');
    expect(body).toMatch(/result\??\.pid/);
  });

  it('the fresh-launch return sites route through foregroundLaunched', () => {
    // At least the UWP route, the Start-Process route, and the Start-Menu
    // fallback returns (≥3 call sites). The idempotency path already focuses.
    const calls = (windows.match(/foregroundLaunched\(/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
