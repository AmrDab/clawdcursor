import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15000,
    fakeTimers: {
      // Tests that need real timers opt out with vi.useRealTimers()
    },
  },
});
