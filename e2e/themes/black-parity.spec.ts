import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../../test/helpers/curatorSecrets';
import { HOME_OPENING, HOME_SERIES } from '../support/catalog-home';
import { createInboxFixture, openInboxItems, type InboxFixture } from '../support/curation-inbox';
import { publishHomeFixture } from '../support/homeFixture';
import { routePhotoFixtures } from '../support/test';
import { compare, failures, walk, type Allowance, type Comparison, type Walk } from './computed';

// Black is today's site, exactly (the owner's ruling, 2026-10-28). This loads the same page states from two builds, the
// base (PARITY_BASE_DIR: next before the themes) and the head, on the same fixtures, a dark device and reduced motion.
//
// The gate is computed style (the lead's ruling, 2026-10-29; spec §10; e2e/themes/computed.ts). The base doesn't render
// the same pixels twice: its own photographs, the intro's ripples and a focus ring's edge differ from one load to the
// next, so a pixel gate flakes on the base itself. What Black is made of can be compared exactly instead:
// 1. Tokens: every custom property the base resolves on :root and body must resolve the same in the head's Black. New
//    tokens are allowed, and listed.
// 2. Elements: every element under body (and in the curator's preview frame), matched by a path of tag and
//    nth-of-type, with its ::before, ::after, ::placeholder and ::marker: paint, backgrounds, borders and radii, type and
//    its decoration, crop, clipping and stacking, compositing, SVG paint, visibility and display, all exact (computed.ts
//    lists them), and its box exact, every delta logged, with one named allowance (the Inbox's KG ring at 390). A
//    missing or extra element fails, by path. The theme control and today's toggle are left out with their subtrees,
//    and the slot that holds only them is compared by style alone; the curator's head takes its control out of the
//    layout, as no JavaScript does, since the base's header had none. A wait that times out fails the row, so a head
//    that doesn't hydrate fails.
// At 1440 and 390, in all three of Black's routes: System on a dark device and today's stored `dark`, each against the
// base on its stored `dark`, and no JavaScript against the base without it.
// Self-tests inject a change into the head that must fail the gate: Home's scrim and --gah-ink 1/255 off, the glass
// blur at 13px, a photograph's opacity at .96 and its corners square, About's underlines red, a hovered nav link white.
//
// What the gate can't see is raster only: how the browser draws a blur, a resample or an antialiased edge. The pixel
// report covers that, as an artefact, not a gate: two passes over every shot at 1x and 2x, each in its own fresh load
// with its style in before first paint (chrome with every photograph taken out, or a checkerboard under glass; then
// the photographs alone), the base against itself beside the head against the base.
// The visitor pages, the 404 and the error page; the legacy Gallery and its lightbox; the curator signed out and in,
// and its 503.

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity');
/** For the pixel report: a photograph's own step up to 12/255 is invisible. The Inbox's 56 px thumbnails step up to
 * 9/255 against themselves in the base. */
const PHOTO_STEP = 12;
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
const SCALES = [1, 2] as const;
// Rows go to a file as they're measured: a failed test restarts the worker, which would drop rows held in memory.
// build.ts, the global setup, starts it empty.
const ROWS = path.join(OUT, 'black-parity.rows');
const record = (row: string) => fs.appendFileSync(ROWS, `${row}\n`);
const RECTS = path.join(OUT, 'black-parity.rects');

// One worker, in order, and soft checks, so one page's difference never skips the others.
// In CI a missing base is a broken job, not a skip: a skipped spec would leave the Themes job green.
if (!BASE && process.env.CI) throw new Error('PARITY_BASE_DIR is required in CI (the Themes job sets it).');
test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base; CI\'s Themes job does.');

// --- Servers -----------------------------------------------------------------------------------------------------

const pinned = (process.env.PARITY_PORTS ?? '').split(',').map(Number).filter(Boolean);

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

interface Server {
    origin: string;
    stop: () => Promise<void>;
}

/** `next start` from `tree`'s build on 127.0.0.1, with `env`, answering `status` on `ready`. */
async function serve(tree: string, port: number, env: Record<string, string>, ready: string, status = 200): Promise<Server> {
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURAT') && name !== 'SITE_URL'));
    const child: ChildProcess = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: tree,
        env: { ...kept, NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1', ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const kill = (signal: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, signal);
        } catch {
            // Gone already.
        }
    };
    process.once('exit', () => kill('SIGKILL'));
    const stop = () =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const force = setTimeout(() => kill('SIGKILL'), 5000);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            kill('SIGTERM');
        });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const got = await fetch(`${origin}${ready}`).then((response) => response.status, () => 0);
        if (got === status) return { origin, stop };
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await stop();
    throw new Error(`${tree} on ${port} never answered ${status} on ${ready}:\n${output}`);
}

