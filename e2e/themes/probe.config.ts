import { defineConfig, devices } from '@playwright/test';

/**
 * A one-off probe, never merged: Work's focused entry in Dark at 1440 by 900, in the base and the head, for the Dark
 * parity decision on the entry's reveal (work-focus-probe.spec.ts). The Themes job's builds, through the parity run's
 * own global setup (build.ts, PARITY_BUILD=1).
 *
 *   PARITY_BUILD=1 PARITY_BASE_DIR=<a checkout of the base> npx playwright test -c e2e/themes/probe.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /work-focus-probe\.spec\.ts$/,
  globalSetup: './build.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/probe-output',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
