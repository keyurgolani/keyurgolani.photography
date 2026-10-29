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

// Black is today's site, exactly (the owner's ruling, 2026-10-28). This renders the same pages from two builds, the
// base (PARITY_BASE_DIR: next before the themes) with today's toggle's stored `dark` and the head with `black` stored,
// on the same fixtures, a dark device and reduced motion, and diffs every pixel. The theme controls' boxes are masked
// (the base's toggle, the head's control, ±2 px, in the page and in the curator's preview frame).
//
// The rule, in two passes over every shot (the lead's ruling after the code review's H4, 2026-10-29; spec §10). A mask
// must never hide chrome, so neither pass masks anything but the controls:
// 1. Chrome, exact. Both builds take every photograph out before the capture (`img`, `picture`, `canvas`, `video` at
//    opacity 0, which keeps the layout, and Home's slides without their images), then the whole frame is compared:
//    not one pixel may differ, on any page, at either size or scale. Home's nav, title, scrim, panel, badge and
//    controls, captions over a photo and letterboxing all composite over the same ground, so they're all held exact.
//    That's the claim: Black is today's tokens, type and layout.
// 2. Photographs, a tolerance. Both builds paint nothing but the photographs, and inside the photographs' boxes no
//    channel may step more than 12/255 (PHOTO_STEP), with no limit on how many pixels do. A photo is the same bytes in
//    both builds, so its raster isn't under test, and it doesn't repeat from one load to the next even in the base:
//    the Inbox's thumbnails step up to 9/255 against themselves. 12/255 is still invisible in a photograph.
// Home's intro is shot at its settled frame, held by reduced motion, under the same rule. A departure spec §10
// sanctions is excluded from the chrome pass at its one page, size and scale only (Pair.sanctioned): today that's the
// Inbox's KG ring edge at 390 and DPR 1. A self-test makes
// Home's scrim 1/255 off in the head and asserts the chrome pass fails.
// A second row per page and size pins the ruling on owner question 4: the head with today's stored `dark` paints Black.
// The curator's header gains the control where the base had none, so the head's curator shots take it out of the
// layout first, as no JavaScript does.
// At 1440x900 and 390x844, each at 1x and 2x. The visitor pages, the 404 and the error page; the legacy Gallery and its
// lightbox; the curator signed out and in, and its 503.

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity');
/** The largest step a photograph's own pixels may take, per channel: 12/255, still invisible in a photograph. The
 * Inbox's 56 px thumbnails step up to 9/255 against themselves in the base (the design check's P1), so 4 would flake. */
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
    /** Sanctioned departures (spec §10): boxes, in CSS pixels, masked at one width and scale only. */
    sanctioned?: { width: number; scale: number; box: Box }[];
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
 * One fresh load of `pair` for one pass (D3): the pass's style, and the head's own, are in from before first paint,
 * through an init script in every frame, never toggled on a live page. Then hydration, fonts, every image loaded and
 * decoded, every finite animation done, and two frames, before the shot.
 */