// --- Shots and diffs ---------------------------------------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };
interface Shot {
    /** Pass 1: the page with every photograph taken out (opacity 0, so the layout stays), and slides without their images. */
    chrome: string;
    /** Pass 2: the photographs alone, every other layer painting nothing. */
    photo: string;
    /** Every theme control or toggle on the page, the curator's preview frame's included, in page pixels. */
    controls: Box[];
    /** Every photograph's box, the same way. */
    photos: Box[];
    /** Each photograph's compositing, from pass 2's load (D2). */
    styles: string[];
}
interface Pair {
    /** The page, as `name` in the table. */
    name: string;
    url: string;
    /** After the load: reveal Home's chrome, scroll to the sequence, open the lightbox, hover or focus a photograph. */
    act?: (page: Page) => Promise<void>;
    /** Home's intro, at its settled frame: under reduced motion the intro never plays, and the badge fades in where it lands. */
    intro?: boolean;
    /** A signed-in curator page. */
    session?: boolean;
    /** The legacy Gallery, on the e2e suite's photo fixtures. */
    photos?: boolean;
    /** A page the head adds the control to, where the base had no toggle (the curator's header): the head's shot
     * takes the control out of the layout, as no JavaScript does, so the rest must match. */
    addsControl?: boolean;
    /** A page that never hydrates (the 503). */
    bare?: boolean;
    /** Glass over the photographs (Home's SiteNav, the lightbox's chrome): pass 1 paints each photo as a checkerboard (D1). */
    glass?: boolean;
    /** CSS for the head's shots only: the self-test's deliberate change. */
    headStyle?: string;
    /** Selectors whose boxes go in the report's second table, unrounded, from every shot (the code review's H2.3). */
    measure?: string[];
}

let browser: Browser;

/** Pass 1's style: no photograph's pixels, and a slide's image off, so whatever is drawn over or around a photograph composites over the same ground in both builds. */
const NO_PHOTOS = 'img,picture,canvas,video{opacity:0!important}[class$="_slide"],[class*="_slide "]{background-image:none!important}';
/**
 * Pass 1 on a page with glass over its photographs (D1): each photo's box is the same fixed checkerboard in both
 * builds instead, so a blur or a saturate over it shows. The image keeps its box and draws only its background.
 */
const CHECKER = 'repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/8px 8px';
const CHECKERED_PHOTOS = `img,video{object-position:-100000px -100000px!important;background:${CHECKER}!important;opacity:1!important}picture,canvas{opacity:0!important}[class$="_slide"],[class*="_slide "]{background:${CHECKER}!important}`;
/**
 * Pass 2's style: nothing paints but the photographs. Every other layer stays in place, visible and focusable, so the
 * page's acts (a hover, a focus, the lightbox's Enter) work the same in both passes; it only paints nothing: no ink,
 * ground, rule, shadow, ring or glass. Filters stay, since a photo's own compositing is under test (D2).
 */
const ONLY_PHOTOS =
    'body *:not(img):not(video):not(canvas),body *::before,body *::after{color:transparent!important;-webkit-text-fill-color:transparent!important;' +
    'background:transparent!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important;' +
    'text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important;' +
    'backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';

type PassName = 'chrome' | 'photo';
interface PassShot {
    file: string;
    controls: Box[];
    photos: Box[];
    /** Each photograph's own opacity, filter and blend, and every ancestor's opacity and filter, in DOM order (D2). */
    styles: string[];
}

/**
 * One fresh load of `pair`, settled (D3): `css` (a pass's style, the head's own) is in from before first paint,
 * through an init script in every frame, never toggled on a live page. Then hydration, fonts, every image loaded and
 * decoded, and every finite animation done. `stored` is the theme in localStorage, or '' for none (System). Without
 * JavaScript nothing waits on the page's scripts, and an act that needs them does nothing, in both builds alike.
 */
async function open(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, css: string, { js = true, session }: { js?: boolean; session?: string } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: 'reduce', javaScriptEnabled: js });
    if (session) await context.addCookies(JSON.parse(session).map((cookie: { name: string; value: string }) => ({ ...cookie, url: origin })));
    await context.addInitScript(({ value, sheet }) => {
        try {
            if (value) localStorage.setItem('theme', value);
        } catch {
            // No storage.
        }
        if (!sheet) return;
        // An adopted sheet needs no <head>, so it's in before the parser writes one, and nothing the page does removes it.
        const style = new CSSStyleSheet();
        style.replaceSync(sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
    }, { value: stored, sheet: css });
    const page = await context.newPage();
    if (pair.photos) await routePhotoFixtures(page);
    // Every wait polls from here, so it works without JavaScript too (the page then runs none of our timers or
    // handlers), and every one that times out is named in `timedOut`: the gate fails a row on any, never passes it.
    const timedOut: string[] = [];
    const until = async (name: string, check: () => Promise<boolean>, ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (await check().catch(() => false)) return;
            await page.waitForTimeout(100);
        }
        timedOut.push(name);
    };
    await page.goto(`${origin}${pair.url}`, { waitUntil: pair.intro && js ? 'domcontentloaded' : 'load' });
    if (js && !pair.bare) await until('hydration', () => page.locator('html[data-hydrated]').count().then((n) => n > 0), 30_000);
    await until('fonts', () => page.evaluate(() => document.fonts.status === 'loaded'), 10_000);
    if (js && pair.url === '/') await until("Home's badge", () => page.locator('[data-home-badge][data-landed]:not([data-lingering])').count().then((n) => n > 0), 20_000);
    if (js) await pair.act?.(page);
    else await Promise.race([pair.act?.(page).catch(() => undefined), page.waitForTimeout(3000)]);
    // The page and the curator's preview frame: every image that's going to load has (a lazy one far out of view won't),
    // and its fonts are in. With JavaScript, every image is decoded too: loaded isn't painted, and a photo still
    // decoding can draw a row short.
    await until('images and fonts', () => page.evaluate(() => {
        const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap((frame) => (frame.contentDocument ? [frame.contentDocument] : []))];
        return docs.every((doc) => doc.fonts.status === 'loaded' && [...doc.images].every((image) => {
            if (image.complete) return true;
            const box = image.getBoundingClientRect();
            const view = doc.defaultView!;
            // Chrome loads a lazy image within 1,250 px of the viewport; one further out never loads, in either build.
            return image.loading === 'lazy' && (box.bottom < -1000 || box.top > view.innerHeight + 1000);
        }));
    }), 20_000);
    if (js) await until('image decode', () => page.evaluate(async () => {
        const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap((frame) => (frame.contentDocument ? [frame.contentDocument] : []))];
        await Promise.all(docs.flatMap((doc) => [...doc.images].filter((image) => image.complete).map((image) => image.decode().catch(() => undefined))));
        return true;
    }), 10_000);
    // Every finite animation and transition done (reduced motion fades Home's badge in once loading ends).
    await until('animations', () => page.evaluate(() => document.getAnimations().every((animation) => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY || animation.playState !== 'running')), 5000);
    await page.waitForTimeout(600);
    return { context, page, timedOut };
}

