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
  },
});
