import type { Locator, Page } from '@playwright/test';
import type { TestCatalog } from '../lib/catalog/testing';
import { HOME_FRAMING, HOME_ORDER } from './support/catalog-home';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { publishHomeFramingFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #4's framing in the browser (v2.0.0 B7): a cover slide is cut on its photograph's focal point, and a contain one
// sits whole on the theme's mat, its LQIP inside the print. Its own `next start` on the Home fixture with
// HOME_FRAMING's crop and focal point, so the config's catalog server, and Dark parity with it, keep centred covers.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    ({ catalog } = await publishHomeFramingFixture());
    // Above the ports home-empty.spec.ts, image-sizes.spec.ts and first-viewport.spec.ts take when E2E_CATALOG_PORT pins them.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 30 + test.info().parallelIndex : undefined);
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await server?.stop();
    await catalog?.cleanup();
});

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};

/** Each theme's mat, the carousel's ground: Light's and Bright's --gah-mat-fill, and Dark's and Black's black. */
const MATS = { dark: 'rgb(0, 0, 0)', light: 'rgb(248, 245, 238)', bright: 'rgb(255, 255, 255)', black: 'rgb(0, 0, 0)' } as const;

const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const style = (target: Locator, ...props: string[]) =>
    target.evaluate((el, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(el).getPropertyValue(name)])), props);

/** Waits until `photoId` is the slide on screen, its image loaded. */
async function expectShown(page: Page, photoId: string) {
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', photoId);
    await expect.poll(() => shownSlide(page).locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
}

async function openHome(page: Page, theme: keyof typeof MATS) {
    await page.addInitScript((stored) => localStorage.setItem('theme', stored), theme);
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expectShown(page, HOME_FRAMING.contain);
}

/** Presses Next from the keyboard, which reveals the chrome and holds it. */
async function pressNext(page: Page) {
    for (let press = 0; press < 15 && !(await next(page).evaluate((el) => el === document.activeElement)); press++) await page.keyboard.press('Tab');
    await expect(next(page)).toBeFocused();
    await page.keyboard.press('Enter');
}

for (const theme of Object.keys(MATS) as (keyof typeof MATS)[]) {
    test(`in ${theme}, a contain photograph sits whole on the mat, and a cover one is cut on its focal point`, async ({ page }) => {
        await openHome(page, theme);
        await expect(page.locator('[data-home-carousel]')).toHaveCSS('background-color', MATS[theme]);
        const opening = shownSlide(page);
        await expect(opening).toHaveAttribute('data-crop', 'contain');
        expect(await style(opening.locator('img'), 'object-fit', 'object-position', 'background-size', 'background-repeat', 'background-position')).toEqual({
            'object-fit': 'contain',
            'object-position': '50% 50%',
            // The LQIP under the opening photograph fills the print's box, not the mat around it.
            'background-size': 'contain',
            'background-repeat': 'no-repeat',
            'background-position': '50% 50%',
        });

        await pressNext(page);
        await expectShown(page, HOME_FRAMING.focal.photoId);
        await expect(shownSlide(page)).toHaveAttribute('data-crop', 'cover');
        const { x, y } = HOME_FRAMING.focal.focalPoint;
        expect(await style(shownSlide(page).locator('img'), 'object-fit', 'object-position')).toEqual({ 'object-fit': 'cover', 'object-position': `${x * 100}% ${y * 100}%` });

        // One with no focal point of its own is cut on the centre, as before.
        await pressNext(page);
        const plain = HOME_ORDER[(HOME_ORDER.indexOf(HOME_FRAMING.focal.photoId) + 1) % HOME_ORDER.length];
        await expectShown(page, plain);
        expect(await style(shownSlide(page).locator('img'), 'object-fit', 'object-position')).toEqual({ 'object-fit': 'cover', 'object-position': '50% 50%' });
    });
}