/** One pass's capture, from its own fresh load: the shot, the controls' and photographs' boxes, and the photos' compositing. */
async function load(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, pass: PassName, session?: string): Promise<PassShot> {
    const head = !tag.startsWith('base');
    const css = [
        pass === 'chrome' ? (pair.glass ? CHECKERED_PHOTOS : NO_PHOTOS) : ONLY_PHOTOS,
        pair.addsControl && head ? '[data-theme-control]{display:none!important}' : '',
        pair.headStyle && head ? pair.headStyle : '',
    ].join('');
    const { context, page } = await open(origin, stored, pair, viewport, scale, css, { session });
    // The control in the page and in any same-origin frame: today's toggle in the base, the theme control in the head.
    // Every photograph's box, unrounded. And each photograph's own compositing, with its ancestors'.
    const { controls, photos, styles } = await page.evaluate(() => {
        const boxes: { x: number; y: number; w: number; h: number }[] = [];
        const photoBoxes: typeof boxes = [];
        const compositing: string[] = [];
        const visit = (doc: Document, dx: number, dy: number) => {
            const view = doc.defaultView!;
            for (const el of doc.querySelectorAll('[data-theme-control], nav button, header button')) {
                if (!el.matches('[data-theme-control]') && !/^Switch to/.test((el.textContent ?? '').trim())) continue;
                const box = el.getBoundingClientRect();
                if (box.width === 0) continue;
                // Out to the whole pixels it touches: a box at x 16.5 also paints part of pixel 16 and of pixel 72.
                const [left, top] = [Math.floor(box.left + dx), Math.floor(box.top + dy)];
                boxes.push({ x: left, y: top, w: Math.ceil(box.right + dx) - left, h: Math.ceil(box.bottom + dy) - top });
            }
            for (const el of doc.querySelectorAll('img, picture, canvas, video, [class$="_slide"]:not([class*="yarl"]), [class*="_slide "]:not([class*="yarl"])')) {
                const box = el.getBoundingClientRect();
                if (box.width > 0) photoBoxes.push({ x: box.left + dx, y: box.top + dy, w: box.width, h: box.height });
            }
            for (const el of doc.querySelectorAll('img, picture, canvas, video')) {
                const own = view.getComputedStyle(el);
                const chain: string[] = [];
                for (let node = el.parentElement; node; node = node.parentElement) {
                    const style = view.getComputedStyle(node);
                    if (style.opacity !== '1' || style.filter !== 'none') chain.push(`${node.tagName.toLowerCase()} opacity ${style.opacity} filter ${style.filter}`);
                }
                compositing.push(`${el.tagName.toLowerCase()} ${(el as HTMLImageElement).alt ?? ''}: opacity ${own.opacity}, filter ${own.filter}, blend ${own.mixBlendMode}${chain.length ? `; ${chain.join('; ')}` : ''}`);
            }
            for (const frame of doc.querySelectorAll('iframe')) {
                const inner = frame.contentDocument;
                const at = frame.getBoundingClientRect();
                if (inner) visit(inner, dx + at.x + frame.clientLeft, dy + at.y + frame.clientTop);
            }
        };
        visit(document, window.scrollX, window.scrollY);
        return { controls: boxes, photos: photoBoxes, styles: compositing };
    });
    if (pass === 'chrome') {
        for (const selector of pair.measure ?? []) {
            const box = await page.locator(selector).first().evaluate((el) => {
                const r = el.getBoundingClientRect();
                return `${r.x} ${r.y} ${r.width} ${r.height}`;
            }).catch(() => 'absent');
            fs.appendFileSync(RECTS, `| ${pair.name} | ${viewport.width} ${scale}x | ${tag} | \`${selector}\` | ${box} |\n`);
        }
    }
    // Two frames, so what the last wait changed is painted.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const file = path.join(OUT, `${pair.name}-${viewport.width}-${scale}x-${tag}-${pass}.png`);
    await page.screenshot({ path: file, fullPage: pair.session === true && pair.url.includes('publish') });
    await context.close();
    return { file, controls, photos, styles };
}

