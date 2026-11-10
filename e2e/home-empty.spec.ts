import type { Locator, Page } from '@playwright/test';
import type { TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { publishEmptyHomeFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// #4's empty state in the browser: a revision with nothing featured, which
// publish() refuses, so publishEmptyHomeFixture() writes it with #13's
// writers. Its own `next start`, since the config's catalog server serves a
// featured series.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;
let revisionId = '';

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    ({ catalog, revisionId } = await publishEmptyHomeFixture());
    // Above the ports home-variety.spec.ts and first-viewport.spec.ts take when E2E_CATALOG_PORT pins them.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 20 + test.info().parallelIndex : undefined);
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

test('with nothing featured, Home is the empty state: its one heading, the navigation up, no intro and no photograph', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    const main = page.locator('main');
    await expect(page.locator('[data-home-state]')).toHaveAttribute('data-home-state', 'empty');
    await expect(main).toHaveAttribute('data-catalog-revision', revisionId);
    await expect(main).toHaveAttribute('data-home-intro', 'settled');
    await expect(main).toHaveAttribute('data-home-loading', 'false');
    await expect(main).toHaveAttribute('data-chrome-holds', /\bno-photo\b/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing is featured right now.');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.locator('img[src^="/media/"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next photograph' })).toHaveCount(0);
});

const story = (page: Page) => page.locator('[data-home-chrome] [data-chrome-region="story"]');
const heading = (page: Page) => story(page).getByRole('heading', { level: 1 });
const workLink = (page: Page) => story(page).getByRole('link', { name: 'All bodies of work', exact: true });
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Theme:/ });

async function openEmptyHome(page: Page) {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await expect(page.locator('[data-home-state]')).toHaveAttribute('data-home-state', 'empty');
}

/** The heading's box and the link's, rounded to the half px. */
const boxes = (page: Page) =>
    Promise.all([heading(page), workLink(page)].map((el: Locator) => el.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect)));

/** Under the heading, clear of it, and starting at its left edge, as the link starts under Enter the series. */
async function expectUnderHeading(page: Page) {
    const [title, work] = await boxes(page);
    expect(work.top, 'the link starts below the heading').toBeGreaterThanOrEqual(title.bottom - 0.5);
    expect(Math.abs(work.left - title.left), 'the link lines up with the heading').toBeLessThanOrEqual(0.5);
    const viewport = page.viewportSize()!;
    expect(work.right, 'the link stays inside the viewport').toBeLessThanOrEqual(viewport.width + 0.5);
}

test('the empty state offers "All bodies of work" under its heading, next after it in the Tab order, to Work', async ({ page }) => {
    await openEmptyHome(page);
    await expect(workLink(page)).toBeVisible();
    await expect(workLink(page)).toHaveAttribute('href', '/work');
    await expect(story(page).getByRole('link')).toHaveCount(1);
    // Nothing focusable between the heading and the link in the document, so screen readers and Tab meet it next.
    const between = await page.evaluate(() => {
        const title = document.querySelector('[data-chrome-region="story"] h1')!;
        const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')];
        const after = focusable.filter((el) => title.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        return after.map((el) => el.textContent?.trim() ?? el.tagName);
    });
    expect(between[0]).toBe('All bodies of work');
    // Tab reaches it, and the element Tab left came before the heading.
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await workLink(page).evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab reaches All bodies of work').toBe(true);
    await page.keyboard.press('Shift+Tab');
    const previousBeforeHeading = await page.evaluate(() => {
        const title = document.querySelector('[data-chrome-region="story"] h1')!;
        const active = document.activeElement;
        return active !== null && active !== document.body && Boolean(title.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING);
    });
    expect(previousBeforeHeading, 'the stop before it precedes the heading').toBe(true);
    await page.keyboard.press('Tab');
    await expect(workLink(page)).toBeFocused();
    // Focusing it adds no hold of its own that could outlast the empty state's: the navigation stays up as before.
    await expect(page.locator('main')).toHaveAttribute('data-chrome-holds', /\bno-photo\b/);
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname === '/work');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bodies of work');
});

test('the empty state passes the #1 automated and keyboard checks, the Work link with the navigation', async ({ page }) => {
    await openEmptyHome(page);
    await checkSurface(page, { controls: [workLink(page), primary(page).locator('a, button')], chrome: [primary(page), themeToggle(page)] });
});

test('the Work link sits under the heading at the project viewport and at 360 px, at default text', async ({ page }) => {
    await openEmptyHome(page);
    await expect(page.locator('main')).not.toHaveAttribute('data-text-enlarged');
    await expectUnderHeading(page);
    // 360 px is where a phone puts the featured story's link beside Enter the series: here there's no Enter to sit beside.
    await page.setViewportSize({ width: 360, height: 740 });
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0);
    await expectUnderHeading(page);
});

test('at 320 px with 200% text, the heading and the Work link are clear of each other and of every control, and neither is clipped or cut short (#228)', async ({ page }) => {
    await openEmptyHome(page);
    const copyAndControls = heading(page).or(workLink(page)).or(primary(page).locator('a, button'));
    await expectReflow(copyAndControls);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    await expect(page.locator('main')).toHaveAttribute('data-text-enlarged', '');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0);
    const problems = await page.evaluate((slack) => {
        const found: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth + slack) found.push(`the page scrolls sideways, ${root.scrollWidth} px wide in ${root.clientWidth}`);
        const chrome = document.querySelector<HTMLElement>('[data-home-chrome]')!;
        if (chrome.scrollWidth > chrome.clientWidth + slack) found.push(`the chrome scrolls sideways, ${chrome.scrollWidth} px wide in ${chrome.clientWidth}`);
        const region = document.querySelector('[data-home-chrome] [data-chrome-region="story"]')!;
        const title = region.querySelector<HTMLElement>('h1')!;
        const work = region.querySelector<HTMLElement>('a')!;
        for (const el of [title, work]) {
            const name = `${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 24)}"`;
            const style = getComputedStyle(el);
            if (el.scrollWidth > el.clientWidth + slack) found.push(`${name} runs past its box sideways, ${el.scrollWidth} px in ${el.clientWidth}`);
            if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight + slack) found.push(`${name} is cut off by its own overflow-y ${style.overflowY}`);
            if (style.textOverflow === 'ellipsis' && style.overflowX !== 'visible') found.push(`${name} ends in an ellipsis`);
            if (style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '') found.push(`${name} is clamped to ${style.webkitLineClamp} lines`);
            const box = el.getBoundingClientRect();
            if (box.left < -slack || box.right > root.clientWidth + slack) found.push(`${name} runs past the side of the viewport`);
        }
        if (title.getBoundingClientRect().bottom > work.getBoundingClientRect().top + slack) found.push('the heading runs into the Work link');
        return found;
    }, 0.5);
    expect(problems).toEqual([]);
});
