import type { Locator, Page } from '@playwright/test';
import { artist } from '../data/artist';
import { expectNoA11yViolations } from './support/a11y';
import { contrast, expectContrastOverImage, type Rgb } from './support/contrast';
import { expectFocusRingVisible, expectNotObscured } from './support/focus';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { expectTabOrderMatchesVisualOrder } from './support/keyboard';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';

// #11's checks on About's external links: layout at six widths, focus from
// either end, 200% text, long labels, contrast in both themes, the brand
// light and motion, requests, the #1 surface checks, and the server HTML.
// They iterate the enabled entries in data/artist.ts, so they hold whichever
// set ships.

const ENABLED = artist.destinations.filter((destination) => destination.enabled);
const WIDTHS = [
    [320, 640],
    [360, 740],
    [393, 659],
    [430, 932],
    [768, 1024],
    [1280, 800],
] as const;
/** Absorbs subpixel layout. */
const SLACK = 0.5;

const external = (page: Page) => page.getByRole('navigation', { name: /^External profiles( and contact)?$/ });
const links = (page: Page) => external(page).getByRole('link');
/** The span with the link's text. The mark's span holds only its svg. */
const labelOf = (link: Locator) => link.locator('span').filter({ hasText: /\S/ });
const toggle = (page: Page) => page.getByRole('button', { name: /^Switch to (light|dark) mode$/ });
const primaryLinks = (page: Page) => page.getByRole('navigation', { name: 'Primary' }).getByRole('link');
/** The site nav bar: every navigation landmark but the external links' own, which since #21 is SiteNav. */
const siteNav = (page: Page) => page.getByRole('navigation').and(page.locator(':not([aria-label^="External profiles"])'));
const chrome = (page: Page) => [toggle(page), siteNav(page)];
const portrait = (page: Page) => page.getByTestId('about-portrait');
const heading = (page: Page) => page.getByTestId('about-heading');

type Box = { left: number; top: number; right: number; bottom: number };

/** Each matched element's own border box, in viewport px. */
const boxes = (target: Locator) =>
    target.evaluateAll((elements) =>
        elements.map((el): Box => {
            const { left, top, right, bottom } = el.getBoundingClientRect();
            return { left, top, right, bottom };
        }),
    );
const intersects = (a: Box, b: Box) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK;
/** How far apart two boxes are on the axis that separates them most. Negative when they overlap. */
const separation = (a: Box, b: Box) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);

const viewportOf = (page: Page) =>
    page.evaluate(() => {
        const root = document.documentElement;
        return { width: root.clientWidth, height: root.clientHeight, scrollWidth: root.scrollWidth };
    });
const fullyInside = (box: Box, view: { width: number; height: number }) =>
    box.left >= -SLACK && box.top >= -SLACK && box.right <= view.width + SLACK && box.bottom <= view.height + SLACK;

/** Whether the element at the link's center is the link or inside it. */
const ownsItsCenter = (link: Locator) =>
    link.evaluate((el) => {
        const { left, top, width, height } = el.getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return hit !== null && el.contains(hit);
    });

const scrollToEnd = (page: Page) => page.evaluate(() => window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: 'instant' }));

async function openAbout(page: Page) {
    await page.goto('/about');
    await waitForHydration(page);
    await expect(links(page)).toHaveCount(ENABLED.length);
}

/** The ways the links break the layout rules where the page is scrolled now. */
async function layoutProblems(page: Page, at: string): Promise<string[]> {
    const problems: string[] = [];
    const view = await viewportOf(page);
    if (view.scrollWidth > view.width) problems.push(`${at}, the page scrolls sideways, ${view.scrollWidth} px wide in ${view.width}`);
    const [portraitBox] = await boxes(portrait(page));
    const [headingBox] = await boxes(heading(page));
    const linkBoxes = await boxes(links(page));
    linkBoxes.forEach((box, index) => {
        const name = ENABLED[index].label;
        if (box.left < -SLACK || box.right > view.width + SLACK) {
            problems.push(`${at}, ${name} runs past the side of the viewport, ${box.left.toFixed(1)} to ${box.right.toFixed(1)} of ${view.width}`);
        }
        if (intersects(box, portraitBox)) problems.push(`${at}, ${name} overlaps the portrait`);
        if (intersects(box, headingBox)) problems.push(`${at}, ${name} overlaps the heading`);
        linkBoxes.slice(index + 1).forEach((other, offset) => {
            const gap = separation(box, other);
            if (gap < 8 - SLACK) problems.push(`${at}, ${name} and ${ENABLED[index + 1 + offset].label} are ${gap.toFixed(1)} px apart`);
        });
    });
    return problems;
}