async function load(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, pass: PassName, session?: string): Promise<PassShot> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: 'reduce' });
    if (session) await context.addCookies(JSON.parse(session).map((cookie: { name: string; value: string }) => ({ ...cookie, url: origin })));
    const head = !tag.startsWith('base');
    const css = [
        pass === 'chrome' ? (pair.glass ? CHECKERED_PHOTOS : NO_PHOTOS) : ONLY_PHOTOS,
        pair.addsControl && head ? '[data-theme-control]{display:none!important}' : '',
        pair.headStyle && head ? pair.headStyle : '',
    ].join('');
    await context.addInitScript(({ value, sheet }) => {
        try {
            localStorage.setItem('theme', value);
        } catch {
            // No storage.
        }
        // An adopted sheet needs no <head>, so it's in before the parser writes one, and nothing the page does removes it.
        const style = new CSSStyleSheet();
        style.replaceSync(sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
    }, { value: stored, sheet: css });
    const page = await context.newPage();
    if (pair.photos) await routePhotoFixtures(page);
    await page.goto(`${origin}${pair.url}`, { waitUntil: pair.intro ? 'domcontentloaded' : 'load' });
    if (!pair.bare) await page.waitForSelector('html[data-hydrated]', { timeout: 30_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready);
    if (pair.url === '/') {
        await page.waitForSelector('[data-home-badge][data-landed]:not([data-lingering])', { timeout: 20_000 }).catch(() => undefined);
    }
    await pair.act?.(page);
    // The page and the curator's preview frame: every image loaded and decoded (loaded isn't painted: a photo still
    // decoding can draw a row short), and every font in.
    await page.evaluate(async () => {
        const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap((frame) => (frame.contentDocument ? [frame.contentDocument] : []))];
        for (const doc of docs) {
            const images = [...doc.images];
            await Promise.all(images.filter((image) => !image.complete).map((image) => new Promise((resolve) => {
                image.onload = image.onerror = resolve;
                setTimeout(resolve, 4000);
            })));
            await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
            await doc.fonts.ready;
        }
    });
    // Every finite animation and transition done (reduced motion fades Home's badge in once loading ends).
    await page.evaluate(() => Promise.race([
        Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY).map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]));
    await page.waitForTimeout(600);
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
    /** Pass 1 inside the sanctioned boxes (D4): how many pixels differ, and by how much at most. */
    sanctionedCount: number;
    sanctionedStep: number;
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
async function diff(a: Shot, b: Shot, scale: number, name: string, sanctioned: Box[] = []): Promise<Diff> {
    const device = (pad: number) => (box: Box): Region => ({ x0: (box.x - pad) * scale, y0: (box.y - pad) * scale, x1: (box.x + box.w + pad) * scale, y1: (box.y + box.h + pad) * scale });
    const masks = [...a.controls, ...b.controls].map(device(2));
    const allowed = sanctioned.map(device(0));
    // A photograph's edge row or column, where it covers a pixel only in part, blends with whatever is under it, and
    // the resampler lands it up to 99/255 apart from one load to the next. Pass 1 holds that pixel's chrome exact;
    // pass 2 counts only the pixels a photograph covers whole, in to the whole pixels inside its box.
    const photos = [...a.photos, ...b.photos].map((box): Region => ({ x0: Math.ceil(box.x * scale), y0: Math.ceil(box.y * scale), x1: Math.floor((box.x + box.w) * scale), y1: Math.floor((box.y + box.h) * scale) }));
    const inside = (boxes: Region[], x: number, y: number) => boxes.some((m) => x >= m.x0 && x < m.x1 && y >= m.y0 && y < m.y1);
    const step = (left: Buffer, right: Buffer, i: number) => Math.max(Math.abs(left[i] - right[i]), Math.abs(left[i + 1] - right[i + 1]), Math.abs(left[i + 2] - right[i + 2]));

    const chrome = await pixels(a.chrome, b.chrome);
    const photo = await pixels(a.photo, b.photo);
    const styles = a.styles.length === b.styles.length ? a.styles.flatMap((line, index) => (line === b.styles[index] ? [] : [`${line} against ${b.styles[index]}`])) : [`${a.styles.length} photographs against ${b.styles.length}`];
    if (!chrome || !photo) return { count: Number.POSITIVE_INFINITY, maxStep: 255, photoStep: 255, box: 'the two captures differ in size', sanctionedCount: 0, sanctionedStep: 0, styles };

    let count = 0;
    let maxStep = 0;
    let sanctionedCount = 0;
    let sanctionedStep = 0;
    let x0 = chrome.width, y0 = chrome.height, x1 = -1, y1 = -1;
    const mark = new Uint8Array(chrome.width * chrome.height * 3);
    for (let y = 0; y < chrome.height; y++) {
        for (let x = 0; x < chrome.width; x++) {
            const i = (y * chrome.width + x) * 3;
            mark[i] = mark[i + 1] = mark[i + 2] = Math.round((chrome.a.data[i] + chrome.a.data[i + 1] + chrome.a.data[i + 2]) / 9);
            const d = step(chrome.a.data, chrome.b.data, i);
            if (d === 0 || inside(masks, x, y)) continue;
            if (inside(allowed, x, y)) {
                sanctionedCount++;
                sanctionedStep = Math.max(sanctionedStep, d);
                continue;
            }
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
    return { count, maxStep, photoStep, box: count ? `x ${css(x0)} to ${css(x1)}, y ${css(y0)} to ${css(y1)}` : '', sanctionedCount, sanctionedStep, styles };
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
        // The one sanctioned departure (spec §10): at 390 and DPR 1, the KG ring's left edge is 1/255 on 18 px, with the
        // control out of the layout. The control's whole-pixel slot didn't clear it, so its cause is still open. The
        // curator PR (spec §13, PR map item 5) owns CuratorHeader.tsx: it brings the ring to 0 and drops this box.
        sanctioned: [{ width: 390, scale: 1, box: { x: 16, y: 22, w: 3, h: 12 } }],
    },
    { name: 'publish', url: '/curation/publish', session: true, addsControl: true },
];

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`. */
const row = (label: string, size: string, width: number, scale: number, d: Diff) =>
    record(`| ${label} | ${size} ${width} | ${scale}x | ${d.count} | ${d.maxStep} | ${d.photoStep} | ${d.styles.length} | ${d.sanctionedCount ? `${d.sanctionedCount} at ${d.sanctionedStep}` : ''} | ${d.box} |`);

/** The sanctioned departure's own bound (D4): spec §10's 18 px at 1/255, no more. */
const SANCTIONED = { count: 18, step: 1 };

function expectWithin(name: string, d: Diff) {
    expect.soft(d.count, `${name}: chrome pixels differing (${d.box})`).toBe(0);
    expect.soft(d.photoStep, `${name}: the largest step inside a photograph`).toBeLessThanOrEqual(PHOTO_STEP);
    expect.soft(d.styles, `${name}: each photograph's opacity, filter and blend, and its ancestors'`).toEqual([]);
    expect.soft(d.sanctionedCount, `${name}: pixels differing inside the sanctioned box`).toBeLessThanOrEqual(SANCTIONED.count);
    expect.soft(d.sanctionedStep, `${name}: the largest step inside the sanctioned box`).toBeLessThanOrEqual(SANCTIONED.step);
}

/**
 * Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on a stored `dark`.
 * The base is shot twice, and must match itself first (D3): 0 in pass 1, within PHOTO_STEP in pass 2. A gate whose base
 * can't repeat itself proves nothing about the head.
 */
function parity(group: string, pairs: Pair[], origins: () => { base: string; head: string }, options: { legacy?: boolean; session?: () => { base: string; head: string } } = {}) {
    for (const pair of pairs) {
        test(`${group}: ${pair.name}`, async () => {
            const { base, head } = origins();
            const cookies = pair.session ? options.session!() : undefined;
            for (const [size, viewport] of Object.entries(VIEWPORTS)) {
                for (const scale of SCALES) {
                    const name = `${pair.name}-${viewport.width}-${scale}x`;
                    const sanctioned = (pair.sanctioned ?? []).filter((entry) => entry.width === viewport.width && entry.scale === scale).map((entry) => entry.box);
                    const before = await shoot(base, 'dark', pair, viewport, scale, 'base', cookies?.base);
                    const self = await diff(before, await shoot(base, 'dark', pair, viewport, scale, 'base-again', cookies?.base), scale, `${name}-base-against-itself`);
                    row(`${pair.name}, the base against itself`, size, viewport.width, scale, self);
                    expectWithin(`${name}, the base against itself`, self);
                    const result = await diff(before, await shoot(head, 'black', pair, viewport, scale, 'head', cookies?.head), scale, name, sanctioned);
                    row(pair.name, size, viewport.width, scale, result);
                    expectWithin(name, result);
                    if (options.legacy && scale === 1) {
                        const legacy = await diff(before, await shoot(head, 'dark', pair, viewport, scale, 'head-legacy-dark', cookies?.head), scale, `${name}-legacy-dark`, sanctioned);
                        row(`${pair.name}, head on stored \`dark\``, size, viewport.width, 1, legacy);
                        expectWithin(`${name}, the head on a stored dark`, legacy);
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
    fs.writeFileSync(
        path.join(OUT, 'black-parity.md'),
        `# Black against the base, pixel for pixel\n\nBase: \`${baseCommit()}\`. Chrome (pass 1, every photograph taken out, or a checkerboard on a page with glass): pixels differing anywhere outside the theme controls' boxes, which must be 0. Photo (pass 2, only the photographs): the largest channel step inside their boxes, at most ${PHOTO_STEP}. Compositing: photographs whose opacity, filter or blend (or an ancestor's opacity or filter) differ, which must be none. Every page's base is checked against itself first. The curator's header gains the control, so its head shots take it out of the layout first.\n\n| Page | Viewport | Scale | Chrome pixels | Chrome max step | Photo max step | Compositing diffs | Sanctioned box | Where (chrome) |\n|---|---|---|---|---|---|---|---|---|\n${fs.existsSync(ROWS) ? fs.readFileSync(ROWS, 'utf8') : ''}${fs.existsSync(RECTS) ? `\n## Boxes, unrounded (x y width height, CSS px)\n\n| Page | Viewport | Shot | Selector | Box |\n|---|---|---|---|---|\n${fs.readFileSync(RECTS, 'utf8')}` : ''}`,
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

    // The chrome pass can see what it claims to (the code review's H4): a 1/255 change to Home's scrim, drawn over the
    // photograph, must fail it. Recorded, and asserted.
    test("self-test: a 1/255 change to Home's scrim fails the chrome pass", async () => {
        const pair: Pair = {
            name: 'self-test-scrim',
            url: '/',
            act: revealChrome,
            headStyle: '[class*="vignette"]{background:linear-gradient(90deg,rgb(9 11 10/.9) 0%,rgb(9 11 10/.46) 38%,rgb(9 11 10/.08) 70%)!important}',
        };
        const viewport = VIEWPORTS.desktop;
        const result = await diff(await shoot(visitor.base, 'dark', pair, viewport, 1, 'base'), await shoot(visitor.head, 'black', pair, viewport, 1, 'head'), 1, 'self-test-scrim');
        row("self-test: Home's scrim 1/255 off in the head (must differ)", 'desktop', 1440, 1, result);
        expect(result.count, 'the chrome pass sees a 1/255 change under the chrome, over the photograph').toBeGreaterThan(0);
    });

    // And it sees the glass over a photograph (D1): Home's nav is the one SiteNav over a photograph (the series pages'
    // nav scrolls away with the page), so with its chrome up, a 1 px change to the glass's blur over the checkerboard
    // must fail it.
    test('self-test: a 1 px change to the glass blur fails the chrome pass', async () => {
        const pair: Pair = {
            name: 'self-test-glass',
            url: '/',
            glass: true,
            act: revealChrome,
            headStyle: ':root{--gah-glass-blur:13px!important}',
        };
        const viewport = VIEWPORTS.desktop;
        const result = await diff(await shoot(visitor.base, 'dark', pair, viewport, 1, 'base'), await shoot(visitor.head, 'black', pair, viewport, 1, 'head'), 1, 'self-test-glass');
        row('self-test: the glass blur 13px in the head (must differ)', 'desktop', 1440, 1, result);
        expect(result.count, "the chrome pass sees the glass's blur over a photograph").toBeGreaterThan(0);
    });
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
