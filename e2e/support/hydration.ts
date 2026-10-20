import type { Page } from '@playwright/test';

/**
 * ThemeProvider renders nothing until it mounts, so a Tab press or axe run
 * before then sees an empty page. It sets html[data-hydrated] once its
 * children have committed. Helpers wait on that, never on timeouts.
 */
export async function waitForHydration(page: Page): Promise<void> {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}