async function shoot(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, session?: string): Promise<Shot> {
    const chrome = await load(origin, stored, pair, viewport, scale, tag, 'chrome', session);
    const photo = await load(origin, stored, pair, viewport, scale, tag, 'photo', session);
    // The controls from both loads: pass 2 hides them, but a mask from either covers both captures.
    return { chrome: chrome.file, photo: photo.file, controls: [...chrome.controls, ...photo.controls], photos: photo.photos, styles: photo.styles };
}

interface Diff {
    /** Pass 1: pixels differing anywhere outside the controls' boxes. Must be 0. */
    count: number;
    /** The largest channel step among them. */
    maxStep: number;
    /** Pass 2: the largest channel step inside the photographs' boxes. At most PHOTO_STEP. */
    photoStep: number;
    /** Where the chrome differs. */
    box: string;
    /** Photographs whose compositing differs between the two builds (D2): must be none. */
    styles: string[];
}

type Region = { x0: number; y0: number; x1: number; y1: number };

/** Two same-sized captures, raw. */
async function pixels(left: string, right: string) {
    const [a, b] = await Promise.all([left, right].map((file) => sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    return a.info.width === b.info.width && a.info.height === b.info.height ? { a, b, width: a.info.width, height: a.info.height } : null;
}

/** Pass 1 compares the whole frame exactly, but the controls' boxes (±2 CSS px); pass 2 only the photographs' boxes, by their largest step. */
async function diff(a: Shot, b: Shot, scale: number, name: string): Promise<Diff> {
    const device = (pad: number) => (box: Box): Region => ({ x0: (box.x - pad) * scale, y0: (box.y - pad) * scale, x1: (box.x + box.w + pad) * scale, y1: (box.y + box.h + pad) * scale });
    const masks = [...a.controls, ...b.controls].map(device(2));
    // A photograph's edge row or column, where it covers a pixel only in part, blends with whatever is under it, and
    // the resampler lands it up to 99/255 apart from one load to the next. Pass 1 holds that pixel's chrome exact;
    // pass 2 counts only the pixels a photograph covers whole, in to the whole pixels inside its box.
    const photos = [...a.photos, ...b.photos].map((box): Region => ({ x0: Math.ceil(box.x * scale), y0: Math.ceil(box.y * scale), x1: Math.floor((box.x + box.w) * scale), y1: Math.floor((box.y + box.h) * scale) }));
    const inside = (boxes: Region[], x: number, y: number) => boxes.some((m) => x >= m.x0 && x < m.x1 && y >= m.y0 && y < m.y1);
    const step = (left: Buffer, right: Buffer, i: number) => Math.max(Math.abs(left[i] - right[i]), Math.abs(left[i + 1] - right[i + 1]), Math.abs(left[i + 2] - right[i + 2]));

    const chrome = await pixels(a.chrome, b.chrome);
    const photo = await pixels(a.photo, b.photo);
    const styles = a.styles.length === b.styles.length ? a.styles.flatMap((line, index) => (line === b.styles[index] ? [] : [`${line} against ${b.styles[index]}`])) : [`${a.styles.length} photographs against ${b.styles.length}`];
    if (!chrome || !photo) return { count: Number.POSITIVE_INFINITY, maxStep: 255, photoStep: 255, box: 'the two captures differ in size', styles };

    let count = 0;
    let maxStep = 0;
    let x0 = chrome.width, y0 = chrome.height, x1 = -1, y1 = -1;
    const mark = new Uint8Array(chrome.width * chrome.height * 3);
    for (let y = 0; y < chrome.height; y++) {
        for (let x = 0; x < chrome.width; x++) {
            const i = (y * chrome.width + x) * 3;
            mark[i] = mark[i + 1] = mark[i + 2] = Math.round((chrome.a.data[i] + chrome.a.data[i + 1] + chrome.a.data[i + 2]) / 9);
            const d = step(chrome.a.data, chrome.b.data, i);
            if (d === 0 || inside(masks, x, y)) continue;
            count++;
            maxStep = Math.max(maxStep, d);
            mark[i] = 255;
            mark[i + 1] = mark[i + 2] = 0;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    if (count > 0) await sharp(Buffer.from(mark), { raw: { width: chrome.width, height: chrome.height, channels: 3 } }).png().toFile(path.join(OUT, `${name}-chrome-diff.png`));

    let photoStep = 0;
    for (let y = 0; y < photo.height; y++) {
        for (let x = 0; x < photo.width; x++) {
            if (!inside(photos, x, y) || inside(masks, x, y)) continue;
            photoStep = Math.max(photoStep, step(photo.a.data, photo.b.data, (y * photo.width + x) * 3));
        }
    }
    const css = (v: number) => Math.round(v / scale);
    return { count, maxStep, photoStep, box: count ? `x ${css(x0)} to ${css(x1)}, y ${css(y0)} to ${css(y1)}` : '', styles };
}

// --- Pages -------------------------------------------------------------------------------------------------------

const series = `/work/${HOME_SERIES.slug}`;
const revealChrome = async (page: Page) => {
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 40, height / 2 + 10);
};
/** Scrolls `target`'s top to 80 px under the viewport's, to a whole pixel, so both builds land on the same offset. */
const scrollToWhole = (target: Locator) =>
    target.evaluate((element) => window.scrollTo(0, Math.max(0, Math.round(element.getBoundingClientRect().top + window.scrollY) - 80)));
/** Focuses without the browser's own scroll, which picks its offset mid layout and can land a fraction apart. */
const focusInPlace = async (target: Locator) => {
    await target.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    // The ring draws only on :focus-visible: a shot without it would compare nothing.
    expect(await target.evaluate((element) => element.matches(':focus-visible')), 'the focused element shows its ring').toBe(true);
};
const toSequence = (page: Page) => scrollToWhole(page.getByRole('heading', { name: 'Sequence' }));

const VISITOR: Pair[] = [
    { name: 'home-intro', url: '/', intro: true, glass: true },
    { name: 'home-rest', url: '/', glass: true },
    { name: 'home-chrome', url: '/', act: revealChrome, glass: true },
    { name: 'work', url: '/work' },
    { name: 'series', url: series },
    { name: 'series-sequence', url: series, act: toSequence },
    {
        name: 'thumbnail-hover',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await page.locator('section[aria-labelledby="series-sequence"] ol li a').first().hover();
        },
    },
    {
        name: 'thumbnail-focus',
        url: series,
        act: async (page) => {
            await toSequence(page);
            // A key press first, so the focus that follows is :focus-visible, as a keyboard visitor's is.
            await page.keyboard.press('Tab');
            await focusInPlace(page.locator('section[aria-labelledby="series-sequence"] ol li a').first());
        },
    },
    { name: 'cover-hover', url: series, act: (page) => page.locator('main figure a').first().hover() },
    {
        name: 'cover-focus',
        url: series,
        act: async (page) => {
            await scrollToWhole(page.locator('main figure a').first());
            await page.keyboard.press('Tab');
            await focusInPlace(page.locator('main figure a').first());
        },
    },
    { name: 'viewer', url: `${series}/photo/${HOME_OPENING}` },
    { name: 'about', url: '/about' },
    { name: '404', url: '/no-such-page', measure: ['nav [class*="monogram"]', 'nav [class*="_end"]', '[data-theme-control], nav button'] },
];
const LEGACY: Pair[] = [
    { name: 'gallery', url: '/gallery', photos: true },
    {
        name: 'lightbox',
        url: '/gallery',
        photos: true,
        glass: true,
        act: async (page) => {
            // Enter, as a keyboard visitor opens it.
            await page.getByRole('button', { name: 'Photograph 1 of 12', exact: true }).focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('.yarl__portal_open')).toHaveCSS('opacity', '1');
            await expect.poll(() => page.locator('.yarl__portal').evaluate((root) => root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)).toBe(0);
        },
    },
];
const CURATOR: Pair[] = [
    { name: 'signin', url: '/curation/login', addsControl: true },
    {
        name: 'inbox',
        url: '/curation/inbox',
        session: true,
        addsControl: true,
        measure: ['header [class*="monogram"]', 'header [class*="wordmark"]', 'header [class*="headerEnd"]', 'header'],
    },
    { name: 'publish', url: '/curation/publish', session: true, addsControl: true },
];

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`. */
const row = (label: string, size: string, width: number, scale: number, d: Diff) =>
    record(`| ${label} | ${size} ${width} | ${scale}x | ${d.count} | ${d.maxStep} | ${d.photoStep} | ${d.styles.length} | ${d.box} |`);

// --- The gate: computed style ------------------------------------------------------------------------------------

const STYLE_ROWS = path.join(OUT, 'black-styles.rows');
const STYLE_DETAILS = path.join(OUT, 'black-styles.details');

/** A walk of `pair` in one build: every element's computed style and box, and the tokens, from a fresh settled load. */
/**
 * The gate's one named allowance over exact geometry (spec §10): the Inbox's KG ring at 390, whose sub-pixel cause is
 * still open. The curator PR (PR map item 5) owns CuratorHeader.tsx and brings it to 0; then this goes.
 */
const ALLOWANCES: Allowance[] = [
    { page: 'inbox', width: 390, selector: 'header [class*="monogram"]', maxDelta: 0.5, why: "the Inbox's KG ring at 390, its cause still open" },
];

interface Walked2 {
    walk: Walk;
    /** The waits that timed out on this load: any fails the row. */
    timedOut: string[];
}

/** A walk of `pair` in one build: every element's computed style and box, and the tokens, from a fresh settled load. */
async function styles(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, tag: string, { js = true, session }: { js?: boolean; session?: string } = {}): Promise<Walked2> {
    const head = !tag.startsWith('base');
    // The curator's head takes the control out of the layout, as no JavaScript does, since the base's header had none.
    const css = [pair.addsControl && head ? '[data-theme-control]{display:none!important}' : '', pair.headStyle && head ? pair.headStyle : ''].join('');
    const { context, page, timedOut } = await open(origin, stored, pair, viewport, 1, css, { js, session });
    try {
        const selectors = ALLOWANCES.filter((entry) => entry.page === pair.name && entry.width === viewport.width).map((entry) => entry.selector);
        return { walk: await walk(page, selectors), timedOut };
    } finally {
        await context.close();
    }
}

/** Records one comparison, its failing lines and every box delta, and returns the failing lines. */
function judge(label: string, width: number, c: Comparison, timedOut: string[] = []): string[] {
    const failing = [...failures(c), ...timedOut.map((wait) => `a wait timed out: ${wait}`)];
    fs.appendFileSync(STYLE_ROWS, `| ${label} | ${width} | ${c.structural.length} | ${c.styles.length} | ${c.tokens.length} | ${c.geometry.length} | ${c.deltas.length} | ${+c.largest.toFixed(3)} | ${timedOut.length ? timedOut.join(', ') : ''} | ${c.added.length} |\n`);
    const section = (title: string, lines: string[]) => (lines.length ? `\n#### ${title}\n\n${lines.map((line) => `- \`${line}\``).join('\n')}\n` : '');
    const details =
        section('Structure', c.structural) +
        section('Styles', c.styles) +
        section('Tokens', c.tokens) +
        section('Boxes over their allowance', c.geometry) +
        section('Every box delta', c.deltas) +
        section('Waits that timed out', timedOut) +
        section('Tokens new in the head', c.added);
    if (details) fs.appendFileSync(STYLE_DETAILS, `\n### ${label}, ${width}\n${details}`);
    return failing;
}

