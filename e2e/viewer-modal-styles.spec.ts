import type { Page, Route } from '@playwright/test';
import { ERROR_HEADING } from '../components/site/onlineStatus';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { P, href, useViewerCatalog } from './support/viewerCatalog';

// The modal Viewer's styles load with its shell, not with the series page (components/viewer/viewerShellLoader.ts),
// so a cold open from a series has to wait for them, and a load that fails has to land on the photo's own page.
//
// The waits: the idle preload is switched off, so only the open's own intent (the click's pointer, the keyboard's
// focus) starts the load, and every stylesheet asked for after hydration is held until the test lets it go. While
// it's held the dialog must not be in the document; once it's let go the dialog opens, and the page has recorded its
// look on the first frame it was open, before that frame painted, which must be the settled modal's. Light and Black,
// today's look; the parity gate checks the open modal against v1.2.0 (e2e/themes/black-parity.spec.ts, viewer-modal).

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();
/** What the user agent's own dialog shows where the Viewer's rules haven't applied: a block box, padded, on Canvas. */
const LOOK = ['display', 'padding-top', 'background-color', 'border-top-width', 'max-width', 'max-height'] as const;
/** Set on the Viewer's root rule alone, so a stylesheet carrying it carries the Viewer's styles. */
const VIEWER_RULE = '--viewer-header';
/** Past the loader's own deadline (VIEWER_STYLES_DEADLINE, 8 s) with room for the photo's page to load after it. */
const FALLBACK_TIMEOUT = 25_000;

interface Watch {
    /** The dialog's look on the first frame it was open, read in that frame's animation callback, before it paints. */
    look: Record<string, string> | null;
    /** Whether the dialog was ever in the document before the Viewer's stylesheet applied. */
    earlyInDocument: boolean;
}

/** Watches for the modal from the first script on, in the page itself, so no frame can go by unseen. */
async function watchFirstFrame(page: Page): Promise<void> {
    await page.addInitScript((props: readonly string[]) => {
        const state: Watch = { look: null, earlyInDocument: false };
        (window as unknown as { kgWatch: Watch }).kgWatch = state;
        const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-surface="viewer"]');
        const sheetApplies = (element: Element) => {
            const root = `.${CSS.escape(element.classList[0] ?? '')}`;
            return Array.from(document.styleSheets).some((sheet) => {
                try {
                    return Array.from(sheet.cssRules).some((rule) => rule instanceof CSSStyleRule && rule.selectorText.split(',').some((s) => s.trim() === root));
                } catch {
                    return false;
                }
            });
        };
        new MutationObserver(() => {
            const found = dialog();
            if (found && !sheetApplies(found)) state.earlyInDocument = true;
        }).observe(document, { childList: true, subtree: true });
        const frame = () => {
            const found = dialog();
            if (found?.open && state.look === null) {
                const style = getComputedStyle(found);
                state.look = Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
                return;
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }, LOOK);
}

/** No idle preload: only an open's own intent starts the shell's load. */
async function noIdlePreload(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.requestIdleCallback = () => 0;
        window.cancelIdleCallback = () => {};
    });
}

interface Held {
    url: string;
    at: number;
    body: string;
}

/** Holds every stylesheet asked for after `start()` until `release()`, recording each one's URL, time and body. */
async function holdLateSheets(page: Page) {
    let holding = false;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const held: Held[] = [];
    await page.route('**/*.css*', async (route: Route) => {
        if (!holding) return route.continue();
        const response = await route.fetch();
        held.push({ url: route.request().url(), at: Date.now(), body: await response.text() });
        await released;
        await route.fulfill({ response });
    });
    let started = 0;
    return {
        start: () => {
            holding = true;
            started = Date.now();
        },
        release: () => release(),
        held,
        /** The held sheets that carry the Viewer's styles, asked for after `start()`, that the series page didn't link. */
        viewerSheets: (linked: string[]) => held.filter((sheet) => sheet.at >= started && sheet.body.includes(VIEWER_RULE) && !linked.includes(sheet.url)),
    };
}

/** The stylesheets the page links now. */
const linkedSheets = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (link) => link.href));

const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture harbor/ });
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);

async function settledLook(page: Page): Promise<Record<string, string>> {
    return dialog(page).evaluate((element, props) => Object.fromEntries(props.map((prop) => [prop, getComputedStyle(element).getPropertyValue(prop)])), LOOK);
}

const watched = (page: Page) => page.evaluate(() => (window as unknown as { kgWatch: Watch }).kgWatch);

