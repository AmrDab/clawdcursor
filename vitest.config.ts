import { defineConfig } from 'vitest/config';

// Two projects. `unit` is the default: no real process, desktop or clipboard. `system` holds the tests that start a real
// process (PowerShell, osascript, swiftc, python, the built CLI); it runs only when asked for (`--project system`, or
// test:ci), one file at a time. Inside it, a test that writes the clipboard or depends on this machine's apps also needs
// CLAWD_LIVE_TESTS=1 (src/__tests__/helpers/live.ts), which CI sets.
const SYSTEM = ['src/__tests__/**/*.system.test.ts', 'tests/**/*.system.test.ts', 'bench/__tests__/**/*.system.test.ts'];

export default defineConfig({
  test: {
    project: 'unit',
    globals: true,
    environment: 'node',
    setupFiles: ['tests/vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/__tests__/**/*.test.ts', 'tests/**/*.test.ts', 'bench/__tests__/**/*.test.ts'],
          exclude: SYSTEM,
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: 'system',
          include: SYSTEM,
          testTimeout: 60000,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/__tests__/**'],
      // RATCHET thresholds (#117): pinned just under the measured ALL-FILES
      // baseline (2026-06-11, include src/**: lines 35.82 / stmts 35.08 /
      // funcs 38.05 / branches 32.35) so CI fails on coverage REGRESSION.
      // Raise these as coverage grows — never lower them to make a PR pass.
      thresholds: {
        lines: 33,
        statements: 33,
        functions: 36,
        branches: 30,
      },
    },
  },
});
