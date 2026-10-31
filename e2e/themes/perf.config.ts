import { defineConfig, devices } from '@playwright/test';

/**
 * The sequence surround's perf run (surround-perf.spec.ts): its own config, since it serves the base's build and this
 * checkout's side by side and times them, so it never runs in the main suite or in CI. Build both first. It gates on
 * the head's time against the base's beside it, so it can run non-exclusive. PERF_PORTS pins the two servers' ports.
 *
 *   PARITY_BASE_DIR=<built base> PERF_PORTS=3375,3376 npx playwright test -c e2e/themes/perf.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /surround-perf\.spec\.ts$/,
  // The photo fixtures for the e2e helpers the spec imports.
  globalSetup: '../support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  // The whole run's ceiling, setup's 20 minutes and the test's 40 together, so a hang shows in an hour.
  globalTimeout: 60 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/perf',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
