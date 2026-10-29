import type { Page } from '@playwright/test';
import { CATALOG_ORIGIN, HOME_OPENING, HOME_SERIES } from '../support/catalog-home';
import { expectHomeImmersive } from '../support/home';
import { waitForHydration } from '../support/hydration';
import { bottomRowEdges, navPaint, navPixels, near, rootGrounds, windowGround, type Rgb } from '../support/shellPaint';
import { expect, test } from '../support/test';

// Each theme paints its own ground, and the shell owns it: body paints it and
// html stays unpainted, so the window's own ground (what overscroll shows) is
// the page's, and the bottom row of a page scrolled to its end shows that
// ground, never a strip of another. Dark is today's site, so its grounds are
// v1.2.0's: the Gallery After Hours ground, About's approved paper, the
// Viewer's Chromatic Chapters ground. Light paints its paper on the shell,
// About (R2-P1-2) and the Viewer (R2-P1-1). (Before the five themes, #21
// pinned one look for both; Dark against v1.2.0 is e2e/themes/dark-parity.spec.ts.)
// The catalog-mode server serves the published Home fixture, so Work, the
// series, and the Viewer are real pages. The legacy Gallery is on the harness
// server.

test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440 and 390 viewports itself, on the desktop project.');
test.use({ baseURL: CATALOG_ORIGIN });

const LEGACY_ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT || '3100'}`;
const GAH_GROUND: Rgb = [8, 10, 9];
const PAPER: Rgb = [244, 236, 215];
const CC_GROUND: Rgb = [17, 21, 19];
/** Light's paper, on the shell and on About (R3-P2-1). */
const LIGHT_PAPER: Rgb = [235, 229, 217];
const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;
/** html's computed background when nothing paints it, which leaves the canvas to body's. */
const UNPAINTED = 'rgba(0, 0, 0, 0)';

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

interface Route {
    name: string;
    path: string;
    /** Whether SiteNav renders here. The Viewer has none. */
    nav: boolean;
    /** The ground the body paints in Dark, and so the window's: the canvas past the page, and the bottom row. html paints none. */
    ground: Rgb;
    /** The same in Light. */
    light: Rgb;
    /**
     * What the bottom row's edges show: the page's own ground, within `tolerance`; a row that is read but not pinned, where
     * the Viewer's chrome bar sits at the bottom; or nothing to check, since Home's stage is a photograph to the edge and
     * the legacy Gallery repaints with the theme.
     */
    bottom: 'ground' | 'same' | 'none';
    tolerance?: number;
}

const ROUTES: readonly Route[] = [
    { name: 'Home', path: '/', nav: true, ground: GAH_GROUND, light: LIGHT_PAPER, bottom: 'none' },
    { name: 'Work', path: '/work', nav: true, ground: GAH_GROUND, light: LIGHT_PAPER, bottom: 'ground' },
    { name: 'a series', path: `/work/${HOME_SERIES.slug}`, nav: true, ground: GAH_GROUND, light: LIGHT_PAPER, bottom: 'ground' },
    // The Viewer paints its own ground on the body too (#7): today's Chromatic Chapters in Black, Light's paper in Light.
    { name: 'the Viewer', path: `/work/${HOME_SERIES.slug}/photo/${HOME_OPENING}`, nav: false, ground: CC_GROUND, light: LIGHT_PAPER, bottom: 'same' },
    // The paper's ribs darken it by under 5% at the edges.
    // Light's About paper has no ribs, so it holds its ground exactly.
    { name: 'About', path: '/about', nav: true, ground: PAPER, light: LIGHT_PAPER, bottom: 'ground', tolerance: 10 },
    { name: 'the 404', path: '/does-not-exist', nav: true, ground: GAH_GROUND, light: LIGHT_PAPER, bottom: 'ground' },
    { name: 'the legacy Gallery', path: `${LEGACY_ORIGIN}/gallery`, nav: true, ground: GAH_GROUND, light: LIGHT_PAPER, bottom: 'none' },
];

const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
] as const;

async function openIn(page: Page, route: Route, theme: 'dark' | 'light') {
    await page.evaluate((value) => localStorage.setItem('theme', value), theme);
    await page.goto(route.path);
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    if (route.path === '/') await expectHomeImmersive(page);
    if (route.nav) await expect(primary(page)).toBeAttached();
}

/** Everything the checks compare, read in one theme. */
async function read(page: Page, route: Route) {
    const nav = route.nav ? primary(page) : null;
    // Home's nav sits over the photograph by design, so only its computed paint and composited ground count there.
    const pixels = nav && route.path !== '/' ? await navPixels(nav) : null;
    return {
        paint: nav ? await navPaint(nav) : null,
        pixels,
        roots: await rootGrounds(page),
        bottom: route.bottom === 'none' ? null : await bottomRowEdges(page),
        scroll: await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: window.innerHeight })),
        // Last, since it takes the page out of layout for the read.
        window: await windowGround(page),
    };
}

for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
        test(`${route.name} paints each theme's own ground at ${viewport.width}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            // A first visit puts the origin in place, so localStorage can be set before the measured load.
            await page.goto(route.path);
            for (const theme of ['dark', 'light'] as const) {
                await openIn(page, route, theme);
                const seen = await read(page, route);
                const ground = theme === 'dark' ? route.ground : route.light;
                if (!route.nav) await expect(primary(page)).toHaveCount(0);
                // A painted html would keep About's paper and the Viewer's ground off the canvas.
                expect(seen.roots.html, `html's ground in ${theme}`).toBe(UNPAINTED);
                expect(seen.roots.body, `body's ground in ${theme}`).toBe(css(ground));
                expect(near(seen.window, ground), `the window's ground in ${theme}: ${seen.window}, not ${ground}`).toBe(true);
                // SiteNav's own paint on the gallery surface: Light's glass and rule (Dark's is the parity gate's to pin).
                if (theme === 'light' && route.nav && route.path !== '/' && route.name !== 'About') {
                    const nav = await primary(page).evaluate((el) => {
                        const style = getComputedStyle(el);
                        return { background: style.backgroundColor, rule: style.boxShadow };
                    });
                    expect(nav.background, "SiteNav's glass in Light").toBe('rgba(235, 229, 217, 0.9)');
                    expect(nav.rule, "SiteNav's rule in Light").toBe('rgba(41, 35, 29, 0.14) 0px -1px 0px 0px inset');
                }
                if (route.bottom === 'ground') {
                    const off = seen.bottom!.filter((pixel) => !near(pixel, ground, route.tolerance));
                    expect(off, `bottom-row edge pixels off the ground ${ground} in ${theme}`).toEqual([]);
                } else if (route.bottom === 'same') {
                    expect(seen.bottom, `the bottom row in ${theme}`).not.toBeNull();
                } else if (route.path === '/') {
                    // Home's stage is the window, so nothing sits below it for a strip to show through.
                    expect(seen.scroll.height).toBeLessThanOrEqual(seen.scroll.viewport);
                }
            }
        });
    }
}
