import type { Locator, Page } from '@playwright/test';
import { artist } from '../data/artist';
import { expectNoA11yViolations } from './support/a11y';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectRingNotClipped } from './support/focus';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { expect, test } from './support/test';

// The About subset of #1: the navigation links and theme control in full,
// Tab reach and the ring for the external links, and axe. #11's own checks
// on those links are in about-links.spec.ts. #12's checks on the statement
// and portrait are at the end.

const ENABLED = artist.destinations.filter((destination) => destination.enabled);

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const links = (page: Page) => page.getByRole('navigation', { name: /^External profiles( and contact)?$/ }).getByRole('link');
const source = (page: Page) => links(page).filter({ hasText: /^Site source$/ });

/** Stops with an aria-label report it, links without one their href, and the toggle its rendered name. */
const focusedStop = (page: Page) =>
    page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('aria-label') ?? el?.getAttribute('href') ?? el?.innerText.trim();
    });

async function openAbout(page: Page) {
    await page.goto('/about');
    await waitForHydration(page);
    await expect(links(page)).toHaveCount(ENABLED.length);
}

test('passes axe', async ({ page }) => {
    await openAbout(page);
    await expectNoA11yViolations(page);
});

test('Tab goes through SiteNav, its toggle last, then the external links, and Shift+Tab walks back', async ({ page }) => {
    await openAbout(page);
    const stops = ['KG, Keyur Golani', '/', '/work', '/about', 'Switch to light mode', ...ENABLED.map((destination) => destination.href)];
    const forward: (string | undefined)[] = [];
    for (let press = 0; press < stops.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedStop(page));
    }
    expect(forward).toEqual(stops);
    const back: (string | undefined)[] = [];
    for (let press = 1; press < stops.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedStop(page));
    }
    expect(back).toEqual(stops.slice(0, -1).reverse());
});

test('Enter and Space on the theme toggle flip the theme', async ({ page }) => {
    await openAbout(page);
    const html = page.locator('html');
    await themeToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Space');
    await expect(html).toHaveAttribute('data-theme', 'dark');
});

// Work links to /work, which before the cutover sends this legacy-mode server on to /gallery.
for (const [name, href, path] of [['Work', '/work', '/gallery'], ['Home', '/', '/']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openAbout(page);
        await expect(primary(page).getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('the theme toggle, the Primary links, and the external links show the focus ring', async ({ page }) => {
    await openAbout(page);
    for (const group of [themeToggle(page), navLinks(page), links(page)]) {
        for (const target of await group.all()) await expectFocusRingVisible(target);
    }
});

test.describe('in a short 1280 by 400 window', () => {
    test.use({ viewport: { width: 1280, height: 400 } });

    test('no overflow container clips an external link ring', async ({ page }) => {
        await openAbout(page);
        for (const target of await links(page).all()) await expectRingNotClipped(target);
    });
});

test('the external links reflow at 320 px without overlap', async ({ page }) => {
    await openAbout(page);
    await expectReflow(links(page));
});

test('every external link shows its label at rest, so nothing waits for hover or focus', async ({ page }) => {
    await openAbout(page);
    const list = page.getByRole('navigation', { name: /^External profiles( and contact)?$/ });
    // What each element in the list shows, which hover or focus must not change.
    const shown = () =>
        list.evaluate((nav) =>
            [nav, ...Array.from(nav.querySelectorAll('*'))].map((el) => {
                const { display, visibility, opacity } = getComputedStyle(el);
                return `${el.tagName} ${display} ${visibility} ${opacity}`;
            }),
        );
    const atRest = await shown();
    for (const [index, link] of (await links(page).all()).entries()) {
        await expect(link.getByText(ENABLED[index].label, { exact: true })).toBeVisible();
        await link.hover();
        expect(await shown(), `hovering ${ENABLED[index].label}`).toEqual(atRest);
        await link.focus();
        expect(await shown(), `focusing ${ENABLED[index].label}`).toEqual(atRest);
    }
});

test('the Site source link and the rest drop their focus ring at once on blur', async ({ page }) => {
    await openAbout(page);
    await expect(source(page)).toHaveCount(1);
    for (const target of await links(page).all()) await expectNoFadeOnBlur(target);
});

// #12's statement and portrait: the content from data/artist.ts, the reading
// order, the portrait's size, alt, and fallback, long copy, 200% text, and
// stacking. The motion checks on the portrait are in about-links.spec.ts.

const { profile } = artist;
/** Absorbs subpixel layout. */
const SLACK = 0.5;

const main = (page: Page) => page.getByRole('main');
const portrait = (page: Page) => page.getByTestId('about-portrait');
const heading = (page: Page) => main(page).getByRole('heading', { level: 1 });
/** The statement's paragraphs, which are the article's own p children. */
const paragraphs = (page: Page) => main(page).locator('article > p');
const caption = [profile.name, profile.alias].filter(Boolean).join(' · ');

type Box = { left: number; top: number; right: number; bottom: number };
const boxOf = (target: Locator): Promise<Box> =>
    target.evaluate((el) => {
        const { left, top, right, bottom } = el.getBoundingClientRect();
        return { left, top, right, bottom };
    });
const intersects = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK;

/** Horizontal scroll, and text in main that overflows its own box, the viewport's sides, or a clipping ancestor. */
const readabilityProblems = (page: Page) =>
    page.evaluate((slack) => {
        const problems: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) problems.push(`the page scrolls sideways, ${root.scrollWidth} px wide in ${root.clientWidth}`);
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('main h1, main p, main figcaption'))) {
            const name = `${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 24)}"`;
            if (el.scrollWidth > el.clientWidth + slack) problems.push(`${name} overflows its box`);
            const box = el.getBoundingClientRect();
            if (box.left < -slack || box.right > root.clientWidth + slack) problems.push(`${name} runs past the side of the viewport`);
            for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
                const { overflowX, overflowY } = getComputedStyle(node);
                if (![overflowX, overflowY].some((value) => value === 'hidden' || value === 'clip')) continue;
                const clip = node.getBoundingClientRect();
                if (box.left < clip.left - slack || box.right > clip.right + slack || box.top < clip.top - slack || box.bottom > clip.bottom + slack) {
                    problems.push(`${name} is clipped by ${node.tagName.toLowerCase()}`);
                }
            }
        }
        return problems;
    }, SLACK);

