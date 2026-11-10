import type { Page } from '@playwright/test';
import { altOf, CATALOG_ORIGIN, HOME_OPENING, HOME_ORDER, HOME_SERIES } from './support/catalog-home';
import { expectHomeImmersive } from './support/home';
import { waitForHydration } from './support/hydration';
import { HOME_LIVE, recordLiveFromLoad } from './support/liveRecord';
import { expect, test } from './support/test';

// #246, Home's half: the carousel's live region says the slide after the visitor's own move, and is empty the rest of
// the time, so a screen reader reading through the carousel meets the slide once: the group named for its position,
// with the photograph's description as its image, and no paragraph after it saying both again.

test.use({ baseURL: CATALOG_ORIGIN });

const carousel = (page: Page) => page.getByRole('region', { name: HOME_SERIES.title });
const live = (page: Page) => page.locator(HOME_LIVE);
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
/** Longer than the hold (LIVE_HOLD_MS in components/liveMessage.ts), with room for a slow run. */
const AFTER_HOLD = 10_000;
const after = (steps: number) => HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + steps) % HOME_ORDER.length];
const line = (photoId: string) => `${HOME_ORDER.indexOf(photoId as (typeof HOME_ORDER)[number]) + 1} of ${HOME_ORDER.length}, ${altOf(photoId)}`;

async function expectShown(page: Page, photoId: string) {
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', photoId);
    await expect.poll(() => shownSlide(page).locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(shownSlide(page)).toHaveCSS('opacity', '1');
}

/**
 * The carousel's accessibility tree reads `photoId`'s slide, named for its position, and no paragraph saying it again.
 * The empty live region is a paragraph with no text, which a screen reader has nothing to read in.
 */
async function expectSlideOnce(page: Page, photoId: string, why: string) {
    const tree = await carousel(page).ariaSnapshot();
    expect(tree, why).toContain(`- group "${HOME_ORDER.indexOf(photoId as (typeof HOME_ORDER)[number]) + 1} of ${HOME_ORDER.length}"`);
    expect(tree.split(altOf(photoId)).length - 1, `${why}: the description, once`).toBe(1);
    expect(tree, why).not.toMatch(/^\s*- paragraph:/m);
}

test('reading through the carousel meets the slide once: while Home plays, and after the visitor\'s own move once it has been said', async ({ page }) => {
    const heard = await recordLiveFromLoad(page, HOME_LIVE);
    await page.goto('/');
    await waitForHydration(page);
    await expectHomeImmersive(page);
    await expectShown(page, HOME_OPENING);
    await expect(live(page)).toHaveAttribute('aria-live', 'off');
    await expect(live(page)).toHaveText('');
    expect(await heard(), 'nothing said while Home opens and plays').toEqual([]);
    await expectSlideOnce(page, HOME_OPENING, 'Home, as it opens');

    // The visitor's own Next, as a screen reader's activation sends it: the move is announced, politely.
    await next(page).dispatchEvent('click');
    await expectShown(page, after(1));
    await expect(live(page)).toHaveAttribute('aria-live', 'polite');
    await expect(live(page)).toHaveText(line(after(1)));
    // Once it has been heard, the region is empty again, and the carousel reads as the slide alone.
    await expect(live(page)).toHaveText('', { timeout: AFTER_HOLD });
    // The one message since Home opened: the visitor's move, once.
    expect(await heard(), 'what the region said').toEqual([line(after(1))]);
    await expectSlideOnce(page, after(1), 'after the visitor\'s Next');
});
