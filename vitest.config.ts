import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'tests/**/*.test.ts', 'bench/__tests__/**/*.test.ts'],
    setupFiles: ['tests/vitest.setup.ts'],
    testTimeout: 15000,
    fakeTimers: {
      // Tests that need real timers opt out with vi.useRealTimers()
    },
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
