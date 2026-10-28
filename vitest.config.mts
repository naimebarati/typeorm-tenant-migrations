import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/bin.ts'], // 2-line entry point; exercised only through the spawned binary
      reporter: ['text-summary', 'text', 'json-summary'],
      reportsDirectory: 'coverage',
      // Ratchet: set just under the measured values (98.1 / 96.2 / 95.0 / 99.1). Raise when coverage rises, never lower to make a PR pass.
      thresholds: { statements: 96, branches: 94, functions: 93, lines: 98 },
    },
    // Integration files each create their own database, so files may run in parallel.
  },
});