/**
 * The gate, at each size: Black in the head against the base, element by element, in all three of Black's routes.
 * System on a dark device and today's stored `dark` against the base on its stored `dark`; no JavaScript against the
 * base without it. A wait that times out in either build fails the row, and a head with JavaScript that doesn't
 * hydrate fails it too (its hydration wait is one of them).
 */
async function gate(pair: Pair, origins: { base: string; head: string }, cookies?: { base: string; head: string }) {
    // One throwaway load in each build first: a server derives some things on first ask (About's portrait LQIP), so
    // the first walk of a page could catch one build before it has them.
    for (const [origin, session] of [[origins.base, cookies?.base], [origins.head, cookies?.head]] as const) {
        await styles(origin, 'dark', pair, VIEWPORTS.desktop, 'warm-up', { session });
    }
    for (const [size, viewport] of Object.entries(VIEWPORTS)) {
        const base = await styles(origins.base, 'dark', pair, viewport, 'base', { session: cookies?.base });
        const baseNoJs = await styles(origins.base, '', pair, viewport, 'base', { js: false, session: cookies?.base });
        for (const [route, stored, js, against] of [
            ['System on a dark device', '', true, base],
            ['a stored `dark`', 'dark', true, base],
            ['no JavaScript', '', false, baseNoJs],
        ] as const) {
            const head = await styles(origins.head, stored, pair, viewport, 'head', { js, session: cookies?.head });
            const allowances = Object.fromEntries(
                ALLOWANCES.filter((entry) => entry.page === pair.name && entry.width === viewport.width && against.walk.resolved[entry.selector]).map((entry) => [against.walk.resolved[entry.selector], entry.maxDelta]),
            );
            const timedOut = [...against.timedOut.map((wait) => `${wait} (base)`), ...head.timedOut.map((wait) => `${wait} (head)`)];
            const failing = judge(`${pair.name}, ${route}`, viewport.width, compare(against.walk, head.walk, allowances), timedOut);
            expect.soft(failing, `${pair.name} at ${size} ${viewport.width}, ${route}: computed style against the base`).toEqual([]);
        }
    }
}

