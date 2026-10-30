import type { Page } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// About in every theme, rendered (#126's Delta 1, M2'): the page's ground under the body too, the nav's bottom line,
// the portrait's frame ground and its caption, and the link boxes at rest and lit. aboutThemes.test.ts parses the
// tokens; this reads what the browser paints from them. Dark is today's paper About, which dark-parity pins against
// v1.2.0; it's read here too. Black draws no line (the OLED spec §3, C2-5): no hairline under the nav, and no box or
// resting glow round a link until it lights.

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440, 1024 and 390 viewports itself, on the desktop project.');

const FRAME = 'rgb(16, 19, 17)';
const NONE = 'rgba(0, 0, 0, 0)';
const ABOUT_THEMES = {
    dark: { paints: 'dark', ground: 'rgb(244, 236, 215)', frame: FRAME, lines: true },
    light: { paints: 'light', ground: 'rgb(235, 229, 217)', frame: FRAME, lines: true },
    bright: { paints: 'bright', ground: 'rgb(255, 255, 255)', frame: FRAME, lines: true },
    // Black: the screen's own black under the page and the print, and no line anywhere at rest.
    black: { paints: 'black', ground: 'rgb(0, 0, 0)', frame: 'rgb(0, 0, 0)', lines: false },
} as const;
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
] as const;

const tiles = (page: Page) => page.getByRole('navigation', { name: /^External profiles( and contact)?$/ }).locator('a[data-brand]');

/** What About paints, each colour as the browser computes it, and the caption's WCAG contrast on what it sits on. */
function paint(page: Page) {
    return page.evaluate(async () => {
        // The links' first light is an arrival pass; read them at rest, once it has settled.
        const passes = document.getAnimations().filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.closest('a[data-brand]'));
        await Promise.all(passes.map((animation) => animation.finished.catch(() => undefined)));
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 4).map(Number);
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
        const main = document.querySelector('main[data-surface="about"]')!;
        const nav = document.querySelector('nav[aria-label="Primary"]')!;
        const portrait = document.querySelector('[data-testid="about-portrait"]')!;
        const caption = portrait.querySelector('figcaption')!;
        const frame = rgb(getComputedStyle(portrait).backgroundColor).slice(0, 3);
        const band = flat(getComputedStyle(caption).backgroundColor, frame);
        const inks = [caption, ...caption.querySelectorAll('*')].map((element) => ratio(flat(getComputedStyle(element).color, band), band));
        // The nav's bottom line is its inset box-shadow; its colour is the shadow's first part.
        const navLine = getComputedStyle(nav).boxShadow.match(/rgba?\([^)]+\)/)?.[0] ?? 'none';
        return {
            ground: getComputedStyle(main).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            navLine,
            frame: getComputedStyle(portrait).backgroundColor,
            caption: Math.min(...inks),
            tiles: [...document.querySelectorAll('a[data-brand]')].map((tile) => ({
                brand: tile.getAttribute('data-brand'),
                edge: getComputedStyle(tile).borderTopColor,
                glow: getComputedStyle(tile.querySelector('span')!, '::before').opacity,
            })),
        };
    });
}

function expectAbout(seen: Awaited<ReturnType<typeof paint>>, want: (typeof ABOUT_THEMES)[keyof typeof ABOUT_THEMES]) {
    expect(seen.ground, "the page's ground").toBe(want.ground);
    expect(seen.body, "the body's ground under it").toBe(want.ground);
    expect(seen.frame, "the portrait's frame ground").toBe(want.frame);
    expect(seen.caption, 'the caption on what it sits on').toBeGreaterThanOrEqual(4.5);
    expect(seen.tiles.length, 'the link tiles').toBeGreaterThan(0);
    if (want.lines) {
        expect(seen.navLine, 'the line under the nav').not.toBe(NONE);
        for (const tile of seen.tiles) expect(tile.edge, `${tile.brand}: its box at rest`).not.toBe(NONE);
        return;
    }
    expect(seen.navLine, 'no line under the nav (C2-5)').toBe(NONE);
    for (const tile of seen.tiles) {
        expect(tile.edge, `${tile.brand}: no box at rest`).toBe(NONE);
        // The mark's light rests at 0, so the link's clip draws no ghost box (L2').
        expect(tile.glow, `${tile.brand}: no resting glow`).toBe('0');
    }
}

async function openAbout(page: Page, viewport: { width: number; height: number }, choice?: string) {
    await page.setViewportSize(viewport);
    if (choice) await page.addInitScript((value) => localStorage.setItem('theme', value), choice);
    await page.goto('/about');
    await waitForHydration(page);
    await expect(page.getByTestId('about-portrait')).toBeVisible();
}

for (const [choice, want] of Object.entries(ABOUT_THEMES)) {
    for (const viewport of VIEWPORTS) {
        test(`About in ${choice} at ${viewport.width}: its ground under the body, the frame and the caption, and ${want.lines ? 'its lines' : 'no line at rest'}`, async ({ page }) => {
            await openAbout(page, viewport, choice);
            await expect(page.locator('html')).toHaveAttribute('data-theme', want.paints);
            expectAbout(await paint(page), want);
            // Lit, each box is drawn in the brand's line, Black's too ("they light on hover").
            const first = tiles(page).first();
            await first.hover();
            await expect.poll(() => first.evaluate((tile) => getComputedStyle(tile).borderTopColor), 'a hovered box is drawn').not.toBe(NONE);
        });
    }
}

// System, with nothing stored: Light's About on a light device, and Dark's, today's paper, on a dark one.
for (const scheme of ['light', 'dark'] as const) {
    test(`About in System on a ${scheme} device, with nothing stored, is ${scheme === 'light' ? "Light's" : "Dark's, today's paper"}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openAbout(page, VIEWPORTS[0]);
        await expect(page.locator('html')).toHaveAttribute('data-theme-choice', 'system');
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expectAbout(await paint(page), ABOUT_THEMES[scheme]);
    });
}