/** Holds the open on the Viewer's sheet: it's asked for, the dialog stays out of the document, then it's let go. */
async function expectHeldThenOpen(page: Page, sheets: Awaited<ReturnType<typeof holdLateSheets>>, linked: string[]): Promise<void> {
    await expect.poll(() => sheets.viewerSheets(linked).length, { message: "the open asked for the Viewer's own sheet, and it's held" }).toBeGreaterThan(0);
    // Long enough for the RSC answer and a commit, had the open not waited.
    await page.waitForTimeout(1000);
    await expect(page.locator('dialog'), 'no dialog while the sheet is held').toHaveCount(0);
    await expect(page).toHaveURL(`${origin()}/work/harbor`);
    sheets.release();
    await expect(dialog(page)).toBeVisible();
    const first = await watched(page);
    expect(first.earlyInDocument, 'the dialog never sat in the document before its styles').toBe(false);
    expect(first.look, "the first open frame has the settled modal's look").toEqual(await settledLook(page));
    expect(first.look?.display, 'not the user agent dialog').not.toBe('block');
}

for (const theme of ['light', 'black'] as const) {
    test.describe(`in ${theme === 'black' ? 'Black' : 'Light'}`, () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
            await noIdlePreload(page);
            await watchFirstFrame(page);
        });

        test("a cold click from the series waits for the Viewer's sheet, and the first frame of the modal is styled", async ({ page }) => {
            const sheets = await holdLateSheets(page);
            await page.goto(`${origin()}/work/harbor`);
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            const linked = await linkedSheets(page);
            sheets.start();
            await entry(page, P[1]).click();
            await expectHeldThenOpen(page, sheets, linked);
            await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        });

        test('a keyboard open waits the same way, focus moves in, and Escape brings it back to the entry', async ({ page }) => {
            const sheets = await holdLateSheets(page);
            await page.goto(`${origin()}/work/harbor`);
            await waitForHydration(page);
            const linked = await linkedSheets(page);
            sheets.start();
            await entry(page, P[1]).focus();
            await page.keyboard.press('Enter');
            await expectHeldThenOpen(page, sheets, linked);
            await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog')).toHaveCount(0);
            await expect(entry(page, P[1])).toBeFocused();
        });
    });
}

test("the series page links none of the Viewer's styles, and fetches them once idle, ahead of an open", async ({ page }) => {
    await page.goto(`${origin()}/work/harbor`);
    const html = await (await page.request.get(`${origin()}/work/harbor`)).text();
    const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) => match[1]);
    const bodies = await Promise.all(linked.map(async (url) => (await page.request.get(new URL(url, origin()).toString())).text()));
    expect(bodies.some((css) => css.includes(VIEWER_RULE)), "the first load carries none of the Viewer's rules").toBe(false);
    await waitForHydration(page);
    const applies = () =>
        page.evaluate((rule) => {
            return Array.from(document.styleSheets).some((sheet) => {
                try {
                    return Array.from(sheet.cssRules).some((each) => each instanceof CSSStyleRule && each.style.getPropertyValue(rule) !== '');
                } catch {
                    return false;
                }
            });
        }, VIEWER_RULE);
    await expect.poll(applies, { message: 'the idle load brings them in', timeout: 15_000 }).toBe(true);
});

test("a photo page loaded directly gets the Viewer's styles once, with no second copy from the shell's chunk", async ({ page }) => {
    const sheets: string[] = [];
    page.on('response', async (response) => {
        if (response.request().resourceType() === 'stylesheet' && (await response.text().catch(() => '')).includes(VIEWER_RULE)) sheets.push(response.url());
    });
    await page.goto(`${origin()}${href(P[1])}`);
    await waitForHydration(page);
    await expect(page.locator('main[data-surface="viewer"]')).toHaveAttribute('data-viewer-mode', 'page');
    await page.waitForLoadState('networkidle');
    expect(sheets, "one stylesheet carries the Viewer's rules").toHaveLength(1);
});