/** Labels whose text runs past their own box or their link's, or ends in an ellipsis. */
const clippedLabels = (page: Page) =>
    links(page).evaluateAll(
        (elements, slack) =>
            elements.flatMap((link) => {
                const label = Array.from(link.querySelectorAll('span')).find((span) => span.textContent?.trim());
                if (!label) return [`${link.textContent} has no label`];
                const text = label.textContent ?? '';
                const problems: string[] = [];
                if (label.scrollWidth > label.clientWidth + slack) problems.push(`${text} overflows its box`);
                const inner = label.getBoundingClientRect();
                const outer = link.getBoundingClientRect();
                if (inner.left < outer.left - slack || inner.right > outer.right + slack || inner.top < outer.top - slack || inner.bottom > outer.bottom + slack) {
                    problems.push(`${text} runs outside its link`);
                }
                for (const el of [link, label]) if (getComputedStyle(el).textOverflow === 'ellipsis') problems.push(`${text} ends in an ellipsis`);
                return problems;
            }),
        SLACK,
    );

/** How many lines the element's text takes. */
const lineCount = (target: Locator) =>
    target.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
    });

/** Index of the focused external link, or -1. */
const focusedLink = (page: Page) => links(page).evaluateAll((elements) => elements.findIndex((el) => el === document.activeElement));

/** The focused link sits fully on screen, owns its center, shows an unobscured ring, and clears the chrome. */
async function expectFocusedLinkClear(page: Page, index: number) {
    const link = links(page).nth(index);
    const name = ENABLED[index].label;
    const view = await viewportOf(page);
    const [box] = await boxes(link);
    expect(fullyInside(box, view), `${name} must sit fully inside the viewport while it has focus`).toBe(true);
    expect(await ownsItsCenter(link), `${name} must be the element at its own center`).toBe(true);
    for (const cover of [...(await boxes(toggle(page))), ...(await boxes(siteNav(page)))]) {
        expect(intersects(box, cover), `${name} must clear the theme toggle and SiteNav`).toBe(false);
    }
    await expectFocusRingVisible(link);
    await expectNotObscured(link, chrome(page));
}

/** Waits for the first light and any lit transition to finish. */
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));

/** What a link shows: its frame, its mark, the brand's light behind the mark, its underline, and its arrow. */
const litState = (link: Locator) =>
    link.evaluate((el) => {
        const mark = el.querySelector('svg[data-icon]')?.parentElement;
        const label = Array.from(el.querySelectorAll('span')).find((span) => span.textContent?.trim());
        const arrow = el.querySelector('svg:not([data-icon])');
        const frame = getComputedStyle(el);
        const line = label ? getComputedStyle(label) : null;
        return {
            frame: `${frame.borderTopColor} ${frame.backgroundColor}`,
            mark: mark ? getComputedStyle(mark).color : '',
            light: mark ? Number(getComputedStyle(mark, '::before').opacity) : 0,
            underline: line ? `${line.textDecorationColor} ${line.textDecorationThickness}` : '',
            arrow: arrow ? `${getComputedStyle(arrow).color} ${getComputedStyle(arrow).translate}` : '',
        };
    });

/**
 * What moves inside a link: transforms on any element or pseudo-element,
 * animations by name, and transitions longer than 0.01 ms. A translate of
 * zero, which the arrow has at rest, isn't movement.
 */
const motionOf = (link: Locator) =>
    link.evaluate((el) =>
        [el, ...Array.from(el.querySelectorAll('*'))].flatMap((node) =>
            [null, '::before', '::after'].flatMap((pseudo) => {
                const style = getComputedStyle(node, pseudo);
                if (pseudo && style.content === 'none') return [];
                const name = `${node.tagName.toLowerCase()}${pseudo ?? ''}`;
                const found: string[] = [];
                for (const property of ['transform', 'scale', 'rotate'] as const) {
                    if (style[property] !== 'none') found.push(`${name} has ${property} ${style[property]}`);
                }
                if (!/^(none|0px( 0px)?)$/.test(style.translate)) found.push(`${name} has translate ${style.translate}`);
                if (style.animationName !== 'none') found.push(`${name} animates ${style.animationName}`);
                for (const value of style.transitionDuration.split(',')) {
                    const text = value.trim();
                    const ms = text.endsWith('ms') ? parseFloat(text) : parseFloat(text) * 1000;
                    if (ms > 0.01) found.push(`${name} transitions for ${text}`);
                }
                return found;
            }),
        ),
    );

