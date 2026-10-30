import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ERROR_HEADING } from '../components/site/onlineStatus';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// The 404 and the error page in every theme (spec §5): the ground, ink and actions follow the theme, and each pair
// reads, every action's edge included. Dark's are dark-parity's to pin against v1.2.0; they're read here too.
// The error page comes from a server whose catalog pointer is damaged, so a page throws into app/error.tsx.

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440 and 390 viewports itself, on the desktop project.');

const THEMES = {
    dark: { paints: 'dark', ground: 'rgb(8, 10, 9)' },
    light: { paints: 'light', ground: 'rgb(235, 229, 217)' },
    bright: { paints: 'bright', ground: 'rgb(255, 255, 255)' },
} as const;
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
] as const;

/** The status page's paint, each colour as the browser computes it, and the WCAG contrast of each pair it shows. */
function paint(page: Page) {
    return page.getByRole('main').evaluate((main) => {
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 4).map(Number);
        // Some inks are translucent (Dark's ink soft), so each colour is flattened onto what it sits on.
        const flat = (color: string, under: number[]) => {
            const [r, g, b, a = 1] = rgb(color);
            return [r, g, b].map((channel, i) => channel * a + under[i] * (1 - a));
        };
        const luminance = (c: number[]) =>
            c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (a: number[], b: number[]) => {
            const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
            return +((x + 0.05) / (y + 0.05)).toFixed(2);
        };
        const ground = rgb(getComputedStyle(main).backgroundColor).slice(0, 3);
        const heading = main.querySelector('h1')!;
        const text = main.querySelector('p')!;
        const actions = ([...main.querySelectorAll('a, button')] as HTMLElement[]).map((action) => {
            const style = getComputedStyle(action);
            const fill = flat(style.backgroundColor, ground);
            return { name: action.textContent?.trim() ?? '', label: ratio(flat(style.color, fill), fill), edge: ratio(flat(style.borderTopColor, ground), ground) };
        });
        return {
            ground: getComputedStyle(main).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            heading: { text: heading.textContent?.trim() ?? '', ratio: ratio(flat(getComputedStyle(heading).color, ground), ground) },
            text: ratio(flat(getComputedStyle(text).color, ground), ground),
            actions,
        };
    });
}

/** The checks both pages share: the theme's ground under the page and the body, and every pair at its minimum. */
function expectReads(seen: Awaited<ReturnType<typeof paint>>, ground: string, actions: number) {
    expect(seen.ground, "the page's ground").toBe(ground);
    expect(seen.body, "the body's ground under it").toBe(ground);
    expect(seen.heading.ratio, 'the heading on the ground').toBeGreaterThanOrEqual(4.5);
    expect(seen.text, 'the text on the ground').toBeGreaterThanOrEqual(4.5);
    expect(seen.actions, 'every action').toHaveLength(actions);
    for (const action of seen.actions) {
        expect(action.label, `${action.name}: its label on its fill`).toBeGreaterThanOrEqual(4.5);
        expect(action.edge, `${action.name}: its edge on the ground`).toBeGreaterThanOrEqual(3);
    }
}

async function openIn(page: Page, url: string, choice: string, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    await page.addInitScript((value) => localStorage.setItem('theme', value), choice);
    const response = await page.goto(url);
    await waitForHydration(page);
    return response?.status();
}

for (const [choice, want] of Object.entries(THEMES)) {
    for (const viewport of VIEWPORTS) {
        test(`the 404 in ${choice} at ${viewport.width}: the theme's ground, and its heading, text and action read`, async ({ page }) => {
            expect(await openIn(page, '/does-not-exist', choice, viewport)).toBe(404);
            await expect(page.locator('html')).toHaveAttribute('data-theme', want.paints);
            await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
            expectReads(await paint(page), want.ground, 1);
        });
    }
}

test.describe('the error page', () => {
    let server: CatalogServer | undefined;
    let root = '';

    test.beforeAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        // A catalog whose active pointer is damaged: the site has cut over and can't read it.
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-themes-'));
        fs.mkdirSync(path.join(root, 'catalog', 'active'), { recursive: true });
        fs.writeFileSync(path.join(root, 'catalog', 'active', 'v1.json'), 'not a pointer');
        const base = Number(process.env.E2E_CATALOG_PORT);
        server = await startCatalogServer(root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined, { unavailable: true });
    });

    test.afterAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        await server?.stop();
        // Nothing is deleted on a machine with a Trash: the folder goes there. CI's runner is thrown away whole.
        const trash = path.join(os.homedir(), '.Trash');
        try {
            if (root && fs.existsSync(trash)) fs.renameSync(root, path.join(trash, `${path.basename(root)}-${Date.now()}`));
            else if (root && process.env.CI) fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // On another volume than the Trash (EXDEV): it stays where it is.
        }
    });

    for (const [choice, want] of Object.entries(THEMES)) {
        for (const viewport of VIEWPORTS) {
            test(`in ${choice} at ${viewport.width}: the theme's ground, and its heading, text and Try again read`, async ({ page }) => {
                if (!server) throw new Error('The failing server did not start');
                expect(await openIn(page, `${server.origin}/work`, choice, viewport)).toBe(500);
                await expect(page.locator('html')).toHaveAttribute('data-theme', want.paints);
                const seen = await paint(page);
                expect(seen.heading.text).toBe(ERROR_HEADING);
                // Try again, in the action's fill. (The root layout's own error page, global-error.tsx, adds a way home
                // edged in the strong rule. A browser test can't reach it.)
                expectReads(seen, want.ground, 1);
            });
        }
    }
});
