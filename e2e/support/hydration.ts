import type { Page } from '@playwright/test';

/**
 * ThemeProvider renders nothing until it mounts, so a Tab press or axe run
 * before then sees an empty page. It sets html[data-hydrated] once its
 * children have committed. Helpers wait on that, never on timeouts.
 *
 * This only covers the first document load. A client-side navigation keeps
 * the marker from the page before, so after one, wait for the new page's own
 * content instead.
 */
export async function waitForHydration(page: Page): Promise<void> {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}
