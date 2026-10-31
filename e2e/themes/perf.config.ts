import { defineConfig, devices } from '@playwright/test';

/**
 * The perf run's own config, since it serves other builds beside this checkout's and times them, so it never runs in
 * the main suite or in CI. Build this checkout first. Two specs, one after the other:
 *  - surround-perf.spec.ts, the sequence surround's raster and dropped frames against the base before the themes,
 *    built at PARITY_BASE_DIR, on PERF_PORTS;
 *  - lcp.spec.ts, lab LCP and TBT on every route and theme against v1.2.0's build at PERF_V120_DIR, on PERF_LCP_PORTS.
 * Each runs on ratios against its base, served beside it, but the perf gate runs them as one exclusive kgn ticket.
 *
 *   PARITY_BASE_DIR=<built base> PERF_V120_DIR=<built v1.2.0> PERF_PORTS=3375,3376 PERF_LCP_PORTS=3377,3378 \
 *     npx playwright test -c e2e/themes/perf.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /(?:surround-perf|lcp)\.spec\.ts$/,
  // The photo fixtures for the e2e helpers the spec imports.
  globalSetup: '../support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  // The whole run's ceiling: the surround's setup and test (20 and 40 minutes at most, about 35 expected) and LCP's
  // 300 loads (about 20 to 25), so a hang shows inside the kgn slot's 90 minutes.
  globalTimeout: 75 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/perf',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
