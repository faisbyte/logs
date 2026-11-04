import { defineConfig, devices } from '@playwright/test';

// End-to-end: a real digest server on a seeded throwaway database, and the built dashboard pointed at it. Nothing is
// deployed; both run on localhost ports used only here.
const API_PORT = 8799;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node e2e/seed.mjs && PORT=${API_PORT} node ../../packages/server/dist/main.js serve --data e2e/.data/db`,
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/sign-in`,
      env: { DIGEST_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