/**
 * The gate (`gate`, computed style), then the pixel report (both passes, at every size and scale): not a gate, since
 * the base doesn't render the same pixels twice, but recorded, with the base against itself, for what only pixels show.
 */
function parity(group: string, pairs: Pair[], origins: () => { base: string; head: string }, options: { legacy?: boolean; session?: () => { base: string; head: string } } = {}) {
    for (const pair of pairs) {
        test(`${group}: ${pair.name}`, async () => {
            const { base, head } = origins();
            const cookies = pair.session ? options.session!() : undefined;
            await gate(pair, { base, head }, cookies);
            for (const [size, viewport] of Object.entries(VIEWPORTS)) {
                for (const scale of SCALES) {
                    const name = `${pair.name}-${viewport.width}-${scale}x`;
                    const before = await shoot(base, 'dark', pair, viewport, scale, 'base', cookies?.base);
                    row(`${pair.name}, the base against itself`, size, viewport.width, scale, await diff(before, await shoot(base, 'dark', pair, viewport, scale, 'base-again', cookies?.base), scale, `${name}-base-against-itself`));
                    row(pair.name, size, viewport.width, scale, await diff(before, await shoot(head, 'black', pair, viewport, scale, 'head', cookies?.head), scale, name));
                    if (options.legacy && scale === 1) {
                        row(`${pair.name}, head on stored \`dark\``, size, viewport.width, 1, await diff(before, await shoot(head, 'dark', pair, viewport, scale, 'head-legacy-dark', cookies?.head), scale, `${name}-legacy-dark`));
                    }
                }
            }
        });
    }
}

