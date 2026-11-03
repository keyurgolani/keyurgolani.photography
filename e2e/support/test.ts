import { test as base, expect, type Page, type Route } from '@playwright/test';
import sharp, { type Sharp } from 'sharp';
import { HOME_OPENING, HOME_ORDER } from './catalog-home';
import { photoFixture, type PhotoFixture } from './fixtures';

const homePhotos = new WeakMap<Page, readonly string[]>();

/**
 * Paints the catalog Home's photographs on this page with the photo fixtures, by name, from the opening photograph on
 * in authored order and round again: `['white', 'gray', 'black']` puts white on the opening photograph, gray on the
 * next, black on the one after, and white again on the fourth. Call it before the navigation that should see them.
 * Home is the catalog server's (e2e/support/catalog-home.ts): since #13's slice E there is no legacy photo list to
 * stand in for, so the photographs are the fixture's own, served from /media, with only their pixels replaced.
 */
export function setPhotoFixtures(page: Page, names: readonly string[]): void {
    if (names.length === 0) throw new Error('setPhotoFixtures needs at least one fixture name.');
    names.forEach(photoFixture); // throws on an unknown name
    homePhotos.set(page, [...names]);
}

const rendered = new Map<string, Promise<Buffer>>();

/** A fixture as an image file of `format`, at its own size: one colour, or a diagonal gradient between two. */
function render({ name, width, height, colors }: PhotoFixture, format: 'webp' | 'avif'): Promise<Buffer> {
    const key = `${name}.${format}`;
    const cached = rendered.get(key);
    if (cached) return cached;
    const [from, to] = colors;
    let image: Sharp;
    if (!to) {
        image = sharp({ create: { width, height, channels: 3, background: { r: from[0], g: from[1], b: from[2] } } });
    } else {
        const data = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const t = (x / (width - 1) + y / (height - 1)) / 2;
                for (let channel = 0; channel < 3; channel++) data[(y * width + x) * 3 + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * t);
            }
        }
        image = sharp(data, { raw: { width, height, channels: 3 } });
    }
    const file = image[format]().toBuffer();
    rendered.set(key, file);
    return file;
}

/** The fixture painted on `photoId`, a photograph of Home's featured series, for this page, or null for none. */
function fixtureFor(page: Page, photoId: string): PhotoFixture | null {
    const names = homePhotos.get(page);
    const index = HOME_ORDER.indexOf(photoId as (typeof HOME_ORDER)[number]);
    if (!names || index === -1) return null;
    const count = HOME_ORDER.length;
    const fromOpening = (index - HOME_ORDER.indexOf(HOME_OPENING) + count) % count;
    return photoFixture(names[fromOpening % names.length]);
}

async function servePhoto(page: Page, route: Route): Promise<void> {
    // /media/<photoId>/<assetRevision>/<profileId>/<variant>.<format>
    const [, media, photoId, , , file = ''] = new URL(route.request().url()).pathname.split('/');
    const fixture = media === 'media' ? fixtureFor(page, photoId) : null;
    const format = file.endsWith('.avif') ? 'avif' : file.endsWith('.webp') ? 'webp' : null;
    if (!fixture || !format) return route.fallback();
    await route.fulfill({ status: 200, contentType: `image/${format}`, body: await render(fixture, format) });
}

export const test = base.extend<{ photoRoutes: void }>({
    // Every page gets the route before its first navigation, so a setPhotoFixtures() before it takes effect.
    photoRoutes: [
        async ({ page }, use) => {
            await page.route('**/media/**', (route) => servePhoto(page, route));
            await use();
        },
        { auto: true },
    ],
});

export { expect };
