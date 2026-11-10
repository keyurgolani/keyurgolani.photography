import type { Page } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { HARBOR, href, useViewerCatalog } from './support/viewerCatalog';

// #247 and #246, the Viewer's half: one announcement per move, the Viewer's own. Each move is a client-side
// navigation, so Next's route announcer (<next-route-announcer>, an assertive role="alert" in its shadow root) writes
// the new title on every one. While the Viewer is mounted it keeps that host aria-hidden, so only its own polite line
// is spoken, and leaving it lets the announcer speak the series page as any page change does. The Viewer's status is
// empty again once its message has had time to be heard, so reading on never meets it twice.

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();

const viewer = (page: Page) => page.locator('[data-surface="viewer"]');
const control = (page: Page, name: string) => viewer(page).getByRole('button', { name, exact: true });
const status = (page: Page) => viewer(page).locator('[data-viewer-announcer]');
const header = (page: Page) => viewer(page).locator('header');
const host = (page: Page) => page.locator('next-route-announcer');
const moved = (position: number, total: number) => new RegExp(`^Photograph ${position} of ${total}(\\. |$)`);
/** Longer than the hold (LIVE_HOLD_MS in components/liveMessage.ts), with room for a slow run. */
const AFTER_HOLD = 10_000;

/** What Next's announcer holds: the text of its shadow root, where its role="alert" div is. */
const announcerText = (page: Page) => page.evaluate(() => document.querySelector('next-route-announcer')?.shadowRoot?.textContent ?? null);

/** No alert anywhere in the page's accessibility tree, by role and in the snapshot, which reads into shadow roots. */
async function expectNoAlert(page: Page, why: string) {
    await expect(page.getByRole('alert'), why).toHaveCount(0);
    expect(await page.locator('body').ariaSnapshot(), why).not.toMatch(/^\s*- alert\b/m);
}

test.describe('Next\'s route announcer stays quiet for the Viewer\'s moves (#247)', () => {
    test('on a directly loaded page, a move says the Viewer\'s line alone, and the series page is announced after Close', async ({ page }) => {
        await page.goto(`${origin()}${href(HARBOR[0])}`);
        await waitForHydration(page);
        // Next makes its announcer once the router has hydrated, which can be after the Viewer mounted.
        await expect(host(page)).toHaveCount(1);

        // Photograph 2 has no title, so its page title is the position: the alert would say it before the Viewer did.
        await control(page, 'Next photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[1])}`);
        await expect(header(page)).toContainText('02 / 03');
        await expect(status(page)).toHaveText(moved(2, 3));
        // Next did write its announcement: the host's aria-hidden is what keeps it from being spoken. That's the new
        // title, or in WebKit, which can run Next's effect while the title is being replaced, the page's h1.
        await expect.poll(() => announcerText(page)).toMatch(/^Fixture harbor(, photograph 2 of 3 · |$)/);
        await expectNoAlert(page, 'the move to photograph 2');
        await expect(host(page)).toHaveAttribute('aria-hidden', 'true');

        // Photograph 3 has a title, which the alert would say before the Viewer's line says it again.
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[2])}`);
        await expect(status(page)).toHaveText(/^Photograph 3 of 3\. Fixture harbor from the pier\. /);
        await expectNoAlert(page, 'the move to photograph 3');
        await expect(host(page)).toHaveAttribute('aria-hidden', 'true');

        // Close is a link to the series: a page change like any other, which the announcer speaks.
        await viewer(page).getByRole('link', { name: 'Close' }).click();
        await expect(page).toHaveURL(`${origin()}/work/harbor?photo=${HARBOR[2]}`);
        await expect(viewer(page)).toHaveCount(0);
        await expect(host(page)).not.toHaveAttribute('aria-hidden');
        await expect(page.getByRole('alert')).toHaveText(/^Fixture harbor( · |$)/);
    });

    test('in the modal opened from the series page, a move is the Viewer\'s line alone, and Close gives the announcer back', async ({ page }) => {
        await page.goto(`${origin()}/work/harbor`);
        await waitForHydration(page);
        await expect(host(page)).toHaveCount(1);
        await expect(host(page)).not.toHaveAttribute('aria-hidden');
        await page.locator(`[id="photo-${HARBOR[0]}"]`).click();
        const dialog = page.getByRole('dialog', { name: /^Fixture harbor/ });
        await expect(dialog).toBeVisible();

        await dialog.getByRole('button', { name: 'Next photograph', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[1])}`);
        await expect(status(page)).toHaveText(moved(2, 3));
        await expect.poll(() => announcerText(page)).toMatch(/^Fixture harbor(, photograph 2 of 3 · |$)/);
        await expectNoAlert(page, 'the move in the modal');
        await expect(host(page)).toHaveAttribute('aria-hidden', 'true');

        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(host(page)).not.toHaveAttribute('aria-hidden');
        await expect(page.getByRole('alert')).toHaveText(/^Fixture harbor( · |$)/);
    });
});

