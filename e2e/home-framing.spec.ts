import { devices, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
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

/** Tabs to `target`, which reveals the chrome and holds it, then presses Enter on it. */
async function press(page: Page, target: Locator) {
    for (let tab = 0; tab < 15 && !(await target.evaluate((el) => el === document.activeElement)); tab++) await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
}
const pressNext = (page: Page) => press(page, next(page));

/**
 * The colour just outside the shown slide's print, 2 px from its edge, beside it when the box is wider than the print and
 * above it otherwise, with Home's chrome, vignette and badge hidden so only the slide stack paints there. Every device
 * pixel of that CSS pixel is returned.
 */
async function besidePrint(page: Page): Promise<number[][]> {
    const style = await page.addStyleTag({ content: '[data-home-chrome], [data-home-vignette], [data-home-badge] { visibility: hidden !important; }' });
    try {
        const point = await shownSlide(page)
            .locator('img')
            .evaluate((img: HTMLImageElement) => {
                const box = img.getBoundingClientRect();
                const ratio = Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
                const width = Math.min(box.width, box.height * ratio);
                const height = width / ratio;
                return box.width - width > 8
                    ? { x: Math.floor(box.left + (box.width - width) / 2 - 3), y: Math.floor(box.top + box.height / 2) }
                    : { x: Math.floor(box.left + box.width / 2), y: Math.floor(box.top + (box.height - height) / 2 - 3) };
            });
        const png = await page.screenshot({ clip: { ...point, width: 1, height: 1 }, animations: 'disabled', caret: 'hide' });
        const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixels: number[][] = [];
        for (let i = 0; i < data.length; i += info.channels) pixels.push([data[i], data[i + 1], data[i + 2]]);
        return pixels;
    } finally {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
    }
}

const rgbOf = (css: string) => css.match(/\d+/g)!.slice(0, 3).map(Number);

test('the server HTML draws the contain opening over its LQIP until it decodes', async ({ request }) => {
    const html = await (await request.get(`${origin()}/`)).text();
    const slide = new RegExp(`<div[^>]*data-photo-id="${HOME_FRAMING.contain}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(slide).toContain('data-crop="contain"');
    expect(slide).not.toContain('data-decoded');
    expect(html.slice(html.indexOf(slide))).toMatch(/<img[^>]*style="[^"]*data:image\/webp;base64,/);
});

for (const theme of Object.keys(MATS) as (keyof typeof MATS)[]) {
    test(`in ${theme}, a contain photograph sits whole on the mat, and a cover one is cut on its focal point`, async ({ page }) => {
        await openHome(page, theme);
        await expect(page.locator('[data-home-carousel]')).toHaveCSS('background-color', MATS[theme]);
        // Paused, so Home's own interval never moves the slide under the checks below.
        await press(page, page.getByRole('button', { name: 'Pause slideshow', exact: true }));
        await expect(page.locator('[data-playback]')).toHaveAttribute('data-playback', 'paused');
        const opening = shownSlide(page);
        await expect(opening).toHaveAttribute('data-crop', 'contain');
        await expect(opening).toHaveCSS('opacity', '1');
        expect(await style(opening.locator('img'), 'object-fit', 'object-position', 'background-size', 'background-repeat', 'background-position', 'background-image')).toEqual({
            'object-fit': 'contain',
            'object-position': '50% 50%',
            // While it loads, the LQIP under the opening photograph fills the print's box, not the mat around it.
            'background-size': 'contain',
            'background-repeat': 'no-repeat',
            'background-position': '50% 50%',
            // Once the print has decoded the LQIP goes, since its own shape drifts from the photograph's (B7 review).
            'background-image': 'none',
        });
        // So the mat, and nothing of the LQIP, shows just outside the print.
        const mat = rgbOf(MATS[theme]);
        for (const pixel of await besidePrint(page)) for (const [channel, value] of pixel.entries()) expect(Math.abs(value - mat[channel]), `${pixel} against the mat ${mat}`).toBeLessThanOrEqual(3);

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

/** A width's own screen the size of its viewport, as image-sizes.spec.ts has it, so the preload scanner sees the viewport. */
const CONTEXTS: Record<string, BrowserContextOptions> = {
    '1280 by 800': { viewport: { width: 1280, height: 800 }, screen: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' },
    'Pixel 7': { ...devices['Pixel 7'], screen: devices['Pixel 7'].viewport, colorScheme: 'dark' },
};

/** The smallest candidate at or above `pixels`, else the largest: its nominal rung. */
const rungFor = (candidates: { rung: number; width: number }[], pixels: number) => {
    const sorted = [...candidates].sort((a, b) => a.width - b.width);
    return (sorted.find((candidate) => candidate.width >= pixels - 0.5) ?? sorted[sorted.length - 1]).rung;
};

async function openingRungs(browser: Browser, options: BrowserContextOptions) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const fetched: number[] = [];
    page.on('request', (request) => {
        const match = /^\/media\/(ph_[^/]+)\/[^/]+\/[^/]+\/w(\d+)\.(?:avif|webp)$/.exec(new URL(request.url()).pathname);
        if (match && match[1] === HOME_FRAMING.contain) fetched.push(Number(match[2]));
    });
    try {
        await page.goto(`${origin()}/`);
        await waitForHydration(page);
        await page.waitForLoadState('networkidle');
        const seen = await page.locator(`[data-photo-id="${HOME_FRAMING.contain}"] img`).evaluate((img: HTMLImageElement) => {
            const source = img.parentElement!.querySelector('source[type="image/avif"]')!;
            const candidates = source
                .getAttribute('srcset')!
                .split(',')
                .map((part) => part.trim().split(/\s+/))
                .map(([url, descriptor]) => ({ rung: Number(/\/w(\d+)\./.exec(url)![1]), width: Number.parseInt(descriptor, 10) }));
            const preload = document.querySelector<HTMLLinkElement>('link[rel="preload"][as="image"]');
            return {
                candidates,
                sizes: source.getAttribute('sizes'),
                preloadSizes: preload?.getAttribute('imagesizes') ?? null,
                // Layout boxes, so the slow zoom (a transform) doesn't count.
                box: { width: img.offsetWidth, height: img.offsetHeight },
                fit: getComputedStyle(img).objectFit,
                shape: Number(img.getAttribute('width')) / Number(img.getAttribute('height')),
            };
        });
        return { ...seen, fetched, dpr: options.deviceScaleFactor ?? 1 };
    } finally {
        await context.close();
    }
}

// #6's rule for a contain slide: the smaller of the box's width and its height times the photograph's shape (B7 review).
for (const [name, options] of Object.entries(CONTEXTS)) {
    test(`at ${name}, the contain opening asks for the rung #6's rule gives a contain photograph, and its preload agrees`, async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'Each size opens a context of its own.');
        const seen = await openingRungs(browser, options);
        expect(seen.fit).toBe('contain');
        expect(seen.preloadSizes).toBe(seen.sizes);
        const rule = rungFor(seen.candidates, Math.min(seen.box.width, seen.box.height * seen.shape) * seen.dpr);
        expect(seen.fetched.length, 'the opening was fetched').toBeGreaterThan(0);
        expect([...new Set(seen.fetched)], `the opening's requests against the rule's w${rule}`).toEqual([rule]);
    });
}