/** The base checkout's commit, for the report. */
function baseCommit(): string {
    const head = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: BASE, encoding: 'utf8' });
    return head.status === 0 ? head.stdout.trim() : String(BASE);
}

// --- Fixtures and rounds -----------------------------------------------------------------------------------------

let temp = '';
let siteConfig = '';
let library = '';
let visitorRoot = '';
let inbox: InboxFixture | undefined;
let secrets: TestCuratorSecrets | undefined;
const port = async (index: number) => pinned[index] ?? (await freePort());

test.beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-parity-'));
    siteConfig = path.join(temp, 'site-config');
    library = path.join(temp, 'library');
    fs.mkdirSync(siteConfig);
    fs.mkdirSync(library);
    const written = spawnSync(process.execPath, [path.join(HEAD, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'e2e/support/write-site-config.ts', siteConfig], { cwd: HEAD, encoding: 'utf8' });
    if (written.status !== 0) throw new Error(`write-site-config failed: ${written.stderr}`);
    visitorRoot = path.join(temp, 'visitor');
    await publishHomeFixture(visitorRoot);
    browser = await chromium.launch();
});

test.afterAll(async () => {
    await browser?.close();
    await inbox?.cleanup();
    secrets?.cleanup();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    fs.writeFileSync(
        path.join(OUT, 'black-parity.md'),
        [
            '# Black against the base',
            '',
            `Base: \`${baseCommit()}\`.`,
            '',
            '## The gate: computed style',
            '',
            "Every element under body (and in the curator's preview frame), matched by tag and nth-of-type, its ::before and ::after, and the custom properties on :root and body, in the head's Black against the base, at 1440 and 390, in Black's three routes. The theme control and today's toggle are left out with their subtrees; the curator's head takes its control out of the layout, as no JavaScript does. Structure, styles, base tokens, any box that moved (beyond the one named allowance) and any wait that timed out fail; every box delta and the tokens new in the head are listed below.",
            '',
            '| Page, route | Width | Structure | Styles | Tokens | Boxes over allowance | Box deltas | Largest delta (px) | Waits timed out | New tokens |',
            '|---|---|---|---|---|---|---|---|---|---|',
            read(STYLE_ROWS).trimEnd(),
            '',
            read(STYLE_DETAILS) ? `## The gate's details\n${read(STYLE_DETAILS)}` : '',
            '',
            '## The pixel report (not a gate)',
            '',
            `Chrome (pass 1, every photograph taken out, or a checkerboard on a page with glass): pixels differing outside the theme controls' boxes. Photo (pass 2, only the photographs): the largest channel step inside their boxes; up to ${PHOTO_STEP} is invisible in a photograph. Compositing: photographs whose opacity, filter or blend (or an ancestor's) differ. The base against itself shows what the base doesn't repeat.`,
            '',
            '| Page | Viewport | Scale | Chrome pixels | Chrome max step | Photo max step | Compositing diffs | Where (chrome) |',
            '|---|---|---|---|---|---|---|---|',
            read(ROWS).trimEnd(),
            read(RECTS) ? `\n## Boxes, unrounded (x y width height, CSS px)\n\n| Page | Viewport | Shot | Selector | Box |\n|---|---|---|---|---|\n${read(RECTS)}` : '',
        ].join('\n'),
    );
});