test.describe('the Viewer\'s status is empty once its message has been heard (#246)', () => {
    test('a move\'s line, then an end\'s, each leaves the status empty after the hold', async ({ page }) => {
        await page.goto(`${origin()}${href(HARBOR[1])}`);
        await waitForHydration(page);
        await control(page, 'Next photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[2])}`);
        await expect(status(page)).toHaveText(/^Photograph 3 of 3\. Fixture harbor from the pier\. /);
        await expect(status(page)).toHaveText('', { timeout: AFTER_HOLD });
        // Reading on through the Viewer meets no status text: the photograph's title is said once, by the page.
        expect(await viewer(page).ariaSnapshot()).not.toContain('Photograph 3 of 3');

        // The end message, pressed twice, is heard both times, and then goes too. Next is aria-disabled at the end, so
        // the key presses it, as a click can't.
        await page.keyboard.press('ArrowRight');
        await expect(status(page)).toHaveText('Last photograph in Fixture harbor.');
        await page.keyboard.press('ArrowRight');
        await expect(status(page)).toHaveText('Last photograph in Fixture harbor.');
        await expect(status(page)).toHaveText('', { timeout: AFTER_HOLD });
        expect(await viewer(page).ariaSnapshot()).not.toContain('Last photograph');
    });
});

test.describe('an open that waits for the shell\'s chunk (#247)', () => {
    test('is never announced by Next: the series page stays until the shell is in, and the shell marks the host first', async ({ page }) => {
        // From the page's start, every change to the announcer's host's aria-hidden and to its shadow root's text, in
        // the order they happened: one observer for both keeps that order.
        await page.addInitScript(() => {
            const log: string[] = [];
            (window as unknown as { kgAnnouncer: string[] }).kgAnnouncer = log;
            const watch = (host: Element) => {
                log.push(`host aria-hidden=${host.getAttribute('aria-hidden')}`);
                const observer = new MutationObserver((records) => {
                    for (const record of records) log.push(record.type === 'attributes' ? 'flip' : `text=${host.shadowRoot?.textContent ?? ''}`);
                });
                observer.observe(host, { attributes: true, attributeFilter: ['aria-hidden'] });
                if (host.shadowRoot) observer.observe(host.shadowRoot, { childList: true, characterData: true, subtree: true });
            };
            new MutationObserver((records) => {
                for (const record of records) for (const added of record.addedNodes) if (added instanceof Element && added.localName === 'next-route-announcer') watch(added);
            }).observe(document, { childList: true, subtree: true });
        });
        // The shell's chunk (data-viewer-announcer is ViewerShell's alone) is held until the test lets it go, so the
        // open, and any load ahead of it on the link's intent or the idle time, waits on it.
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const delayed: string[] = [];
        await page.route('**/_next/static/**/*.js*', async (route) => {
            try {
                const response = await route.fetch();
                const body = await response.text();
                if (body.includes('data-viewer-announcer')) {
                    delayed.push(route.request().url());
                    await held;
                }
                await route.fulfill({ response, body });
            } catch (error) {
                if (!/disposed|has been closed|Test ended/.test(String(error))) throw error;
            }
        });
        await page.goto(`${origin()}/work/harbor`);
        await waitForHydration(page);
        await expect(host(page)).toHaveCount(1);
        await page.locator(`[id="photo-${HARBOR[0]}"]`).click();
        await expect.poll(() => delayed.length, "the shell's chunk was asked for and held").toBeGreaterThan(0);
        // While it waits, the series page is the page: no dialog, and nothing in the announcer.
        await page.waitForTimeout(1000);
        await expect(page.locator('dialog')).toHaveCount(0);
        expect(await announcerText(page), 'the announcer, while the open waits').toBe('');
        await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
        release();
        await expect(page.getByRole('dialog', { name: /^Fixture harbor/ })).toBeVisible();
        await expect(host(page)).toHaveAttribute('aria-hidden', 'true');
        await expectNoAlert(page, 'the open');
        // Replayed in order: no text was written into the alert while its host wasn't hidden.
        const log = await page.evaluate(() => (window as unknown as { kgAnnouncer: string[] }).kgAnnouncer);
        let hidden = log[0] === 'host aria-hidden=true';
        const spoken: string[] = [];
        for (const entry of log.slice(1)) {
            if (entry === 'flip') hidden = !hidden;
            else if (!hidden && entry !== 'text=') spoken.push(entry);
        }
        expect(log[0], 'the host, as Next made it').toBe('host aria-hidden=null');
        expect(spoken, `written while the host was exposed (${log.join(', ')})`).toEqual([]);
    });
});
