import { defineConfig, devices } from '@playwright/test';

/**
 * Black against the pre-themes site, pixel for pixel (black-parity.spec.ts). Its own config, since it starts its own
 * servers from two builds, the head's (this checkout) and the base's (PARITY_BASE_DIR), and needs none of the harness's.
 * CI's "Themes" job runs it with PARITY_BUILD=1, so its global setup (build.ts) builds both first; playwright.config.ts
 * leaves e2e/themes out of the main suite.
 *
 *   PARITY_BASE_DIR=<a checkout of the base, built> npx playwright test -c e2e/themes/parity.config.ts
 *
 * PARITY_PORTS (four comma-separated ports) pins the servers' ports, for a machine that hands out a range; it starts
 * them in two rounds of four. Free ports otherwise.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /black-parity\.spec\.ts$/,
  globalSetup: './build.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Per page: four sizes and scales, each up to ten fresh loads.
  timeout: 20 * 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/parity' }]],
  outputDir: '../../test-results/parity',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