/** Portrait above the heading above the first link. */
async function expectStacked(page: Page) {
    const [figure, title, first] = [await boxOf(portrait(page)), await boxOf(heading(page)), await boxOf(links(page).first())];
    expect(figure.bottom, 'the portrait sits above the heading').toBeLessThanOrEqual(title.top + SLACK);
    expect(title.bottom, 'the heading sits above the links').toBeLessThanOrEqual(first.top + SLACK);
}

/** Portrait left of the heading, the heading above the first link. */
async function expectSideBySide(page: Page) {
    const [figure, title, first] = [await boxOf(portrait(page)), await boxOf(heading(page)), await boxOf(links(page).first())];
    expect(figure.right, 'the portrait sits left of the statement').toBeLessThanOrEqual(title.left + SLACK);
    expect(title.bottom, 'the heading sits above the links').toBeLessThanOrEqual(first.top + SLACK);
}

/** The figure, the heading, the paragraphs, and the links clear the Primary nav and each other. */
async function expectNoOverlap(page: Page) {
    const nav = await boxOf(primary(page));
    const parts: [string, Box][] = [
        ['the portrait', await boxOf(portrait(page))],
        ['the heading', await boxOf(heading(page))],
    ];
    for (const [index, paragraph] of (await paragraphs(page).all()).entries()) parts.push([`paragraph ${index + 1}`, await boxOf(paragraph)]);
    parts.push(['the links', await boxOf(page.getByRole('navigation', { name: /^External profiles( and contact)?$/ }))]);
    const problems: string[] = [];
    for (const [index, [name, box]] of parts.entries()) {
        if (intersects(box, nav)) problems.push(`${name} meets the Primary nav`);
        for (const [other, otherBox] of parts.slice(index + 1)) if (intersects(box, otherBox)) problems.push(`${name} meets ${other}`);
    }
    expect(problems).toEqual([]);
}

