import type { Locator, Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// The photo surround on Work and a series (spec §3, themes PR 3), in all four themes:
// - the sequence's window cut: one 4:3 slot per entry, the slot the mat, and the print inside it sized to its own
//   ratio with its own edge, for a landscape, a portrait and a square in one row (Black keeps today's letterbox);
// - the hover and focus mark, which keeps the surround and rings it from outside its room (R2-P3-2);
// - the focus ring, which clears each surround and stays inside the 16 px gutter at 390.
// Its own catalog, served from a second `next start`, on the desktop project; the phone sizes are set per test.

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Each test sets its own sizes, on the desktop project.');

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n + 101).padStart(12, '0')}`;
/** One row's worth: a landscape, a portrait, a square, and a landscape again. */
const SHAPES = [
    { width: 900, height: 600 },
    { width: 600, height: 900 },
    { width: 800, height: 800 },
    { width: 1200, height: 675 },
] as const;
const PHOTOS = SHAPES.map((shape, n) => ({ id: id(n), ...shape }));

const THEMES = ['black', 'light', 'bright', 'charcoal'] as const;
type Choice = (typeof THEMES)[number];
/** The window cut's fill and the print's own edge, per theme (styles/themes.css). Black has neither. */
const CUT: Record<Exclude<Choice, 'black'>, { mat: string; edge: string; room: number }> = {
    light: { mat: 'rgb(248, 245, 238)', edge: 'rgba(41, 35, 29, 0.12) 0px 0px 0px 1px', room: 7 },
    bright: { mat: 'rgb(255, 255, 255)', edge: 'none', room: 6 },
    charcoal: { mat: 'rgb(42, 47, 45)', edge: 'rgba(255, 255, 255, 0.14) 0px 0px 0px 1px', room: 6 },
};
/** Each theme's sm and md room, for the focus ring's offset: the room plus 2 px, at least 3 px. */
const ROOM: Record<Choice, { sm: number; md: number }> = { black: { sm: 0, md: 0 }, light: { sm: 7, md: 12 }, bright: { sm: 6, md: 12 }, charcoal: { sm: 6, md: 10 } };

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 33,
        withAssets: true,
        photos: PHOTOS,
        series: [{ id: 'ser_e2e-mixed', slug: 'mixed', title: 'Fixture mixed', photoIds: PHOTOS.map((photo) => photo.id), cover: { photoId: PHOTOS[0].id } }],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined);
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
const entry = (page: Page, n: number) => page.locator(`#photo-${PHOTOS[n].id}`);

