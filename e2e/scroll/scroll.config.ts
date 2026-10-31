import { defineConfig, devices } from '@playwright/test';

// photo-perf-scroll: the runner copies this and scroll.spec.ts into the tools worktree's e2e/scroll/. No globalSetup:
// the spec needs no photo fixtures, and nothing here deletes anything.
export default defineConfig({
    testDir: '.',
    testMatch: /scroll\.spec\.ts$/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 30 * 60_000,
    globalTimeout: 40 * 60_000,
    reporter: [['list']],
    outputDir: process.env.SCROLL_RESULTS ?? '../../test-results/perf-scroll',
    use: { trace: 'off' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
