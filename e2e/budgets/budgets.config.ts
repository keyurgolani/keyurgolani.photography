import { defineConfig, devices } from '@playwright/test';

/**
 * #6's browser budgets (budgets.spec.ts): their own config, since they serve
 * a library of their own and the main suite skips them. `npm run test:budgets`
 * (e2e/budgets/run.ts) runs it after it has the library and the build: it
 * sets PHOTOGRAPHY_DATA_DIR and the other server settings, BUDGETS_TARGETS
 * and BUDGETS_BROWSER_OUT, and this config's server inherits them. Chromium
 * only, one worker, no retries: the numbers are the point.
 */

// BUDGETS_PORT picks another port when 3200 is taken.
const port = process.env.BUDGETS_PORT || '3200';
// Loopback only: a test server has no reason to listen on the network.
const host = '127.0.0.1';

export default defineConfig({
  testDir: '.',
  testMatch: /budgets\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 5 * 60_000,
  // The whole run's ceiling, so a hang shows in a quarter of an hour.
  globalTimeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/budgets',
  use: { baseURL: `http://${host}:${port}`, trace: 'off', colorScheme: 'dark' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The build is the one the runner made or found: this only serves it.
    command: `npm run start -- --hostname ${host} --port ${port}`,
    // 200 once the served catalog is readable.
    url: `http://${host}:${port}/api/ready`,
    timeout: 120_000,
    // Another server on the port would serve another library.
    reuseExistingServer: false,
  },
});
