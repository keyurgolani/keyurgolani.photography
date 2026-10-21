import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E_PORT picks another port when 3100 is taken.
const port = process.env.E2E_PORT || '3100';
const origin = `http://127.0.0.1:${port}`;

/**
 * The server builds and serves against an empty photo library, so the
 * harness never reads or writes the real one. Workers reload this file and
 * inherit the env var, so only the first load creates the directory, and
 * that process removes it on exit, even when globalSetup never ran: --list,
 * IDE discovery, or a failed build.
 */
function emptyLibrary(): string {
  const existing = process.env.E2E_EMPTY_LIBRARY;
  if (existing) return existing;
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-library-'));
  process.env.E2E_EMPTY_LIBRARY = created;
  process.once('exit', () => fs.rmSync(created, { recursive: true, force: true }));
  return created;
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: origin,
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
    command: `npm run build && npm run start -- --port ${port}`,
    url: origin,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { PHOTOGRAPHY_LIBRARY_DIR: emptyLibrary() },
  },
});
