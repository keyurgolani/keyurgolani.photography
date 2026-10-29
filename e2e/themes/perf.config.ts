import { defineConfig, devices } from '@playwright/test';

/**
 * The sequence surround's perf run (surround-perf.spec.ts): its own config, since it starts its own catalog server from
 * this checkout's build and measures time, so it runs alone and never in the main suite or in CI. Build first, and
 * point E2E_SITE_CONFIG_DIR at a site config folder (e2e/support/write-site-config.ts writes one).
 *
 *   E2E_SITE_CONFIG_DIR=<dir> npx playwright test -c e2e/themes/perf.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /surround-perf\.spec\.ts$/,
  // The photo fixtures for the e2e helpers the spec imports.
  globalSetup: '../support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/perf',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
