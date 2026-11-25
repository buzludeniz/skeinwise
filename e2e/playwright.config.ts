import { defineConfig } from '@playwright/test';

const PORT = 7493;

export default defineConfig({
  testDir: '.',
  // Not *.spec.ts, which Vitest would pick up.
  testMatch: '*.e2e.ts',
  outputDir: '../test-results/e2e',
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: 'chromium', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `node serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
