import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E_PORT picks another port when 3100 is taken.
const port = process.env.E2E_PORT || '3100';
// Loopback only: a test server has no reason to listen on the network.
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;

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

/**
 * The site config folder both servers read About's portrait from, which
 * the first server's command fills with the generated stand-in
 * (e2e/support/write-site-config.ts) before it builds. Made once, like the
 * empty library, and removed when that process exits.
 */
function siteConfig(): string {
  const existing = process.env.E2E_SITE_CONFIG_DIR;
  if (existing) return existing;
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-site-config-'));
  process.env.E2E_SITE_CONFIG_DIR = created;
  process.once('exit', () => fs.rmSync(created, { recursive: true, force: true }));
  return created;
}

// The catalog-mode server, for the catalog Home specs. E2E_CATALOG_PORT picks another port.
const catalogPort = process.env.E2E_CATALOG_PORT || '3101';
const catalogOrigin = `http://${host}:${catalogPort}`;

/**
 * An empty data root for the catalog-mode server, which its command fills
 * with the published Home fixture before it starts. Made once, like the
 * empty library, and removed when that process exits.
 */
function catalogDataRoot(): string {
  const existing = process.env.E2E_CATALOG_DATA_DIR;
  if (existing) return existing;
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-catalog-'));
  const root = path.join(created, 'data');
  process.env.E2E_CATALOG_DATA_DIR = root;
  process.once('exit', () => fs.rmSync(created, { recursive: true, force: true }));
  return root;
}

export default defineConfig({
  testDir: 'e2e',
  // e2e/themes holds Black's parity spec, which builds and serves two trees of its own (its own config).
  testIgnore: '**/themes/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    // A dark device, so System paints Black, today's site, which the suite's looks were written against. A case about
    // the light themes opts in with its own colorScheme or a stored choice.
    colorScheme: 'dark',
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
      testIgnore: ['**/support/**', '**/themes/**'],
    },
    {
      // WebKit targets the click after a tap differently from Chromium, so Home's first-tap rule runs on both,
      // and it can leave focus on the body after a tap, so the Viewer's swipes and keys under its modal (#9) do too.
      // The curator's Secure cookie over http on loopback runs on both too, since browsers differ there.
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] },
      // #16's Publish screen frame checks that loading the preview never scrolls the page, which browsers differ on too.
      testMatch: /(?:home-immersive|viewer-touch|curator-login|curation-publish-frame)\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // next start warns that output: 'standalone' expects server.js, but it serves.
      command: `npx tsx e2e/support/write-site-config.ts "${siteConfig()}" && npm run build && npm run start -- --hostname ${host} --port ${port}`,
      url: origin,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      // The command builds and serves under this env. ALLOW_PROVISIONAL_COPY lets
      // both run on About's placeholder copy, which fails any other production
      // build (utils/artistProfile.ts). It belongs here, in the catalog server
      // below, and in metadata.spec.ts's own server only, never in the
      // Dockerfile, Compose files, or workflows.
      env: { PHOTOGRAPHY_LIBRARY_DIR: emptyLibrary(), PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig(), ALLOW_PROVISIONAL_COPY: '1' },
    },
    {
      // Playwright starts these in order, so this one serves the build the first one made, after the cutover.
      command: `npx tsx e2e/support/publish-home-fixture.ts "${catalogDataRoot()}" && npm run start -- --hostname ${host} --port ${catalogPort}`,
      url: `${catalogOrigin}/api/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { PHOTOGRAPHY_LIBRARY_DIR: emptyLibrary(), PHOTOGRAPHY_DATA_DIR: catalogDataRoot(), PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig(), ALLOW_PROVISIONAL_COPY: '1' },
    },
  ],
});