test.describe('the visitor site and the legacy Gallery', () => {
    const servers: Server[] = [];
    let visitor = { base: '', head: '' };
    let legacy = { base: '', head: '' };

    test.beforeAll(async () => {
        const common = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig };
        const catalog = { ...common, PHOTOGRAPHY_DATA_DIR: visitorRoot };
        const [a, b, c, d] = [await port(0), await port(1), await port(2), await port(3)];
        const started = await Promise.all([serve(BASE!, a, catalog, '/api/ready'), serve(HEAD, b, catalog, '/api/ready'), serve(BASE!, c, common, '/'), serve(HEAD, d, common, '/')]);
        servers.push(...started);
        visitor = { base: started[0].origin, head: started[1].origin };
        legacy = { base: started[2].origin, head: started[3].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', VISITOR, () => visitor, { legacy: true });
    parity('legacy', LEGACY, () => legacy, { legacy: true });

    // Once, for the record (R2-P2-2): with the scrim on a layer of its own in both builds, does Home's old raster step
    // with its chrome show?
    test('diagnosis: Home with its chrome, with the scrim on its own layer', async () => {
        const pair: Pair = {
            name: 'home-chrome-will-change',
            url: '/',
            act: async (page) => {
                await page.addStyleTag({ content: '[class*=vignette]{will-change:transform}' });
                await revealChrome(page);
            },
        };
        const viewport = VIEWPORTS.desktop;
        const result = await diff(await shoot(visitor.base, 'dark', pair, viewport, 1, 'base'), await shoot(visitor.head, 'black', pair, viewport, 1, 'head'), 1, 'home-chrome-will-change');
        row('home-chrome, the scrim on its own layer (diagnosis)', 'desktop', 1440, 1, result);
        test.info().annotations.push({ type: 'diagnosis', description: `${result.count} pixels differ, max step ${result.maxStep}` });
    });

    // The gate sees what it claims to: each of these, injected into the head, must fail it. Recorded, and asserted.
    const hoverNavLink = (page: Page) => page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work', exact: true }).hover();
    for (const [name, url, headStyle, act] of [
        ["Home's scrim, +1 on one channel", '/', '[class*="vignette"]{background:linear-gradient(90deg,rgb(9 10 9/.9) 0%,rgb(9 10 9/.46) 38%,rgb(9 10 9/.08) 70%)!important}', revealChrome],
        ['the glass blur at 13px', '/work', ':root{--gah-glass-blur:13px!important}', undefined],
        ["a photograph's opacity at .96", '/work', 'main img{opacity:.96!important}', undefined],
        ['--gah-ink, +1 on one channel', '/work', ':root{--gah-ink:#f4f6f6!important}', undefined],
        // The radius is the frame's, the photo's material (spec §2), so the cover's frame on a series page.
        ["a photograph's corners square", series, '[class*="coverFrame"]{border-radius:0!important}', undefined],
        ["About's link underlines red", '/about', 'a{text-decoration-color:red!important}', undefined],
        ['a hovered nav link white', '/work', 'nav a:hover{color:#fff!important}', hoverNavLink],
    ] as const) {
        test(`self-test: ${name} in the head fails the gate`, async () => {
            const pair: Pair = { name: `self-test, ${name}`, url, headStyle, act };
            const viewport = VIEWPORTS.desktop;
            const [base, head] = [await styles(visitor.base, 'dark', pair, viewport, 'base'), await styles(visitor.head, 'black', pair, viewport, 'head')];
            const comparison = compare(base.walk, head.walk);
            judge(pair.name, viewport.width, comparison, [...base.timedOut, ...head.timedOut]);
            // Seen as the change itself, in a style or a token, on loads that settled.
            expect(comparison.styles.length + comparison.tokens.length, `${name}: the computed-style gate sees it`).toBeGreaterThan(0);
            expect([...base.timedOut, ...head.timedOut], `${name}: both loads settled`).toEqual([]);
        });
    }
});

test.describe('the curator and its 503', () => {
    const servers: Server[] = [];
    let curator = { base: '', head: '' };
    let broken = { base: '', head: '' };
    const cookies = { base: '', head: '' };

    test.beforeAll(async () => {
        inbox = await createInboxFixture();
        await openInboxItems(inbox);
        secrets = await makeCuratorSecrets();
        const [a, b, c, d] = [await port(0), await port(1), await port(2), await port(3)];
        const env = (listen: number, secretEnv: Record<string, string>) => ({
            PHOTOGRAPHY_LIBRARY_DIR: inbox!.library,
            PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig,
            PHOTOGRAPHY_DATA_DIR: inbox!.root,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(listen),
            ...secretEnv,
        });
        const missing = { CURATOR_PASSPHRASE_HASH_FILE: path.join(temp, 'no-such.hash'), CURATOR_SESSION_SECRET_FILE: path.join(temp, 'no-such.key') };
        const started = await Promise.all([
            serve(BASE!, a, env(a, secrets.env), '/curation/login'),
            serve(HEAD, b, env(b, secrets.env), '/curation/login'),
            serve(BASE!, c, env(c, missing), '/curation/login', 503),
            serve(HEAD, d, env(d, missing), '/curation/login', 503),
        ]);
        servers.push(...started);
        curator = { base: started[0].origin, head: started[1].origin };
        broken = { base: started[2].origin, head: started[3].origin };
        // One session per server, signed in through its own form, as the owner does.
        for (const which of ['base', 'head'] as const) {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(`${curator[which]}/curation/login`);
            await page.waitForSelector('html[data-hydrated]');
            await page.getByLabel('Passphrase').fill(secrets.passphrase);
            await page.getByRole('button', { name: 'Sign in' }).click();
            await page.waitForURL(`${curator[which]}/curation`);
            cookies[which] = JSON.stringify((await context.cookies()).map(({ name, value }) => ({ name, value })));
            await context.close();
        }
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('curator', CURATOR, () => curator, { legacy: true, session: () => cookies });
    parity('curator', [{ name: '503', url: '/curation/login', bare: true }], () => broken, { legacy: true });
});

test.describe('the error page', () => {
    const servers: Server[] = [];
    let failing = { base: '', head: '' };

    test.beforeAll(async () => {
        // A catalog whose active pointer is damaged: the site has cut over and can't read it, so a page throws and the
        // visitor gets app/error.tsx.
        const root = path.join(temp, 'damaged');
        fs.mkdirSync(path.join(root, 'catalog', 'active'), { recursive: true });
        fs.writeFileSync(path.join(root, 'catalog', 'active', 'v1.json'), 'not a pointer');
        const env = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig, PHOTOGRAPHY_DATA_DIR: root };
        const [a, b] = [await port(0), await port(1)];
        const started = await Promise.all([serve(BASE!, a, env, '/work', 500), serve(HEAD, b, env, '/work', 500)]);
        servers.push(...started);
        failing = { base: started[0].origin, head: started[1].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', [{ name: 'error', url: '/work', measure: ['nav [class*="monogram"]', 'nav [class*="_end"]', '[data-theme-control], nav button'] }], () => failing, { legacy: true });
});