test.describe('the #1 checks', () => {
    test('About passes them, with the external links as its entries', async ({ page }) => {
        await openAbout(page);
        await checkSurface(page, { entries: links(page), controls: [toggle(page), primaryLinks(page)], chrome: chrome(page) });
    });

    for (const { label, href } of ENABLED) {
        test(`Enter on ${label} opens ${href} in the same tab`, async ({ page, context }) => {
            // The external host gets a stub, so the test never leaves the machine.
            await page.route(`${new URL(href).origin}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stub</title>' }));
            await openAbout(page);
            await external(page).getByRole('link', { name: label, exact: true }).focus();
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL(href);
            expect(context.pages()).toHaveLength(1);
        });
    }

    test('a fine pointer lights a link on hover, and a touch screen never does', async ({ page, isMobile }) => {
        await openAbout(page);
        await settled(page);
        const link = links(page).first();
        const atRest = await litState(link);
        await link.hover();
        await settled(page);
        if (isMobile) expect(await litState(link)).toEqual(atRest);
        else expect((await litState(link)).light).toBeGreaterThan(atRest.light);
    });
});

test.describe('on the desktop project', () => {
    test.skip(({ isMobile }) => isMobile, 'Each test sets its own size here. The #1 checks above run on both projects.');

    for (const [width, height] of WIDTHS) {
        test.describe(`at ${width} by ${height}`, () => {
            test.use({ viewport: { width, height } });

            test('each link shows once, in order, at 44 px or more with 8 px between, clear of the portrait, the heading, and each other', async ({ page }) => {
                await openAbout(page);
                await expect(links(page)).toHaveText(ENABLED.map((destination) => destination.label));
                for (const [index, link] of (await links(page).all()).entries()) {
                    await expect(link).toBeVisible();
                    await expect(link).toHaveAccessibleName(ENABLED[index].label);
                }
                await expectMinTargetSize(links(page), 44);

                const problems = await layoutProblems(page, 'at scroll top');
                const covers = await boxes(toggle(page));
                const [portraitBox] = await boxes(portrait(page));
                const [headingBox] = await boxes(heading(page));
                for (const cover of covers) {
                    if (intersects(portraitBox, cover)) problems.push('at scroll top, the portrait meets the theme toggle');
                    if (intersects(headingBox, cover)) problems.push('at scroll top, the heading meets the theme toggle');
                }
                await scrollToEnd(page);
                problems.push(...(await layoutProblems(page, 'at scroll end')));
                expect(problems).toEqual([]);
            });

            test('at scroll end the last link sits fully on screen, owns its center, and clears the chrome', async ({ page }) => {
                await openAbout(page);
                await scrollToEnd(page);
                const last = links(page).last();
                const [box] = await boxes(last);
                expect(fullyInside(box, await viewportOf(page)), 'The last link must sit fully inside the viewport').toBe(true);
                expect(await ownsItsCenter(last), 'The last link must be the element at its own center').toBe(true);
                for (const cover of [...(await boxes(toggle(page))), ...(await boxes(siteNav(page)))]) {
                    expect(intersects(box, cover), 'The last link must clear the theme toggle and SiteNav').toBe(false);
                }
            });

            test('Tab from the top and Shift+Tab from scroll end reach the links in order, each on screen and clear of the chrome', async ({ page }) => {
                await openAbout(page);
                const forward: number[] = [];
                // Through SiteNav first, then the list.
                for (let press = 0; press < 20 && forward.length < ENABLED.length; press++) {
                    await page.keyboard.press('Tab');
                    const index = await focusedLink(page);
                    if (index === -1) {
                        if (forward.length > 0) break;
                        continue;
                    }
                    forward.push(index);
                    await expectFocusedLinkClear(page, index);
                }
                expect(forward).toEqual(ENABLED.map((_, index) => index));

                await openAbout(page);
                await scrollToEnd(page);
                const back: number[] = [];
                for (let press = 0; press < ENABLED.length; press++) {
                    await page.keyboard.press('Shift+Tab');
                    const index = await focusedLink(page);
                    back.push(index);
                    if (index !== -1) await expectFocusedLinkClear(page, index);
                }
                expect(back).toEqual(ENABLED.map((_, index) => index).reverse());

                await expectTabOrderMatchesVisualOrder(page, links(page));
            });
        });
    }

    test.describe('at 320 by 640', () => {
        test.use({ viewport: { width: 320, height: 640 } });

        test('with 200% text the links reflow with no horizontal scroll, overlap, or clipped label', async ({ page }) => {
            await openAbout(page);
            await expectReflow(links(page));
            await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
            const problems = [...(await layoutProblems(page, 'at scroll top')), ...(await clippedLabels(page))];
            await scrollToEnd(page);
            problems.push(...(await layoutProblems(page, 'at scroll end')));
            expect(problems).toEqual([]);
        });

        test('a 60-character label and a 30-character unbroken token wrap with no clipping, ellipsis, or horizontal scroll', async ({ page }) => {
            await openAbout(page);
            // Synthetic, since the site has no localization.
            const long = 'Photographs from the road, the weather, and the people in it';
            const token = 'ISerialClickerPhotographsLinks';
            expect([long.length, token.length]).toEqual([60, 30]);
            const [first, second] = await links(page).all();
            await labelOf(first).evaluate((el, text) => {
                el.textContent = text;
            }, long);
            await labelOf(second).evaluate((el, text) => {
                el.textContent = text;
            }, token);
            expect(await lineCount(labelOf(first)), 'the long label wraps').toBeGreaterThan(1);
            expect(await lineCount(labelOf(second)), 'the unbroken token wraps').toBeGreaterThan(1);
            const problems = [...(await layoutProblems(page, 'with long labels')), ...(await clippedLabels(page))];
            expect(problems).toEqual([]);
        });
    });

    // Rows below 40rem and tiles above it put the light in different places, so both are measured.
    for (const [width, height] of [
        [393, 659],
        [1280, 800],
    ] as const) {
        test.describe(`at ${width} by ${height}`, () => {
            test.use({ viewport: { width, height } });

            for (const theme of ['dark', 'light'] as const) {
                test(`in the ${theme} theme the labels are underlined and keep 4.5:1 over the light at rest and lit by hover, focus, and a press, and the ring keeps 3:1 on the About ground`, async ({ page }) => {
                    await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
                    await openAbout(page);
                    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                    await settled(page);
                    await expectNoA11yViolations(page, { include: 'nav[aria-label^="External profiles"]' });

                    /** The link's ring and the About ground, and its label's text decoration. */
                    const colorsOf = (link: Locator) =>
                        link.evaluate((el) => {
                            const rgb = (color: string): [number, number, number] => {
                                const canvas = document.createElement('canvas');
                                canvas.width = canvas.height = 1;
                                const context = canvas.getContext('2d', { willReadFrequently: true });
                                if (!context) throw new Error('No 2D canvas to resolve a color');
                                context.fillStyle = color;
                                context.fillRect(0, 0, 1, 1);
                                const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
                                return [r, g, b];
                            };
                            const style = getComputedStyle(el);
                            const ground = style.getPropertyValue('--about-ground').trim();
                            const label = Array.from(el.querySelectorAll('span')).find((span) => span.textContent?.trim());
                            return {
                                ground: ground ? rgb(ground) : null,
                                outline: rgb(style.outlineColor),
                                decoration: label ? getComputedStyle(label).textDecorationLine : '',
                            };
                        });
                    /** The text against the real pixels behind it, the brand's light included. The underline sits below the text, so it's hidden for the reading. */
                    const expectLabelContrast = async (link: Locator) => {
                        const underline = await page.addStyleTag({ content: 'nav[aria-label^="External profiles"] span { text-decoration-color: transparent !important; transition: none !important; }' });
                        try {
                            await expectContrastOverImage(labelOf(link), { min: 4.5 });
                        } finally {
                            await underline.evaluate((node) => node.parentNode?.removeChild(node));
                        }
                    };
                    for (const [index, link] of (await links(page).all()).entries()) {
                        const name = ENABLED[index].label;
                        expect((await colorsOf(link)).decoration, `${name} is underlined at rest`).toContain('underline');
                        await expectLabelContrast(link);

                        await link.hover();
                        await settled(page);
                        expect((await litState(link)).light, `${name} is lit on hover`).toBeGreaterThan(0.5);
                        await expectLabelContrast(link);
                        await page.mouse.move(0, 0);

                        await link.focus();
                        await settled(page);
                        expect((await litState(link)).light, `${name} is lit on focus`).toBeGreaterThan(0.5);
                        await expectLabelContrast(link);
                        const focused = await colorsOf(link);
                        expect(focused.ground, '--about-ground is in scope').not.toBeNull();
                        expect(contrast(focused.outline, focused.ground as Rgb), `${name} ring contrast on the About ground`).toBeGreaterThanOrEqual(3);
                        await link.blur();

                        // A press, as a tap holds :active. The release mustn't navigate.
                        await link.evaluate((el) => el.addEventListener('click', (event) => event.preventDefault(), { once: true }));
                        await link.hover();
                        await page.mouse.down();
                        await settled(page);
                        expect((await litState(link)).light, `${name} is lit while pressed`).toBeGreaterThan(0.5);
                        await expectLabelContrast(link);
                        await page.mouse.up();
                        await page.mouse.move(0, 0);
                        await link.blur();
                        await settled(page);
                    }
                });
            }
        });
    }

    test('hover and focus light each link the same way, and it goes back to rest after', async ({ page }) => {
        await openAbout(page);
        await settled(page);
        for (const [index, link] of (await links(page).all()).entries()) {
            const name = ENABLED[index].label;
            const atRest = await litState(link);
            await link.hover();
            await settled(page);
            const hovered = await litState(link);
            await page.mouse.move(0, 0);
            await link.focus();
            await settled(page);
            const focused = await litState(link);
            await link.blur();
            await settled(page);
            expect(focused, `focus on ${name} shows what hover shows`).toEqual(hovered);
            expect(hovered.light, `${name}'s light rises`).toBeGreaterThan(atRest.light);
            for (const part of ['frame', 'mark', 'underline', 'arrow'] as const) expect(hovered[part], `${name}'s ${part} lights`).not.toEqual(atRest[part]);
            expect(await litState(link), `${name} goes back to rest`).toEqual(atRest);
        }
    });

    test('every hover rule on About waits for a fine pointer', async ({ page }) => {
        await openAbout(page);
        await expectHoverRulesGated(page);
    });

    test('under reduced motion nothing in a link moves, animates, or transitions, at rest, on hover, or on focus', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openAbout(page);
        for (const [index, link] of (await links(page).all()).entries()) {
            const name = ENABLED[index].label;
            expect(await motionOf(link), `${name} at rest`).toEqual([]);
            await link.hover();
            expect(await motionOf(link), `${name} on hover`).toEqual([]);
            await link.focus();
            expect(await motionOf(link), `${name} on focus`).toEqual([]);
            await page.mouse.move(0, 0);
        }
    });

    test('without reduced motion the first light passes once in order, only the arrow moves when lit, and no link moves or fades its ring', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await openAbout(page);
        const passes = await links(page).evaluateAll((elements) =>
            elements.map((el) => {
                const mark = el.querySelector('svg[data-icon]')?.parentElement;
                const style = mark ? getComputedStyle(mark, '::before') : null;
                return style ? { name: style.animationName, delay: parseFloat(style.animationDelay), count: style.animationIterationCount } : null;
            }),
        );
        for (const pass of passes) expect(pass).toMatchObject({ name: expect.stringMatching(/first-light/), count: '1' });
        const delays = passes.map((pass) => pass?.delay ?? 0);
        expect(delays, 'the light passes along the list in DOM order').toEqual([...delays].sort((a, b) => a - b));
        expect(new Set(delays).size, 'one link at a time').toBe(delays.length);

        await settled(page);
        /** The link's own movement and transitions, and its arrow's translate. */
        const moves = (link: Locator) =>
            link.evaluate((el) => {
                const style = getComputedStyle(el);
                const arrow = el.querySelector('svg:not([data-icon])');
                return {
                    link: [style.transform, style.translate, style.scale, style.rotate].filter((value) => value !== 'none'),
                    fades: style.transitionProperty.split(',').map((property) => property.trim()).filter((property) => /^(all|outline(-[a-z]+)?|box-shadow|opacity)$/.test(property)),
                    arrow: arrow ? getComputedStyle(arrow).translate : '',
                };
            });
        for (const [index, link] of (await links(page).all()).entries()) {
            const name = ENABLED[index].label;
            const atRest = await moves(link);
            expect(atRest, `${name} at rest`).toEqual({ link: [], fades: [], arrow: expect.stringMatching(/^(none|0px( 0px)?)$/) });
            await link.hover();
            await settled(page);
            expect(await moves(link), `${name} on hover`).toEqual({ link: [], fades: [], arrow: '2px -2px' });
            await page.mouse.move(0, 0);
            await link.focus();
            await settled(page);
            expect(await moves(link), `${name} on focus`).toEqual({ link: [], fades: [], arrow: '2px -2px' });
            await link.blur();
        }
    });

    for (const [width, height] of [[393, 659], [1280, 800]] as const) {
        test.describe(`at ${width} by ${height}`, () => {
            test.use({ viewport: { width, height } });

            test('the 500px wordmark renders wide enough to read, wider than the square marks', async ({ page }) => {
                test.skip(!ENABLED.some((destination) => destination.icon === '500px'), '500px is off.');
                await openAbout(page);
                // What's drawn, so the path's box, not the svg's.
                const marks = await external(page)
                    .locator('svg[data-icon]')
                    .evaluateAll((elements) =>
                        elements.map((el) => {
                            const { width: w, height: h } = el.querySelector('path')?.getBoundingClientRect() ?? { width: 0, height: 0 };
                            return { icon: el.getAttribute('data-icon'), width: w, height: h };
                        }),
                    );
                const wordmark = marks.find((mark) => mark.icon === '500px');
                expect(wordmark?.width ?? 0).toBeGreaterThanOrEqual(30);
                expect((wordmark?.width ?? 0) / (wordmark?.height ?? 1)).toBeGreaterThan(3);
                for (const mark of marks.filter(({ icon }) => icon !== '500px')) expect(wordmark?.width ?? 0, `wider than ${mark.icon}`).toBeGreaterThan(mark.width);
            });
        });
    }

    /** Moves the pointer corner to corner across the target, the way that starts ParallaxCard's tilt. */
    async function sweep(page: Page, target: Locator) {
        const box = await target.boundingBox();
        if (!box) throw new Error(`${target} isn't rendered`);
        await page.mouse.move(box.x + 4, box.y + 4);
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 12 });
    }
    /** Inline transforms on anything inside the target. */
    const inlineTransforms = (target: Locator) =>
        target.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('*'), (node) => node.style.transform).filter(Boolean));

    test('under reduced motion, a pointer across the portrait leaves it untilted', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openAbout(page);
        await sweep(page, portrait(page));
        expect(await inlineTransforms(portrait(page))).toEqual([]);
    });

    test('without reduced motion, the same sweep tilts the portrait, so the check above can fail', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await openAbout(page);
        await sweep(page, portrait(page));
        expect(await inlineTransforms(portrait(page))).not.toEqual([]);
    });

    test('loading /about requests nothing from another origin', async ({ page }) => {
        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        await openAbout(page);
        await page.waitForLoadState('networkidle');
        const origin = new URL(page.url()).origin;
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    });

    test('the cards and the corner source link are gone, Site source shows once inside the list, and nothing in main is pinned', async ({ page }) => {
        await openAbout(page);
        const repository = artist.destinations.find((destination) => destination.kind === 'repository');
        await expect(page.getByText('Site source', { exact: true })).toHaveCount(1);
        await expect(external(page).getByText('Site source', { exact: true })).toHaveCount(1);
        await expect(page.locator(`a[href="${repository?.href}"]`)).toHaveCount(1);
        await expect(page.getByRole('link', { name: /@iserialclicker|View source on GitHub|Visit Profile/ })).toHaveCount(0);
        const pinned = await page.locator('main').evaluate((main) =>
            [main, ...Array.from(main.querySelectorAll('*'))].filter((el) => /^(fixed|sticky)$/.test(getComputedStyle(el).position)).map((el) => el.tagName),
        );
        expect(pinned).toEqual([]);
    });

    test.describe('with JavaScript disabled', () => {
        test.use({ javaScriptEnabled: false });

        test('/about holds every enabled link', async ({ page }) => {
            await page.goto('/about');
            await expect(links(page)).toHaveText(ENABLED.map((destination) => destination.label));
            for (const [index, { href }] of ENABLED.entries()) await expect(links(page).nth(index)).toHaveAttribute('href', href);
        });
    });
});
