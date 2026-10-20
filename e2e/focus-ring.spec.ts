import { expectFocusRingVisible } from './support/focus';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// The focus token on ThemeToggle and each BottomBar link, in both themes.
for (const theme of ['dark', 'light'] as const) {
    test.describe(`${theme} theme`, () => {
        test.beforeEach(async ({ page }) => {
            if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            await page.goto('/gallery');
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        });

        test('ThemeToggle shows the focus ring', async ({ page }) => {
            const name = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
            await expectFocusRingVisible(page.getByRole('button', { name }));
        });

        for (const name of ['Gallery', 'Home', 'About']) {
            test(`the ${name} link shows the focus ring`, async ({ page }) => {
                await expectFocusRingVisible(page.getByRole('link', { name, exact: true }));
            });
        }
    });
}