test.describe("when the Viewer's styles can't load, a photo opens as its own page", () => {
    /** What the series showed before it went: the error page, nothing at all, or a dialog. */
    async function watchSeries(page: Page): Promise<string[]> {
        const seen: string[] = [];
        await page.exposeBinding('kgSaw', (_source, what: string) => void seen.push(what));
        await page.addInitScript((heading: string) => {
            const saw = (window as unknown as { kgSaw: (what: string) => void }).kgSaw;
            new MutationObserver(() => {
                // A failed open never shows a dialog, at any URL.
                if (document.querySelector('dialog') !== null) saw('a dialog');
                if (!/^\/work\/[^/]+\/?$/.test(location.pathname)) return;
                if (Array.from(document.querySelectorAll('h1, h2')).some((h) => h.textContent?.trim() === heading)) saw('the error page');
                if (document.querySelector('main') === null) saw('no series');
            }).observe(document, { childList: true, subtree: true });
        }, ERROR_HEADING);
        return seen;
    }

    /** Counts the page's live 50 ms intervals, the shape of the loader's poll. */
    async function countPolls(page: Page): Promise<void> {
        await page.addInitScript(() => {
            const live = new Set<number>();
            (window as unknown as { kgPolls: () => number }).kgPolls = () => live.size;
            const set = window.setInterval.bind(window);
            const clear = window.clearInterval.bind(window);
            window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
                const id = set(handler, timeout, ...rest);
                if (timeout === 50) live.add(id);
                return id;
            }) as typeof window.setInterval;
            window.clearInterval = ((id?: number) => {
                if (id !== undefined) live.delete(id);
                clear(id);
            }) as typeof window.clearInterval;
        });
    }

    test.beforeEach(async ({ page }) => {
        await noIdlePreload(page);
        await countPolls(page);
    });

    test("a 404 for the Viewer's sheet: the click loads the photo's page, styled, focus sane, nothing polls after, and one Back returns", async ({ page }) => {
        const seen = await watchSeries(page);
        let failing = false;
        const failed: string[] = [];
        await page.route('**/*.css*', async (route) => {
            if (!failing) return route.continue();
            const response = await route.fetch();
            if (!(await response.text()).includes(VIEWER_RULE)) return route.fulfill({ response });
            failed.push(route.request().url());
            await route.fulfill({ status: 404, body: '' });
        });
        await page.goto(`${origin()}/work/harbor`);
        await waitForHydration(page);
        failing = true;
        // The photo's own page loads as a document: from then on its sheet comes through.
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame() && frame.url().includes('/photo/')) failing = false;
        });
        await entry(page, P[1]).scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => ({ scrollY: Math.round(window.scrollY), entries: history.length }));
        await entry(page, P[1]).click();
        await page.waitForURL(`${origin()}${href(P[1])}`, { timeout: FALLBACK_TIMEOUT });
        const viewer = page.locator('main[data-surface="viewer"]');
        await expect(viewer, "the photo's own page, as a page").toHaveAttribute('data-viewer-mode', 'page', { timeout: FALLBACK_TIMEOUT });
        expect(failed.length, "the Viewer's sheet was asked for and failed").toBeGreaterThan(0);
        expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).name), 'a full load of the photo URL').toBe(`${origin()}${href(P[1])}`);
        expect(await viewer.evaluate((root, rule) => getComputedStyle(root).getPropertyValue(rule).trim(), VIEWER_RULE), 'styled').toBe('3.5rem');
        await expect(page.locator('dialog')).toHaveCount(0);
        expect(seen, 'the series never showed the error page or a dialog, and never went blank').toEqual([]);
        // The photo's page took the open's history entry: one more than the series had, not two (the review's M3).
        expect(await page.evaluate(() => history.length), 'one history entry for the open').toBe(before.entries + 1);
        // A page moves no focus on load, and Tab goes into the Viewer.
        await waitForHydration(page);
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.closest('[data-surface="viewer"]') !== null)).toBe(true);
        await page.waitForTimeout(1000);
        expect(await page.evaluate(() => (window as unknown as { kgPolls: () => number }).kgPolls()), 'no poll left running').toBe(0);
        // One Back returns to the series, scrolled where it was.
        await page.goBack();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(entry(page, P[1])).toBeInViewport();
        expect(Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - before.scrollY), 'scrolled where it was').toBeLessThanOrEqual(4);
    });

    test("a photo page loaded directly whose shell can't load keeps the server's Viewer: Previous, Next and Close still work", async ({ page }) => {
        const errors: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        // The shell's chunk: data-viewer-announcer is ViewerShell's alone.
        const failed: string[] = [];
        await page.route('**/_next/static/**/*.js*', async (route) => {
            const response = await route.fetch();
            if (!(await response.text()).includes('data-viewer-announcer')) return route.fulfill({ response });
            failed.push(route.request().url());
            await route.fulfill({ status: 404, body: '' });
        });
        const viewer = page.locator('main[data-surface="viewer"]');
        const opened = async (photoId: string) => {
            await expect(page).toHaveURL(`${origin()}${href(photoId)}`);
            await expect(viewer).toHaveAttribute('data-viewer-mode', 'page');
            expect(await viewer.evaluate((root, rule) => getComputedStyle(root).getPropertyValue(rule).trim(), VIEWER_RULE), `${photoId} is styled`).toBe('3.5rem');
        };
        await page.goto(`${origin()}${href(P[1])}`);
        await opened(P[1]);
        expect(failed.length, "the shell's chunk was asked for and failed").toBeGreaterThan(0);
        await page.waitForTimeout(1000);
        await viewer.getByRole('link', { name: 'Next photograph' }).click();
        await opened(P[2]);
        await viewer.getByRole('link', { name: 'Previous photograph' }).click();
        await opened(P[1]);
        await viewer.getByRole('link', { name: 'Close' }).click();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        expect(errors.filter((text) => /hydrat|did not match|mismatch/i.test(text)), 'no hydration mismatch').toEqual([]);
    });

    test("offline: the click goes to the photo's URL, and the series never shows the error page", async ({ page, context }) => {
        const seen = await watchSeries(page);
        await page.goto(`${origin()}/work/harbor`);
        await waitForHydration(page);
        await context.setOffline(true);
        try {
            const navigation = page.waitForRequest((request) => request.isNavigationRequest() && request.url() === `${origin()}${href(P[1])}`, { timeout: FALLBACK_TIMEOUT });
            await entry(page, P[1]).click();
            await navigation;
            expect(seen).toEqual([]);
        } finally {
            await context.setOffline(false);
        }
    });
});
