import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    // Tests share one Postgres database and one Firestore emulator, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
  },
});
