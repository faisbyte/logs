import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadDotEnv } from './packages/cli/src/dotenv.js';

// Lets the opt-in live tests (DIGEST_LIVE_TESTS / DIGEST_EVAL) find ANTHROPIC_API_KEY in .env.
loadDotEnv(fileURLToPath(new URL('./.env', import.meta.url)), process.env);

export default defineConfig({
  resolve: {
    // Tests run against core's TypeScript source, so no build step is needed before `pnpm test`.
    alias: {
      '@digest/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // PGlite boots Postgres in WebAssembly. On a 4-core CI runner, with every file running in parallel, a test
    // that opens it can pass the 5 s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
