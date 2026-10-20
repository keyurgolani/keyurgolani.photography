import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The server builds and serves against an empty photo library, so the harness
// never reads or writes the real one. Workers reload this file, and the env
// var hands them the directory the first load created.
const emptyLibrary = (process.env.E2E_EMPTY_LIBRARY ??= fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-library-')));

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      // The helper self-tests build their own pages, so they run on desktop only.
      testIgnore: '**/support/**',
    },
  ],
  webServer: {
    // next start warns that output: 'standalone' expects server.js, but it serves.
    command: 'npm run build && npm run start -- --port 3100',
    url: 'http://127.0.0.1:3100',
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { PHOTOGRAPHY_LIBRARY_DIR: emptyLibrary },
  },
});
