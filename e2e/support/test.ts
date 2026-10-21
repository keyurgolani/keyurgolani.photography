import path from 'node:path';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import type { ImageItem } from '../../utils/getImageData';
import { DEFAULT_PHOTO_NAMES, fixtureDir, isPhotoFixture, photoFixture } from './fixtures';

const photoLists = new WeakMap<Page, readonly string[]>();

/**
 * Sets the photos the intercepted /api/photos lists for this page, by fixture
 * name without `.jpg`. Call it before the navigation that should see them.
 */
export function setPhotoFixtures(page: Page, names: readonly string[]): void {
    names.forEach(photoFixture); // throws on an unknown name
    photoLists.set(page, [...names]);
}

const NEWEST = Date.UTC(2024, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

function photoRecords(names: readonly string[]): ImageItem[] {
    // Newest first, like the real route
    return names.map((name, index) => {
        const { width, height, caption } = photoFixture(name);
        const url = `/assets/photos/${name}.jpg`;
        // The fixture itself stands in for every derivative, so the optimized size is its own
        return {
            id: index, src: url, thumbnail: url, medium: url, optimized: url, width, height,
            optimizedWidth: width, optimizedHeight: height, caption, date: NEWEST - index * DAY, lqip: '',
        };
    });
}

async function servePhoto(route: Route, pathname: string): Promise<void> {
    const file = path.posix.basename(pathname);
    const name = file.endsWith('.jpg') ? file.slice(0, -'.jpg'.length) : '';
    if (!isPhotoFixture(name)) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `No photo fixture named ${file}` });
        return;
    }
    await route.fulfill({ path: path.join(fixtureDir(), file), contentType: 'image/jpeg' });
}

export const test = base.extend<{ photoRoutes: void }>({
    // Routes every page before its first navigation, so the app only ever sees fixtures
    photoRoutes: [
        async ({ page }, use) => {
            await page.route('**/api/photos', (route) => route.fulfill({ json: photoRecords(photoLists.get(page) ?? DEFAULT_PHOTO_NAMES) }));
            await page.route('**/assets/photos/**', (route) => servePhoto(route, new URL(route.request().url()).pathname));
            // Photo URLs through the image optimizer get the fixture too. Anything else, like the About portrait, passes through.
            await page.route('**/_next/image**', (route) => {
                const request = new URL(route.request().url());
                const source = new URL(request.searchParams.get('url') ?? '', request);
                if (source.origin === request.origin && source.pathname.startsWith('/assets/photos/')) {
                    return servePhoto(route, source.pathname);
                }
                return route.fallback();
            });
            await use();
        },
        { auto: true },
    ],
});

export { expect };
