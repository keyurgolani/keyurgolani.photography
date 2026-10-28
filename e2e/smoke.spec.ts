import type { Page } from '@playwright/test';
import { DEFAULT_PHOTO_NAMES, photoFixture } from './support/fixtures';
import { waitForHydration } from './support/hydration';
import { expect, setPhotoFixtures, test } from './support/test';

const tiles = (page: Page) => page.locator('main .grid > *');

const SHAPES: [string, number][] = [['3:2', 3 / 2], ['2:3', 2 / 3], ['1:1', 1], ['3:1', 3]];
const shape = (ratio: number) => SHAPES.find(([, value]) => Math.abs(ratio - value) / value < 0.03)?.[0] ?? ratio.toFixed(3);

/**
 * Each gallery image in DOM order, as the fixture file it requested and the
 * shape it decoded to. naturalWidth is scaled by the srcset density, so this
 * compares shapes rather than pixel sizes.
 */
async function galleryImages(page: Page): Promise<string[]> {
    const images = await page.locator('main .grid img').evaluateAll((elements) =>
        elements.map((element) => {
            const { complete, naturalWidth, naturalHeight, currentSrc, src } = element as HTMLImageElement;
            const requested = new URL(currentSrc || src, location.href);
            const file = (requested.searchParams.get('url') ?? requested.pathname).split('/').pop();
            return { file, loaded: complete && naturalWidth > 0, ratio: naturalWidth / naturalHeight };
        }),
    );
    return images.map(({ file, loaded, ratio }) => `${file} ${loaded ? shape(ratio) : 'not loaded'}`);
}

const expectedImages = (names: readonly string[]) =>
    names.map((name) => {
        const { width, height } = photoFixture(name);
        return `${name}.jpg ${shape(width / height)}`;
    });

test('the gallery lists every fixture and loads each image after scrolling to the end', async ({ page }) => {
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(tiles(page)).toHaveCount(12);

    // Tiles from the ninth mount their image only near the viewport, so walk down to the last one.
    for (const tile of await tiles(page).all()) await tile.scrollIntoViewIfNeeded();
    await expect(page.locator('main .grid img')).toHaveCount(12);
    await expect.poll(() => galleryImages(page)).toEqual(expectedImages(DEFAULT_PHOTO_NAMES));
});

test('setPhotoFixtures swaps the list the page sees', async ({ page }) => {
    setPhotoFixtures(page, ['gray', 'white']);
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(tiles(page)).toHaveCount(2);
    await expect.poll(() => galleryImages(page)).toEqual(expectedImages(['gray', 'white']));
});

test('photo routes serve fixtures by basename, 404 unknown files, and pass other images through to the server, which refuses any but a derivative', async ({ page }) => {
    await page.goto('/gallery');
    await waitForHydration(page);
    const responses = await page.evaluate((urls) =>
        Promise.all(urls.map(async (url) => {
            const response = await fetch(url);
            const head = `${response.status} ${response.headers.get('content-type')}`;
            // A refusal's body says which one: localPatterns refusing the URL, or Next refusing an SVG it fetched.
            return response.status === 400 ? `${head} ${await response.text()}` : head;
        })), [
        '/assets/photos/white.jpg',
        '/assets/photos/missing.jpg',
        '/_next/image?url=%2Fassets%2Fphotos%2Fphoto-01.jpg&w=400&q=75',
        '/_next/image?url=%2Fassets%2Fphotos%2Fmissing.jpg&w=400&q=75',
        '/_next/image?url=%2Fvite.svg&w=400&q=75',
    ]);
    expect(responses).toEqual([
        '200 image/jpeg',
        '404 text/plain',
        '200 image/jpeg',
        '404 text/plain',
        expect.stringMatching(/^400 .*"url" parameter is not allowed/),
    ]);
});