async function open(page: Page, path: string, theme: Choice) {
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    await page.goto(`${origin()}${path}`);
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme-choice', theme);
    // Every print in, so its box is the image's own.
    await expect.poll(() => page.locator('main img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

/** The slot's and the print's boxes, and what paints them. */
function cut(target: Locator) {
    return target.evaluate((link) => {
        const slot = link.querySelector('[data-photo]') as HTMLElement;
        const print = slot.querySelector('img') as HTMLImageElement;
        const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        return { slot: box(slot), print: box(print), fill: getComputedStyle(slot).backgroundColor, edge: getComputedStyle(print).boxShadow, ratio: print.naturalWidth / print.naturalHeight };
    });
}

for (const theme of THEMES) {
    test(`in ${theme}, a landscape, a portrait and a square in one row each get the window the theme cuts`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '/work/mixed', theme);
        const tops = new Set<number>();
        for (const [n, shape] of SHAPES.entries()) {
            const seen = await cut(entry(page, n));
            tops.add(Math.round(seen.slot.y));
            // The slot is the 4:3 frame in every theme.
            expect(seen.slot.w / seen.slot.h, `entry ${n}'s slot`).toBeCloseTo(4 / 3, 2);
            if (theme === 'black') {
                // Today's letterbox: the image fills the slot and draws its own ratio inside it.
                expect(seen.print, `entry ${n}'s image fills its slot in Black`).toEqual(seen.slot);
                expect(seen.edge).toBe('none');
                continue;
            }
            const ratio = shape.width / shape.height;
            const { mat, edge } = CUT[theme];
            expect(seen.fill, `entry ${n}'s slot is the mat`).toBe(mat);
            expect(seen.edge, `entry ${n}'s print carries the theme's edge`).toBe(edge);
            // The print is its own shape, as large as the slot allows, and centred.
            expect(seen.print.w / seen.print.h, `entry ${n}'s print is ${shape.width}:${shape.height}`).toBeCloseTo(ratio, 1);
            expect(Math.max(seen.slot.w - seen.print.w, seen.slot.h - seen.print.h) < 0.5 || Math.min(seen.slot.w - seen.print.w, seen.slot.h - seen.print.h) < 0.5, `entry ${n}'s print meets two sides of its slot`).toBe(true);
            expect(Math.abs(seen.slot.x + seen.slot.w / 2 - (seen.print.x + seen.print.w / 2))).toBeLessThan(0.5);
            expect(Math.abs(seen.slot.y + seen.slot.h / 2 - (seen.print.y + seen.print.h / 2))).toBeLessThan(0.5);
        }
        expect(tops.size, 'the four entries share one row at 1440').toBe(1);
    });

    test(`in ${theme}, hover and focus keep the thumbnail's surround and ring it from outside its room`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '/work/mixed', theme);
        const slot = entry(page, 1).locator('[data-photo]');
        const rest = await slot.evaluate((el) => getComputedStyle(el).boxShadow);
        for (const act of ['hover', 'focus'] as const) {
            if (act === 'hover') await entry(page, 1).hover();
            else {
                await page.mouse.move(0, 0);
                await page.keyboard.press('Tab');
                await entry(page, 1).focus();
            }
            const marked = await slot.evaluate((el) => {
                const style = getComputedStyle(el);
                return { shadow: style.boxShadow, outline: `${style.outlineStyle} ${style.outlineWidth}`, offset: style.outlineOffset };
            });
            if (theme === 'black') {
                // Today's 1 px ring on the frame's edge, and no outline.
                expect(marked.shadow, `${act} in Black`).toMatch(/0px 0px 0px 1px$/);
                expect(marked.outline.split(' ')[0]).toBe('none');
            } else {
                expect(marked.shadow, `${act} keeps the surround`).toBe(rest);
                expect(marked.outline, `${act} rings it`).toBe('solid 1px');
                expect(marked.offset, `${act} rings it outside its ${ROOM[theme].sm} px room`).toBe(`${ROOM[theme].sm}px`);
            }
        }
    });

    test(`in ${theme}, at 390 the focus ring clears each surround and stays inside the gutter`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        for (const [path, target, room] of [
            ['/work', (p: Page) => p.getByRole('main').locator('ul > li > a').first(), ROOM[theme].sm],
            ['/work/mixed', (p: Page) => p.locator('#series-cover'), ROOM[theme].sm],
            ['/work/mixed', (p: Page) => entry(p, 0), ROOM[theme].sm],
        ] as const) {
            await open(page, path, theme);
            const link = target(page);
            await link.evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await page.keyboard.press('Tab');
            await link.focus();
            await expect(link).toBeFocused();
            const ring = await link.evaluate((el) => {
                const style = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth), left: r.left, right: r.right, viewport: document.documentElement.clientWidth };
            });
            // Phones step every surround down to sm: the ring clears it by 2 px, at least today's 3 px.
            expect(ring.offset, `${path}: the ring's offset`).toBe(Math.max(3, room + 2));
            expect(ring.left - ring.offset - ring.width, `${path}: the ring's left edge on screen`).toBeGreaterThanOrEqual(0);
            expect(ring.right + ring.offset + ring.width, `${path}: the ring's right edge on screen`).toBeLessThanOrEqual(ring.viewport);
        }
    });
}