test.describe('the statement and portrait', () => {
    test('render the authored profile: heading, paragraphs, no biography, and the captioned portrait, on the about surface', async ({ page }) => {
        await openAbout(page);
        await expect(heading(page)).toHaveText(profile.statementHeading);
        await expect(heading(page)).toHaveAttribute('data-testid', 'about-heading');
        await expect(paragraphs(page)).toHaveText(profile.statementParagraphs);
        await expect(main(page).getByRole('heading')).toHaveCount(1);
        await expect(portrait(page).locator('figcaption')).toHaveText(caption);
        await expect(page.locator('main[data-surface="about"]')).toHaveCount(1);
        await expect(primary(page)).toHaveAttribute('data-surface', 'about');
    });

    test('the portrait loads content-hashed through /_next/image with its alt, intrinsic size, and focal point', async ({ page }) => {
        await openAbout(page);
        const image = portrait(page).getByRole('img', { name: profile.portrait?.alt, exact: true });
        await expect(image).toHaveAttribute('width', String(profile.portrait?.width));
        await expect(image).toHaveAttribute('height', String(profile.portrait?.height));
        await expect(image).toHaveAttribute('sizes', /\S/);
        await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
        const source = new URL(await image.evaluate((el: HTMLImageElement) => el.currentSrc));
        expect(source.pathname).toBe('/_next/image');
        expect(source.searchParams.get('url')).toMatch(/^\/_next\/static\/media\/front\.[\w-]+\.png$/);
        const { x, y } = profile.portrait?.focalPoint ?? { x: 50, y: 50 };
        await expect(image).toHaveCSS('object-position', `${x}% ${y}%`);
        await expect(image).toHaveCSS('object-fit', 'cover');
    });

    test('come first in main: the first focusable element in main is an external link, after the heading', async ({ page }) => {
        await openAbout(page);
        const first = await main(page).evaluate((el) => {
            const focusable = el.querySelector<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
            const h1 = el.querySelector('h1');
            return {
                inLinks: Boolean(focusable?.closest('nav[aria-label^="External profiles"]')),
                afterHeading: Boolean(h1 && focusable && h1.compareDocumentPosition(focusable) & Node.DOCUMENT_POSITION_FOLLOWING),
            };
        });
        expect(first).toEqual({ inLinks: true, afterHeading: true });
    });

    test('read in order on this project, clear of the Primary nav, with nothing clipped', async ({ page, isMobile }, testInfo) => {
        await openAbout(page);
        if (isMobile) await expectStacked(page);
        else await expectSideBySide(page);
        await expectNoOverlap(page);
        expect(await readabilityProblems(page)).toEqual([]);
        await testInfo.attach(`about-${testInfo.project.name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });

    test('a failed portrait request leaves the name and alias as text and no broken image', async ({ page }) => {
        await page.route('**/_next/image**', (route) => route.fulfill({ status: 500, body: '' }));
        await openAbout(page);
        await expect(portrait(page)).toHaveText(caption);
        await expect(main(page).locator('img')).toHaveCount(0);
        await expect(main(page).locator('figcaption')).toHaveCount(0);
        await expect(heading(page)).toHaveText(profile.statementHeading);
        expect(await readabilityProblems(page)).toEqual([]);
    });

    test('with the portrait gone, the statement and links still read in order', async ({ page }) => {
        await openAbout(page);
        await portrait(page).evaluate((el) => el.remove());
        await expect(heading(page)).toBeVisible();
        const [title, first] = [await boxOf(heading(page)), await boxOf(links(page).first())];
        expect(title.bottom).toBeLessThanOrEqual(first.top + SLACK);
        expect(await readabilityProblems(page)).toEqual([]);
    });
});

test.describe('the statement and portrait at set sizes', () => {
    test.skip(({ isMobile }) => isMobile, 'Each test sets its own size. The checks above run on both projects.');

    for (const [width, height] of [[320, 568], [390, 844], [768, 1024]] as const) {
        test(`stack portrait, statement, then links at ${width} by ${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await openAbout(page);
            await expectStacked(page);
            await expectNoOverlap(page);
            expect(await readabilityProblems(page)).toEqual([]);
        });
    }

    test('sit side by side at 1280 by 800', async ({ page }) => {
        await openAbout(page);
        await expectSideBySide(page);
        await expectNoOverlap(page);
    });

    for (const [width, height] of [[390, 844], [1280, 800]] as const) {
        test(`stay readable with 200% text at ${width} by ${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await openAbout(page);
            await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
            expect(await readabilityProblems(page)).toEqual([]);
            await expectNoOverlap(page);
            // The caption grows the frame below the photo instead of covering the face.
            const [photo, band] = [await boxOf(portrait(page).locator('img')), await boxOf(portrait(page).locator('figcaption'))];
            expect(band.top, 'the caption starts at or below the photo').toBeGreaterThanOrEqual(photo.bottom - SLACK);
        });
    }

    for (const [width, height] of [[320, 568], [1280, 800]] as const) {
        test(`hold long copy and a 60-character token without clipping at ${width} by ${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await openAbout(page);
            // Synthetic copy, swapped into the live page.
            const token = 'ISerialClickerPhotographsTheDistanceBetweenAPlaceAndMemory12';
            expect(token).toHaveLength(60);
            await heading(page).evaluate((el, text) => {
                el.textContent = `${text} ${text} ${text}`;
            }, profile.statementHeading);
            await paragraphs(page).first().evaluate((el, text) => {
                el.textContent = `${text} ${el.textContent} `.repeat(6);
            }, token);
            expect(await readabilityProblems(page)).toEqual([]);
            await expectNoOverlap(page);
        });
    }
});
