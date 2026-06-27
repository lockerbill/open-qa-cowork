import { defineConfig } from '@playwright/test';

const FIXTURE_PORT = 5555;

/**
 * E2E config that loads the BUILT unpacked extension into Chromium and serves
 * the fixture SPA over http://localhost (matches the content-script scope).
 * Run `pnpm --filter @qa-copilot/extension build` first.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${FIXTURE_PORT}`,
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://localhost:${FIXTURE_PORT}/spa.html`,
    reuseExistingServer: true,
    env: { FIXTURE_PORT: String(FIXTURE_PORT) },
  },
});
