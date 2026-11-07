import type { Page } from '@playwright/test';

/**
 * The server HTML has the whole page, but nothing on it responds until React
 * hydrates. ThemeProvider sets html[data-hydrated] once its children have
 * committed. Helpers wait on that, never on timeouts.
 *
 * The Inbox streams in after the shell, so its forms can hydrate after the
 * marker. Each says so itself (data-submit-gate, submitGateScript.ts), and
 * the head's script drops a press until it does, so this waits for every form
 * on the page to be ready too.
 *
 * This only covers the first document load. A client-side navigation keeps
 * the marker from the page before, so after one, wait for the new page's own
 * content instead.
 */
export async function waitForHydration(page: Page): Promise<void> {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => [...document.querySelectorAll('form[data-submit-gate]')].every((form) => form.getAttribute('data-submit-gate') === 'ready'));
}
