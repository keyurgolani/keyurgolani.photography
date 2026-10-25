import type { Locator, Page, TestInfo } from '@playwright/test';
import { altOf, CATALOG_ORIGIN, HOME_OPENING, HOME_ORDER, HOME_SERIES } from './support/catalog-home';
import { expectHomeImmersive, photoPoint } from './support/home';
import { waitForHydration } from './support/hydration';
import { checkSurface, expectUniqueNames } from './support/surface';
import { expect, test } from './support/test';

// #4: Home after the cutover, on playwright.config.ts's catalog-mode server,
// which serves the published fixture in e2e/support/catalog-home.ts. Keyboard
// cases run on desktop and mobile, the mouse case on desktop, and the touch
// cases on mobile, each respecting #18's first-tap reveal.

test.use({ baseURL: CATALOG_ORIGIN });

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const pause = (page: Page) => page.getByRole('button', { name: 'Pause slideshow', exact: true });
const play = (page: Page) => page.getByRole('button', { name: 'Play slideshow', exact: true });
const enter = (page: Page) => page.getByRole('link', { name: 'Enter the series', exact: true });
const position = (page: Page) => page.getByRole('group', { name: 'Slideshow' }).getByText(/^\d{2,} \/ \d{2,}$/);
/** The slide on screen: the one not hidden from assistive technology. */
const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
const shownImage = (page: Page) => shownSlide(page).locator('img');
const storyControls = (page: Page) => previous(page).or(next(page)).or(pause(page)).or(enter(page));

const runsOn = (testInfo: TestInfo, ...projects: string[]) =>
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);

/** The authored position of a photograph, as Home shows it. */
const at = (photoId: string) => `${String(HOME_ORDER.indexOf(photoId as (typeof HOME_ORDER)[number]) + 1).padStart(2, '0')} / ${String(HOME_ORDER.length).padStart(2, '0')}`;

/** Expects `photoId` on screen, loaded, at its authored position. */
async function expectShown(page: Page, photoId: string) {
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', photoId);
    await expect(shownImage(page)).toHaveAttribute('alt', altOf(photoId));
    await expect.poll(() => shownImage(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
}

/** Opens Home, counting /api/photos requests, and waits until it rests on the opening photograph alone. */
async function openHome(page: Page) {
    const legacyRequests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/photos')) legacyRequests.push(request.url());
    });
    await page.goto('/');
    await waitForHydration(page);
    await expectHomeImmersive(page);
    return legacyRequests;
}

async function tabTo(page: Page, target: Locator, limit = 15) {
    for (let press = 0; press < limit; press++) {
        if (await target.evaluate((el) => el === document.activeElement)) return;
        await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
}

test('opens on the authored opening photograph, the same one on every reload, and never asks /api/photos', async ({ page }) => {
    const legacyRequests = await openHome(page);
    await expectShown(page, HOME_OPENING);
    await expect(position(page)).toHaveText(at(HOME_OPENING));
    await page.reload();
    await waitForHydration(page);
    await expectShown(page, HOME_OPENING);
    expect(legacyRequests).toEqual([]);
});

test('puts the series title, its statement, and the opening photograph in the server HTML', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain(HOME_SERIES.title);
    expect(html).toContain(HOME_SERIES.shortStatement);
    expect(html).toContain(`data-photo-id="${HOME_OPENING}"`);
    expect(html).toContain(`/work/${HOME_SERIES.slug}`);
});

test('passes the surface checks on the story and slideshow controls, with unique names', async ({ page }) => {
    await openHome(page);
    await checkSurface(page, { controls: [storyControls(page)], chrome: [primary(page), themeToggle(page)] });
    await expectUniqueNames([themeToggle(page), storyControls(page), primary(page).getByRole('link')]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_SERIES.title);
});

test('Enter and Space on Previous and Next move through the authored order, wrapping, and Pause stops it', async ({ page }) => {
    await openHome(page);
    await tabTo(page, next(page));
    const start = HOME_ORDER.indexOf(HOME_OPENING);
    for (const [step, key] of (['Enter', 'Space', 'Enter'] as const).entries()) {
        await page.keyboard.press(key);
        await expectShown(page, HOME_ORDER[(start + step + 1) % HOME_ORDER.length]);
    }
    await previous(page).focus();
    await page.keyboard.press('Space');
    await expectShown(page, HOME_ORDER[(start + 2) % HOME_ORDER.length]);
    await pause(page).focus();
    await page.keyboard.press('Enter');
    await expect(play(page)).toBeVisible();
    await expect(page.locator('[data-playback]')).toHaveAttribute('data-playback', 'paused');
});

test('Enter on Enter the series goes to the series page', async ({ page }) => {
    await openHome(page);
    await tabTo(page, enter(page));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/work/${HOME_SERIES.slug}`);
});

test('a click on Next, after a move reveals the chrome, moves to the next authored photograph', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.mouse.move(x, y, { steps: 2 });
    await next(page).click();
    await expectShown(page, HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length]);
});

test('after the first tap reveals the chrome, a tap on Next, Pause, and Enter the series each act', async ({ page }, testInfo) => {
    runsOn(testInfo, 'mobile');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.touchscreen.tap(x, y);
    await expect(page.locator('main[data-interface-state]')).toHaveAttribute('data-interface-state', 'interactive');
    await next(page).tap();
    await expectShown(page, HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length]);
    await pause(page).tap();
    await expect(play(page)).toBeVisible();
    await enter(page).tap();
    await expect(page).toHaveURL(`/work/${HOME_SERIES.slug}`);
});

test('a failed next image keeps the photograph on screen, and Skip moves past it', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    const start = HOME_ORDER.indexOf(HOME_OPENING);
    const failing = HOME_ORDER[(start + 1) % HOME_ORDER.length];
    const after = HOME_ORDER[(start + 2) % HOME_ORDER.length];
    await page.route(`**/media/${failing}/**`, (route) => route.abort());
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    await tabTo(page, next(page));
    await page.keyboard.press('Enter');
    await expect(position(page)).toHaveText(at(failing));
    await expect(page.getByRole('status')).toHaveText(`Photograph ${at(failing).replace(' / ', ' of ')} couldn’t load.`);
    await expectShown(page, HOME_OPENING);
    // Skip sits before the slideshow controls, so Shift+Tab reaches it from Next.
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    for (let press = 0; press < 3 && !(await skip.evaluate((el) => el === document.activeElement)); press++) await page.keyboard.press('Shift+Tab');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expectShown(page, after);
    await expect(page.getByRole('status')).toHaveText('');
});
