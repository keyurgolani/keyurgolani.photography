import type { Page } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// The 404 in every theme (spec §5): its ground, ink and actions follow the theme, and each pair reads. The error page
// is the same StatusPage, so this holds for it too; Black's is black-parity's to pin against v1.2.0.

test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440 and 390 viewports itself, on the desktop project.');

const THEMES = {
    black: { paints: 'black', ground: 'rgb(8, 10, 9)' },
    light: { paints: 'light', ground: 'rgb(235, 229, 217)' },
    bright: { paints: 'bright', ground: 'rgb(255, 255, 255)' },
    charcoal: { paints: 'dark', ground: 'rgb(27, 31, 29)' },
} as const;

/** The 404's paint, each colour as the browser computes it, and the WCAG contrast of each pair it shows. */
function paint(page: Page) {
    return page.getByRole('main').evaluate((main) => {
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 4).map(Number);
        // Every colour here is opaque but the rules, which sit on the ground.
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
        const ground = rgb(getComputedStyle(main).backgroundColor);
        const [primary] = [...main.querySelectorAll('a, button')] as HTMLElement[];
        const heading = main.querySelector('h1')!;
        const text = main.querySelector('p')!;
        const action = getComputedStyle(primary);
        const actionGround = rgb(action.backgroundColor);
        return {
            ground: getComputedStyle(main).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            heading: ratio(rgb(getComputedStyle(heading).color), ground),
            text: ratio(rgb(getComputedStyle(text).color), ground),
            action: ratio(rgb(action.color), actionGround),
            actionEdge: ratio(flat(action.borderTopColor, ground), ground),
        };
    });
}

for (const [choice, want] of Object.entries(THEMES)) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        test(`the 404 in ${choice} at ${viewport.width}: the theme's ground, and its heading, text and action read`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await page.addInitScript((value) => localStorage.setItem('theme', value), choice);
            const response = await page.goto('/does-not-exist');
            expect(response?.status()).toBe(404);
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', want.paints);
            await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
            const seen = await paint(page);
            expect(seen.ground, "the page's ground").toBe(want.ground);
            expect(seen.body, "the body's ground under it").toBe(want.ground);
            expect(seen.heading, 'the heading on the ground').toBeGreaterThanOrEqual(4.5);
            expect(seen.text, 'the text on the ground').toBeGreaterThanOrEqual(4.5);
            expect(seen.action, "the action's label on its fill").toBeGreaterThanOrEqual(4.5);
            expect(seen.actionEdge, "the action's edge on the ground").toBeGreaterThanOrEqual(3);
        });
    }
}
