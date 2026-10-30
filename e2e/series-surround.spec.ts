import type { Locator, Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// The photo surround on Work and a series (spec §3, themes PR 3), in Dark, Light and Bright (Black with its layer):
// - the sequence's window cut: one 4:3 slot per entry, the slot the mat, and the print inside it sized to its own
//   ratio with its own edge, for a landscape, a portrait and a square in one row (Dark keeps today's letterbox);
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

const THEMES = ['dark', 'light', 'bright'] as const;
type Choice = (typeof THEMES)[number];
/** The window cut's fill and the print's own edge, per theme (styles/themes.css). Dark, today's, has neither. */
const CUT: Record<Exclude<Choice, 'dark'>, { mat: string; edge: string; room: number }> = {
    light: { mat: 'rgb(248, 245, 238)', edge: 'rgba(41, 35, 29, 0.12) 0px 0px 0px 1px', room: 7 },
    bright: { mat: 'rgb(255, 255, 255)', edge: 'none', room: 6 },
};
/** Each theme's sm and md room, for the focus ring's offset: the room plus 2 px, at least 3 px. */
/** The phone's gutter, --site-gutter at 390. */
const GUTTER = 16;
const ROOM: Record<Choice, { sm: number; md: number }> = { dark: { sm: 0, md: 0 }, light: { sm: 7, md: 12 }, bright: { sm: 6, md: 12 } };

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
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        test(`in ${theme} at ${viewport.width}, a landscape, a portrait and a square each get the window the theme cuts`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await open(page, '/work/mixed', theme);
            const seen = [];
            for (const n of SHAPES.keys()) seen.push(await cut(entry(page, n)));
            for (const [n, shape] of SHAPES.entries()) {
                const { slot, print, fill, edge, ratio } = seen[n];
                // The slot is the 4:3 frame in every theme, and the image is the photograph's own shape, pixels and all
                // (to a tenth: a small variant rounds its height to whole pixels, 1200:675 at 400 wide is 400:224).
                expect(slot.w / slot.h, `entry ${n}'s slot`).toBeCloseTo(4 / 3, 2);
                expect(ratio, `entry ${n}'s image is ${shape.width}:${shape.height}`).toBeCloseTo(shape.width / shape.height, 1);
                if (theme === 'dark') {
                    // Today's letterbox: the image fills the slot and draws its own ratio inside it.
                    expect(print, `entry ${n}'s image fills its slot in Dark`).toEqual(slot);
                    expect(edge).toBe('none');
                    continue;
                }
                expect(fill, `entry ${n}'s slot is the mat`).toBe(CUT[theme].mat);
                expect(edge, `entry ${n}'s print carries the theme's edge`).toBe(CUT[theme].edge);
                // The print is the image's shape, as large as the slot allows, and centred.
                expect(print.w / print.h, `entry ${n}'s print`).toBeCloseTo(ratio, 1);
                expect(Math.min(slot.w - print.w, slot.h - print.h), `entry ${n}'s print meets two sides of its slot`).toBeLessThan(0.5);
                expect(Math.abs(slot.x + slot.w / 2 - (print.x + print.w / 2))).toBeLessThan(0.5);
                expect(Math.abs(slot.y + slot.h / 2 - (print.y + print.h / 2))).toBeLessThan(0.5);
            }
            // Neighbours in a row keep today's gap plus both their surrounds between their slots.
            const [first, second] = seen;
            if (Math.round(first.slot.y) === Math.round(second.slot.y)) {
                // Today's column gap, clamp(0.75rem, 2vw, 1.25rem).
                const today = Math.min(20, Math.max(12, viewport.width * 0.02));
                expect(second.slot.x - (first.slot.x + first.slot.w), 'the gap between two slots in a row').toBeGreaterThanOrEqual(2 * (theme === 'dark' ? 0 : CUT[theme].room) + today - 0.01);
            }
        });
    }

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
            if (theme === 'dark') {
                // Today's 1 px ring on the frame's edge, and no outline.
                expect(marked.shadow, `${act} in Dark`).toMatch(/0px 0px 0px 1px$/);
                expect(marked.outline.split(' ')[0]).toBe('none');
            } else {
                expect(marked.shadow, `${act} keeps the surround`).toBe(rest);
                expect(marked.outline, `${act} rings it`).toBe('solid 1px');
                expect(marked.offset, `${act} rings it outside its ${ROOM[theme].sm} px room`).toBe(`${ROOM[theme].sm}px`);
            }
        }
    });

    test(`in ${theme}, a missing thumbnail keeps its edge and wears no surround`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // The portrait's image answers 404, so its entry shows the missing-image box.
        await page.route(`**/media/${PHOTOS[1].id}/**`, (route) => route.fulfill({ status: 404, body: '' }));
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await page.goto(`${origin()}/work/mixed`);
        await waitForHydration(page);
        const slot = entry(page, 1).locator('[data-photo]');
        await expect(slot).toHaveAttribute('data-photo', 'unavailable');
        // The theme's --gah-rule, resolved to the browser's colour form through a probe, as the shadow reports it.
        const rule = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--gah-rule)';
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        });
        const shadow = await slot.evaluate((el) => getComputedStyle(el).boxShadow);
        // One inset 1 px line in the theme's rule, and nothing else: today's edge, in every theme.
        expect(shadow, 'the missing box draws only its edge, in the theme\'s rule').toBe(`${rule} 0px 0px 0px 1px inset`);
        await entry(page, 1).hover();
        expect(await slot.evaluate((el) => getComputedStyle(el).outlineStyle), 'hover adds no outline round a box with no surround').toBe('none');
    });

    test(`in ${theme}, a missing cover keeps its edge, and hover and focus mark it with today's 1 px ring`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // The cover's image answers 404, so the cover shows the missing-image box (#124's review, D1).
        await page.route(`**/media/${PHOTOS[0].id}/**`, (route) => route.fulfill({ status: 404, body: '' }));
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await page.goto(`${origin()}/work/mixed`);
        await waitForHydration(page);
        const link = page.locator('main figure a').first();
        const frame = link.locator('[data-photo]');
        await expect(frame).toHaveAttribute('data-photo', 'unavailable');
        expect(await frame.evaluate((el) => getComputedStyle(el).boxShadow), 'the missing cover draws only its edge').toMatch(/^rgba?\([^)]*\) 0px 0px 0px 1px inset$/);
        for (const act of ['hover', 'focus'] as const) {
            if (act === 'hover') await link.hover();
            else {
                await page.mouse.move(0, 0);
                await page.keyboard.press('Tab');
                await link.focus();
                expect(await link.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
            }
            const marked = await frame.evaluate((el) => {
                const style = getComputedStyle(el);
                return { shadow: style.boxShadow, outline: style.outlineStyle };
            });
            expect(marked.shadow, `${act} is today's ring, with no mat`).toMatch(/^rgba?\([^)]*\) 0px 0px 0px 1px$/);
            expect(marked.outline, `${act} adds no outline round a box with no surround`).toBe('none');
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
            // Phones step every surround down to sm: the ring clears it by 2 px, at least today's 3 px, and never comes
            // closer than 1 px to the screen's edge, so offset and width stay within the 16 px gutter less 1.
            expect(ring.offset, `${path}: the ring's offset`).toBe(Math.min(Math.max(3, room + 2), GUTTER - 3 - 1));
            expect(ring.left - ring.offset - ring.width, `${path}: the ring's left edge inside the gutter`).toBeGreaterThanOrEqual(1);
            expect(ring.viewport - (ring.right + ring.offset + ring.width), `${path}: the ring's right edge inside the gutter`).toBeGreaterThanOrEqual(1);
        }
    });

    test(`in ${theme}, at 390 a surround thicker than the gutter allows clamps the ring to it`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page, '/work', theme);
        // A room no theme has: the clamp, gutter less ring less 1, has to take over.
        await page.addStyleTag({ content: '[data-ring-room]{--ring-room:20px}' });
        const link = page.getByRole('main').locator('ul > li > a').first();
        await page.keyboard.press('Tab');
        await link.focus();
        const ring = await link.evaluate((el) => {
            const style = getComputedStyle(el);
            return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth), left: el.getBoundingClientRect().left };
        });
        expect(ring.offset, 'the clamped offset').toBe(GUTTER - 3 - 1);
        expect(ring.left - ring.offset - ring.width, "the ring's left edge inside the gutter").toBeGreaterThanOrEqual(1);
    });
}
