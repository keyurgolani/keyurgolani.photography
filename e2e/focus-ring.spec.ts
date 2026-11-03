import type { Page } from '@playwright/test';
import { expectFocusRingVisible } from './support/focus';
import { expect, test } from './support/test';

// The focus token on the theme control, each SiteNav link, and the About source
// link, in both themes and under hover, since Tailwind's dark: and hover:
// shadow variants land after the token. They run on About, which the harness
// server serves without a catalog. The legacy lightbox's checks went with it
// (#13's slice E).

const toggle = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const source = (page: Page) => page.getByRole('navigation', { name: 'External profiles' }).getByRole('link', { name: 'Site source', exact: true });

for (const theme of ['dark', 'light'] as const) {
    test.describe(`${theme} theme`, () => {
        async function open(page: Page, path: string) {
            if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            await page.goto(path);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        }

        test('the theme control shows the focus ring', async ({ page }) => {
            await open(page, '/about');
            await expectFocusRingVisible(toggle(page));
        });

        for (const name of ['KG, Keyur Golani', 'Home', 'Work', 'About']) {
            test(`the ${name} link shows the focus ring`, async ({ page }) => {
                await open(page, '/about');
                await expectFocusRingVisible(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true }));
            });
        }

        test('the About source link shows the focus ring', async ({ page }) => {
            await open(page, '/about');
            await expectFocusRingVisible(source(page));
        });

        for (const [label, path, target] of [
            ['the theme control', '/about', toggle],
            ['the About source link', '/about', source],
        ] as const) {
            test(`${label} keeps the band under hover`, async ({ page }, testInfo) => {
                test.skip(testInfo.project.name === 'mobile', 'Hover styles only apply to fine pointers.');
                await open(page, path);
                await target(page).hover();
                await expectFocusRingVisible(target(page));
            });
        }
    });
}
