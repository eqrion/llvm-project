import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run in Node.js. The wasm module supports Node via -sENVIRONMENT=web,worker,node.
    environment: 'node',

    // Integration tests load a 57MB wasm binary; allow enough time.
    testTimeout: 120_000,
    hookTimeout: 120_000,

    // Run test files sequentially - each integration suite creates its own
    // Worker, and parallel wasm compilation would spike memory.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },

    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
