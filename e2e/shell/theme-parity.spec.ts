import type { Page } from '@playwright/test';
import { CATALOG_ORIGIN, HOME_OPENING, HOME_SERIES } from '../support/catalog-home';
import { expectHomeImmersive } from '../support/home';
import { waitForHydration } from '../support/hydration';
import { bottomRowEdges, navPaint, navPixels, near, rootGrounds, windowGround, type Rgb } from '../support/shellPaint';
import { expect, test } from '../support/test';

// #21: the shell looks the same under both themes. SiteNav's background, ink,
// and border, as computed and as painted, match between the dark and the
// light theme on every page that has it, at 1440 and 390. And the shell owns
// its ground: body paints it and html stays unpainted, so the window's own
// ground (what overscroll shows) is the page's: About's paper, the Viewer's
// ground, the Gallery After Hours ground elsewhere. The bottom row of a page
// scrolled to its end shows the page's own ground in both themes, never a
// light strip.
// The catalog-mode server serves the published Home fixture, so Work, the
// series, and the Viewer are real pages. The legacy Gallery, on the harness
// server, is the one page the theme repaints, below its nav.

test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440 and 390 viewports itself, on the desktop project.');
test.use({ baseURL: CATALOG_ORIGIN });

const LEGACY_ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT || '3100'}`;
const GAH_GROUND: Rgb = [8, 10, 9];
const PAPER: Rgb = [244, 236, 215];
const CC_GROUND: Rgb = [17, 21, 19];
const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;
/** html's computed background when nothing paints it, which leaves the canvas to body's. */
const UNPAINTED = 'rgba(0, 0, 0, 0)';

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

interface Route {
    name: string;
    path: string;
    /** Whether SiteNav renders here. The Viewer has none. */
    nav: boolean;
    /** The ground the body paints, and so the window's: the canvas past the page, and the bottom row. html paints none. */
    ground: Rgb;
    /**
     * What the bottom row's edges show: the page's own ground, within `tolerance`; the same pixels in both themes, where
     * the Viewer's chrome bar sits at the bottom; or nothing to check, since Home's stage is a photograph to the edge and
     * the legacy Gallery repaints with the theme.
     */
    bottom: 'ground' | 'same' | 'none';
    tolerance?: number;
}

const ROUTES: readonly Route[] = [
    { name: 'Home', path: '/', nav: true, ground: GAH_GROUND, bottom: 'none' },
    { name: 'Work', path: '/work', nav: true, ground: GAH_GROUND, bottom: 'ground' },
    { name: 'a series', path: `/work/${HOME_SERIES.slug}`, nav: true, ground: GAH_GROUND, bottom: 'ground' },
    // The Viewer paints its Chromatic Chapters ground on the body too, the same in both themes (#7).
    { name: 'the Viewer', path: `/work/${HOME_SERIES.slug}/photo/${HOME_OPENING}`, nav: false, ground: CC_GROUND, bottom: 'same' },
    // The paper's ribs darken it by under 5% at the edges.
    { name: 'About', path: '/about', nav: true, ground: PAPER, bottom: 'ground', tolerance: 10 },
    { name: 'the 404', path: '/does-not-exist', nav: true, ground: GAH_GROUND, bottom: 'ground' },
    { name: 'the legacy Gallery', path: `${LEGACY_ORIGIN}/gallery`, nav: true, ground: GAH_GROUND, bottom: 'none' },
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
        test(`${route.name} keeps the shell the same in both themes at ${viewport.width}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            // A first visit puts the origin in place, so localStorage can be set before the measured load.
            await page.goto(route.path);
            await openIn(page, route, 'dark');
            const dark = await read(page, route);
            await openIn(page, route, 'light');
            const light = await read(page, route);

            if (route.nav) {
                expect(light.paint?.styles, "SiteNav's computed background, ink, and border").toEqual(dark.paint?.styles);
                expect(light.paint?.ground, "SiteNav's ground over the page").toEqual(dark.paint?.ground);
                if (dark.pixels && light.pixels) {
                    expect(near(light.pixels, dark.pixels), `SiteNav as painted: ${light.pixels} in light, ${dark.pixels} in dark`).toBe(true);
                }
            } else {
                await expect(primary(page)).toHaveCount(0);
            }

            const ground = css(route.ground);
            for (const [theme, seen] of [['dark', dark], ['light', light]] as const) {
                // A painted html would keep About's paper and the Viewer's ground off the canvas.
                expect(seen.roots.html, `html's ground in the ${theme} theme`).toBe(UNPAINTED);
                // About's body is paper and the Viewer's its own ground, in both themes; every other body is the Gallery After Hours ground.
                expect(seen.roots.body, `body's ground in the ${theme} theme`).toBe(ground);
                expect(near(seen.window, route.ground), `the window's ground in the ${theme} theme: ${seen.window}, not ${route.ground}`).toBe(true);
            }

            if (route.bottom !== 'none') {
                for (const [theme, edges] of [['dark', dark.bottom], ['light', light.bottom]] as const) {
                    expect(edges, `the bottom row in the ${theme} theme`).not.toBeNull();
                    if (route.bottom === 'ground') {
                        const off = edges!.filter((pixel) => !near(pixel, route.ground, route.tolerance));
                        expect(off, `bottom-row edge pixels off the ground ${route.ground} in the ${theme} theme`).toEqual([]);
                    }
                }
                const differ = light.bottom!.filter((pixel, i) => !near(pixel, dark.bottom![i]));
                expect(differ, 'bottom-row edge pixels that change with the theme').toEqual([]);
            } else if (route.path === '/') {
                // Home's stage is the window, so nothing sits below it for a light strip to show through.
                expect(light.scroll.height).toBeLessThanOrEqual(light.scroll.viewport);
            }
        });
    }
}
