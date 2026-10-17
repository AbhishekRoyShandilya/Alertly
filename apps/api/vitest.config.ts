import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests create and migrate a real MySQL database per file; under parallel
    // load that can take a few seconds, more than Vitest's 5 s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
