import type { Page } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { P, href, useViewerCatalog } from './support/viewerCatalog';

// The modal Viewer's styles load with its shell, not with the series page (components/viewer/viewerShellLoader.ts),
// so a cold open from a series has to wait for them. With every stylesheet after hydration held back, the open must
// still never paint the modal unstyled: the page records the dialog's look on the first frame it shows open, before
// that frame paints, and that look has to be the settled modal's. Light and Black, today's look; the parity gate
// checks the open modal against v1.2.0 (e2e/themes/black-parity.spec.ts, viewer-modal).

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();
/** How long each stylesheet requested after hydration is held: far longer than an open takes otherwise. */
const SHEET_DELAY = 2000;
/** What the user agent's own dialog shows where the Viewer's rules haven't applied: a block box, padded, on Canvas. */
const LOOK = ['display', 'padding-top', 'background-color', 'border-top-width', 'max-width', 'max-height'] as const;

interface FirstFrame {
    /** The dialog's look on the first frame it was open, read in that frame's animation callback, before it paints. */
    look: Record<string, string> | null;
    /** Whether the dialog was ever in the document before the Viewer's stylesheet applied. */
    earlyInDocument: boolean;
}

/** Watches for the modal from the first script on, in the page itself, so no frame can go by unseen. */
async function watchFirstFrame(page: Page): Promise<void> {
    await page.addInitScript((props: readonly string[]) => {
        const state: FirstFrame = { look: null, earlyInDocument: false };
        (window as unknown as { kgFirstFrame: FirstFrame }).kgFirstFrame = state;
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

/** Holds every stylesheet the page asks for after hydration by SHEET_DELAY, and records when each arrives. */
async function holdLateSheets(page: Page): Promise<{ start: () => void; arrivals: number[] }> {
    let holding = false;
    const arrivals: number[] = [];
    await page.route('**/*.css*', async (route) => {
        if (!holding) return route.continue();
        await new Promise((resolve) => setTimeout(resolve, SHEET_DELAY));
        await route.continue();
        arrivals.push(Date.now());
    });
    return { start: () => (holding = true), arrivals };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture harbor/ });
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);

async function settledLook(page: Page): Promise<Record<string, string>> {
    return dialog(page).evaluate((element, props) => Object.fromEntries(props.map((prop) => [prop, getComputedStyle(element).getPropertyValue(prop)])), LOOK);
}

async function firstFrame(page: Page): Promise<FirstFrame> {
    return page.evaluate(() => (window as unknown as { kgFirstFrame: FirstFrame }).kgFirstFrame);
}

for (const theme of ['light', 'black'] as const) {
    test.describe(`in ${theme === 'black' ? 'Black' : 'Light'}`, () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
            await watchFirstFrame(page);
        });

        test('a cold click from the series waits for the styles, and the first frame of the modal is styled', async ({ page }) => {
            const sheets = await holdLateSheets(page);
            await page.goto(`${origin()}/work/harbor`);
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            sheets.start();
            const clicked = Date.now();
            await entry(page, P[1]).click();
            await expect(dialog(page)).toBeVisible({ timeout: SHEET_DELAY + 10_000 });
            expect(sheets.arrivals.length, 'the open asked for a held stylesheet').toBeGreaterThan(0);
            expect(Math.max(...sheets.arrivals), 'and it arrived after the click, so the open had to wait').toBeGreaterThan(clicked);
            const first = await firstFrame(page);
            expect(first.earlyInDocument, 'the dialog never sat in the document before its styles').toBe(false);
            expect(first.look, "the first open frame has the settled modal's look").toEqual(await settledLook(page));
            expect(first.look?.display, 'not the user agent dialog').not.toBe('block');
        });

        test('a keyboard open waits the same way, focus moves in, and Escape brings it back to the entry', async ({ page }) => {
            const sheets = await holdLateSheets(page);
            await page.goto(`${origin()}/work/harbor`);
            await waitForHydration(page);
            sheets.start();
            await entry(page, P[1]).focus();
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL(`${origin()}${href(P[1])}`, { timeout: SHEET_DELAY + 10_000 });
            await expect(dialog(page)).toBeVisible({ timeout: SHEET_DELAY + 10_000 });
            await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
            const first = await firstFrame(page);
            expect(first.earlyInDocument).toBe(false);
            expect(first.look).toEqual(await settledLook(page));
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog')).toHaveCount(0);
            await expect(entry(page, P[1])).toBeFocused();
        });
    });
}

test('the series page links none of the Viewer\'s styles, and fetches them once idle, ahead of an open', async ({ page }) => {
    await watchFirstFrame(page);
    await page.goto(`${origin()}/work/harbor`);
    // The first load: the server's HTML links no stylesheet with the Viewer's root rule.
    const applies = () =>
        page.evaluate(() =>
            Array.from(document.styleSheets).some((sheet) => {
                try {
                    // --viewer-header is set on the Viewer's root rule alone.
                    return Array.from(sheet.cssRules).some((rule) => rule instanceof CSSStyleRule && rule.style.getPropertyValue('--viewer-header') !== '');
                } catch {
                    return false;
                }
            }),
        );
    const html = await (await page.request.get(`${origin()}/work/harbor`)).text();
    const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) => match[1]);
    const bodies = await Promise.all(linked.map(async (url) => (await page.request.get(new URL(url, origin()).toString())).text()));
    expect(bodies.some((css) => css.includes('--viewer-header')), "the first load carries none of the Viewer's rules").toBe(false);
    await waitForHydration(page);
    await expect.poll(applies, { message: 'the idle load brings them in', timeout: 10_000 }).toBe(true);
});
